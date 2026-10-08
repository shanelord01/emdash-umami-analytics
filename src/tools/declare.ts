/**
 * The MCP tool declarations.
 *
 * Only `src/plugin.ts` references `mcpTools()`, from its `mcp` property,
 * which the plugin build strips from the runtime: these schemas end up in
 * the manifest as JSON Schema, and neither zod nor this module ships in
 * the bundle. Keep it that way. A schema used by a route handler would
 * pull zod into every sandboxed invocation.
 *
 * Output schemas become strict JSON Schema (`additionalProperties: false`)
 * that the MCP server checks every answer against, so each one has to
 * match its loader's result type in `./load.ts` exactly, optional keys
 * included. `tests/tools.test.ts` holds each loader's output against the
 * schema the build wrote.
 */

import type { SandboxedMcpTool } from "emdash/plugin";
import { z } from "zod";

import {
	DEFAULT_LIMIT,
	MAX_CURSOR,
	MAX_ENTRY_ID,
	MAX_LIMIT,
	MAX_PATH,
	TOOL_ROUTES,
} from "./load.js";

export function mcpTools(): Record<string, SandboxedMcpTool> {
	const day = z.string().describe("A day in the plugin's Time zone setting, YYYY-MM-DD.");
	const window = z.object({
		days: z.number().int(),
		since: day,
		until: day.describe("Today in the Time zone setting. Its numbers still move."),
		partial: z
			.boolean()
			.describe("True when stored history starts after since, so the numbers cover fewer days than the window."),
	});
	const pageHistorySince = day
		.nullable()
		.describe("The oldest day of per-page numbers in storage, or null before the first sync. Older days are pruned by the retention setting.");
	const indexComplete = z
		.boolean()
		.describe(
			"False while the plugin matches the site's pages to entries, on a new install or during a rebuild; entries may be missing or misattributed until then.",
		);
	const lastSync = z.string().nullable().describe("When the plugin last synced from the provider, ISO 8601.");

	const entryDays = z
		.union([z.literal(7), z.literal(30)])
		.optional()
		.describe("Window in days, ending today in the Time zone setting. Default 30.");
	const listInput = z.object({
		days: entryDays,
		collection: z
			.string()
			.max(63)
			.regex(/^[a-z][a-z0-9_]*$/)
			.optional()
			.describe("Only entries of this collection, by slug, such as posts."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_LIMIT)
			.optional()
			.describe(`Entries per page, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`),
		cursor: z
			.string()
			.min(1)
			.max(MAX_CURSOR)
			.optional()
			.describe("nextCursor from the previous page, sent with the same days and collection."),
	});
	const listOutput = z.object({
		window,
		collection: z.string().nullable(),
		items: z.array(
			z.object({
				entryId: z.string(),
				title: z.string(),
				collection: z.string(),
				collectionLabel: z.string(),
				locale: z.string(),
				path: z.string(),
				views: z.number().describe("Page views in the window."),
				publishedAt: z.string().optional(),
			}),
		),
		nextCursor: z.string().optional().describe("Pass as cursor to get the next page. Absent on the last page."),
		historySince: pageHistorySince,
		indexComplete,
		lastSync,
	});

	const views = { views7: z.number(), views30: z.number() };

	return {
		top_entries: {
			description:
				"The site's most viewed published entries over the last 7 or 30 days, from the analytics provider's page views matched to content. " +
				"Use it to answer which posts or pages get the most traffic. " +
				"The counts are from the plugin's last sync (lastSync) and include today, which is still counting. " +
				"When window.partial is true, stored history is shorter than the window; when indexComplete is false, some entries are not matched yet: say so rather than presenting the list as complete. " +
				"A page can hold fewer items than limit; follow nextCursor for more.",
			route: TOOL_ROUTES.topEntries,
			input: listInput,
			output: listOutput,
			destructive: false,
		},
		unviewed_entries: {
			description:
				"Published entries with no page views in the last 7 or 30 days. " +
				"Use it to find content nobody reads. " +
				"Check publishedAt: an entry published inside the window had less time to be seen. " +
				"The list is only as complete as the data: window.partial true means stored history is shorter than the window, indexComplete false means some entries are not matched yet. " +
				"A page can hold fewer items than limit; follow nextCursor for more.",
			route: TOOL_ROUTES.unviewedEntries,
			input: listInput,
			output: listOutput,
			destructive: false,
		},
		entry_views: {
			description:
				"Page views of one entry over the last 7 and 30 days, with its published translations and their combined total. " +
				"Pass entryId, or path as the site serves it (a full URL works too). " +
				"found is false when no page of the entry is in the plugin's index: it may be a draft, in a collection without a URL pattern, or not matched yet (indexComplete). " +
				"The counts are from the plugin's last sync (lastSync) and include today, which is still counting.",
			route: TOOL_ROUTES.entryViews,
			input: z.object({
				entryId: z.string().min(1).max(MAX_ENTRY_ID).optional().describe("The entry's id."),
				path: z
					.string()
					.min(1)
					.max(MAX_PATH)
					.optional()
					.describe("The path or URL the entry is published at. Used when entryId is not given."),
			}),
			output: z.object({
				found: z.boolean(),
				entry: z
					.object({
						entryId: z.string(),
						title: z.string(),
						collection: z.string(),
						collectionLabel: z.string(),
						locale: z.string(),
						path: z.string(),
						status: z
							.enum(["published", "unpublished", "deleted", "moved"])
							.describe("Not published: the numbers are from the path it was last published at."),
						...views,
						publishedAt: z.string().optional(),
					})
					.nullable(),
				translations: z.array(
					z.object({
						entryId: z.string(),
						title: z.string(),
						locale: z.string(),
						path: z.string(),
						...views,
					}),
				),
				allLanguages: z
					.object(views)
					.nullable()
					.describe("The published pages of the entry and its translations together."),
				windows: z.object({ views7: window, views30: window }),
				historySince: pageHistorySince,
				indexComplete,
				lastSync,
			}),
			destructive: false,
		},
		site_totals: {
			description:
				"Visits and page views for the whole site over the last 7, 30 or 90 days, with the period of the same length before it for comparison. " +
				"Use it for overall traffic and its trend. " +
				"previous is null when stored history does not reach back far enough to compare. " +
				"estimated is true when the provider sampled a day, so the numbers are extrapolated; provisional is true when today, still counting, is included. " +
				"engagement is the bounce rate, average visit and page views per visit over the days that carry them, from engagement.since; it is null when no day in the window does.",
			route: TOOL_ROUTES.siteTotals,
			input: z.object({
				days: z
					.union([z.literal(7), z.literal(30), z.literal(90)])
					.optional()
					.describe("Window in days, ending today in the Time zone setting. Default 30."),
			}),
			output: z.object({
				window,
				visits: z.number(),
				pageviews: z.number(),
				estimated: z.boolean(),
				provisional: z.boolean(),
				previous: z
					.object({
						since: day,
						until: day,
						visits: z.number(),
						pageviews: z.number(),
						estimated: z.boolean(),
					})
					.nullable(),
				engagement: z
					.object({
						since: day.describe("The first day of the window that carries engagement. Days stored before it do not."),
						bounceRate: z.number().describe("Visits with a single page view, as a share of visits, from 0 to 1."),
						averageVisitSeconds: z.number(),
						pagesPerVisit: z.number(),
						previous: z
							.object({ bounceRate: z.number(), averageVisitSeconds: z.number(), pagesPerVisit: z.number() })
							.nullable()
							.describe("The period before, or null when stored engagement does not reach back to its start."),
					})
					.nullable(),
				historySince: day
					.nullable()
					.describe("The oldest day of site totals in storage, or null before the first sync. Site totals are kept longer than per-page numbers."),
				lastSync,
			}),
			destructive: false,
		},
	};
}
