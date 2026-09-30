import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { describe, expect, it } from "vitest";

import type { EntryRow, RollupRow } from "../src/store/rows.js";
import { addDays } from "../src/sync/window.js";
import { CONTENT_PATH } from "../src/ui/content.js";
import { formatDay } from "../src/ui/format.js";
import {
	PAGE_PATH,
	PAGE_REFRESH_ACTION,
	parseRange,
	RANGE_ACTION,
	mergeDays,
	renderPage,
	summarizeDaily,
	type PageInput,
} from "../src/ui/page.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const TODAY = "2026-09-23";

const rollup = (date: string, pageviews: number, visits = Math.round(pageviews * 0.7), sampleInterval = 1): RollupRow => ({
	date,
	pageviews,
	visits,
	sampleInterval,
	fetchedAt: NOW.toISOString(),
});

/** `days` consecutive rollups ending today. */
function history(days: number, pageviews = 100): RollupRow[] {
	return Array.from({ length: days }, (_, i) => rollup(addDays(TODAY, -i), pageviews));
}

const entry = (path: string, title: string, collection = "posts"): EntryRow => ({
	path,
	collection,
	entryId: `id-${path}`,
	translationGroup: `id-${path}`,
	locale: "en",
	title,
	status: "published",
	views7: 0,
	views30: 0,
	updatedAt: NOW.toISOString(),
});

function input(over: Partial<PageInput> = {}): PageInput {
	return {
		state: {
			phase: "overview",
			provider: "umami",
			lastSync: "2026-09-23T11:55:00.000Z",
			referrers: [{ label: "(direct)", visits: 40 }],
			countries: [{ label: "DE", visits: 30 }],
			snapshotSince: addDays(TODAY, -2),
		},
		range: 30,
		rollups: history(60),
		topEntries: {
			rows: [
				{ path: "/", pageviews: 50, visits: 40 },
				{ path: "/blog/hello/", pageviews: 20, visits: 15 },
			],
			coveredSince: addDays(TODAY, -29),
			partial: false,
		},
		entriesByPath: new Map([
			["/", entry("/", "Home", "home")],
			["/blog/hello/", entry("/blog/hello/", "Hello")],
		]),
		dashboardUrl: "https://cloud.umami.is/websites/site-1",
		now: NOW,
		locale: "en",
		...over,
	};
}

function expectValid(blocks: unknown) {
	const result = validateBlockResponse({ blocks }, { pluginPagePaths: [PAGE_PATH, CONTENT_PATH] });
	if (!result.valid) {
		throw new Error(`Block Kit validation failed:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
	}
	expect(result.valid).toBe(true);
}

type AnyBlock = Record<string, unknown> & { type: string };

function find(blocks: unknown[], type: string): AnyBlock[] {
	const out: AnyBlock[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			const record = value as AnyBlock;
			if (record.type === type) out.push(record);
			Object.values(record).forEach(walk);
		}
	};
	walk(blocks);
	return out;
}

function chartPoints(blocks: unknown[]): number[] {
	const chart = find(blocks, "chart")[0] as unknown as { config: { series: Array<{ data: unknown[] }> } } | undefined;
	return chart ? chart.config.series.map((s) => s.data.length) : [];
}

describe("renderPage", () => {
	it("names collections by label, and leaves paths that are no entry blank", () => {
		const blocks = renderPage(
			input({
				state: { ...input().state, collectionLabels: { home: "Startseite", posts: "Blog" } },
				topEntries: {
					rows: [
						{ path: "/", pageviews: 50, visits: 40 },
						{ path: "/analytics", pageviews: 1, visits: 1 },
					],
					partial: false,
				},
			}),
		);
		const rows = find(blocks, "table")[0]!.rows as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.collection)).toEqual(["Startseite", ""]);
	});

	it("produces blocks the host accepts, links included", () => {
		expectValid(renderPage(input()));
	});

	it("charts exactly the days in the range that have data", () => {
		expect(chartPoints(renderPage(input({ range: 30 })))).toEqual([30, 30]);
		expect(chartPoints(renderPage(input({ range: 7 })))).toEqual([7, 7]);
	});

	it("leaves a day the provider never reported out of the chart rather than drawing a zero", () => {
		const rollups = history(60).filter((r) => r.date !== addDays(TODAY, -3));
		expect(chartPoints(renderPage(input({ range: 7, rollups })))).toEqual([6, 6]);
	});

	it("shows a trend only when the previous period has data", () => {
		const withHistory = find(renderPage(input({ range: 30 })), "stats")[0] as unknown as { items: Array<{ trend?: string }> };
		expect(withHistory.items[0]!.trend).toBeDefined();

		const fresh = find(renderPage(input({ range: 30, rollups: history(10) })), "stats")[0] as unknown as {
			items: Array<{ trend?: string; description?: string }>;
		};
		expect(fresh.items[0]!.trend).toBeUndefined();
		expect(fresh.items[0]!.description).toMatch(/no earlier period/);
	});

	it("does not compare against a previous period that history only grazes", () => {
		// A 90-day backfill leaves one day of the previous 90; comparing
		// against it reported "+8,713%".
		const grazed = find(renderPage(input({ range: 30, rollups: history(31) })), "stats")[0] as unknown as {
			items: Array<{ trend?: string; description?: string }>;
		};
		expect(grazed.items[0]!.trend).toBeUndefined();
		expect(grazed.items[0]!.description).toMatch(/no earlier period/);
	});

	it("offers each range as a button, marks the chosen one, and keeps it on refresh", () => {
		// Buttons rather than a select: the host's select shows the raw value
		// ("90") when closed, and its label pushes it out of line with the
		// buttons beside it.
		const blocks = renderPage(input({ range: 90 }));
		expect(find(blocks, "select")).toHaveLength(0);
		const ranges = find(blocks, "button").filter((b) => b.action_id === RANGE_ACTION);
		expect(ranges.map((b) => b.value)).toEqual([7, 30, 90]);
		expect(ranges.find((b) => b.value === 90)?.style).toBe("primary");
		expect(ranges.filter((b) => b.style === "primary")).toHaveLength(1);
		const refresh = find(blocks, "button").find((b) => b.action_id === PAGE_REFRESH_ACTION);
		expect(refresh?.value).toBe(90);
	});

	it("links to the provider's own dashboard when there is one, and not otherwise", () => {
		const url = "https://cloud.umami.is/websites/site-1";
		const links = find(renderPage(input()), "link") as unknown as Array<{ target: { kind: string; url?: string } }>;
		expect(links.some((l) => l.target.kind === "external" && l.target.url === url)).toBe(true);
		expect(JSON.stringify(renderPage(input()))).toContain("Open in Umami");

		const demo = find(renderPage(input({ dashboardUrl: null })), "link");
		expect(demo.some((l) => (l.target as { kind: string }).kind === "external")).toBe(false);
	});

	it("names entries by title and says how far back per-entry numbers reach", () => {
		const blocks = renderPage(
			input({ topEntries: { rows: [{ path: "/", pageviews: 5, visits: 4 }], coveredSince: addDays(TODAY, -7), partial: false } }),
		);
		const text = JSON.stringify(blocks);
		expect(text).toContain("Home");
		expect(text).toContain(formatDay(addDays(TODAY, -7), "en"));
	});

	it("stays inside the host's response limits at 90 days with a full page of entries", () => {
		const rows = Array.from({ length: 20 }, (_, i) => ({ path: `/blog/post-${i}/`, pageviews: 100 - i, visits: 50 }));
		const entriesByPath = new Map(rows.map((r) => [r.path, entry(r.path, `A reasonably long entry title number ${r.path}`)]));
		const state = {
			...input().state,
			referrers: Array.from({ length: 10 }, (_, i) => ({ label: `ref-${i}.example`, visits: 10 - i })),
			countries: Array.from({ length: 10 }, (_, i) => ({ label: "DE", visits: 10 - i })),
		};
		expectValid(
			renderPage(input({ range: 90, rollups: history(180), topEntries: { rows, partial: false }, entriesByPath, state })),
		);
	});

	it("explains an empty store instead of rendering zeroes", () => {
		const blocks = renderPage(input({ rollups: [], topEntries: { rows: [], partial: false } }));
		expectValid(blocks);
		expect(find(blocks, "empty")).toHaveLength(1);
		expect(find(blocks, "chart")).toHaveLength(0);
	});

	it("marks demo data as demo data, and its sampled days as estimated", () => {
		const sampled = history(60).map((row) => (row.date === TODAY ? { ...row, sampleInterval: 2 } : row));
		const blocks = renderPage(
			input({ state: { ...input().state, provider: "demo", estimated: true }, rollups: sampled, dashboardUrl: null }),
		);
		const text = JSON.stringify(blocks);
		expect(text).toMatch(/Demo data/);
		expect(text).toMatch(/estimated \(sampled\)/);
	});

	it("marks nothing as estimated when every day was counted exactly", () => {
		expect(JSON.stringify(renderPage(input()))).not.toMatch(/estimated/);
	});
});

describe("views by event data", () => {
	const breakdowns = (properties: NonNullable<PageInput["breakdowns"]>["properties"]) => ({
		referrers: [],
		countries: [],
		since: addDays(TODAY, -29),
		properties,
	});

	it("shows a table for each property the range's page views carry, and none for one they did not", () => {
		const blocks = renderPage(
			input({
				breakdowns: breakdowns([
					{ property: "category", values: [{ value: "our-trips", pageviews: 12 }] },
					{ property: "byline", values: [] },
				]),
			}),
		);
		expectValid(blocks);
		const text = JSON.stringify(blocks);
		expect(text).toContain("Views by category");
		expect(text).toContain("our-trips");
		expect(text).not.toContain("Views by byline");
		expect(text).toMatch(/counted on every hostname/);
	});

	it("shows nothing, and no note, when no page view carried any", () => {
		const text = JSON.stringify(renderPage(input({ breakdowns: breakdowns([{ property: "category", values: [] }]) })));
		expect(text).not.toMatch(/Views by|every hostname/);
	});

	it("lists ten values at most, and names the table in the reader's language", () => {
		const values = Array.from({ length: 14 }, (_, i) => ({ value: `v-${i}`, pageviews: 20 - i }));
		const blocks = renderPage(input({ locale: "de", breakdowns: breakdowns([{ property: "category", values }]) }));
		const table = blocks.find((b) => (b as { block_id?: string }).block_id === "analytics:property:category") as unknown as {
			rows: unknown[];
		};
		expect(table.rows).toHaveLength(10);
		expect(JSON.stringify(blocks)).toContain("Aufrufe nach category");
	});
});

describe("parseRange", () => {
	it("accepts the offered ranges as strings or numbers", () => {
		expect(parseRange("90")).toBe(90);
		expect(parseRange(7)).toBe(7);
	});

	it("falls back to 30 days for anything else", () => {
		expect(parseRange("45")).toBe(30);
		expect(parseRange(undefined)).toBe(30);
		expect(parseRange({ range: 7 })).toBe(30);
	});
});

describe("summarizeDaily", () => {
	const row = (date: string, path: string, pageviews: number) => ({ date, path, pageviews, visits: pageviews });

	it("adds up each path across the days read", () => {
		const out = summarizeDaily([row(TODAY, "/", 2), row(addDays(TODAY, -1), "/", 3), row(TODAY, "/a/", 1)], false);
		expect(out.rows).toEqual([
			{ path: "/", pageviews: 5, visits: 5 },
			{ path: "/a/", pageviews: 1, visits: 1 },
		]);
		expect(out).toMatchObject({ coveredSince: addDays(TODAY, -1), partial: false });
	});

	it("drops the oldest day when the read stopped part-way through it", () => {
		// Rows arrive newest first; if more pages remain, the oldest day in
		// hand may be missing paths, so it is left out rather than undercounted.
		const out = summarizeDaily([row(TODAY, "/", 2), row(addDays(TODAY, -1), "/", 3)], true);
		expect(out.rows).toEqual([{ path: "/", pageviews: 2, visits: 2 }]);
		expect(out).toMatchObject({ coveredSince: TODAY, partial: true });
	});
});

describe("merging the live answer with the store", () => {
	const live = (rows: RollupRow[]) => ({
		totals: { pageviews: 0, visits: 0, sampleInterval: 1 },
		series: rows.map(({ fetchedAt: _f, ...row }) => row),
		topPaths: [],
		referrers: [],
		countries: [],
		truncated: false,
	});

	it("takes the live day over the stored one, since the store may be a tick behind", () => {
		const merged = mergeDays([rollup(TODAY, 50)], live([rollup(TODAY, 64)]), NOW);
		expect(merged).toEqual([expect.objectContaining({ date: TODAY, pageviews: 64 })]);
	});

	it("keeps stored days the live answer does not cover: older history and the previous period", () => {
		const before = addDays(TODAY, -40);
		const merged = mergeDays([rollup(before, 7)], live([rollup(TODAY, 64)]), NOW);
		expect(merged.map((r) => r.date).sort()).toEqual([before, TODAY].sort());
	});
});
