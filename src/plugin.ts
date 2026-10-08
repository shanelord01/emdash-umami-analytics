/**
 * Hooks, the cron dispatcher, the admin routes and the MCP tools.
 *
 * Hooks and routes are declared here rather than in `emdash-plugin.jsonc`
 * because the authored manifest is strict and rejects both keys outright;
 * the build probes this module and writes them into the wire manifest.
 *
 * The route's `permission` is the load-bearing line. An implicit `admin`
 * route resolves with no permission, so dispatch falls back to
 * `plugins:manage`, which is admin-only — a plugin that forgets this ships
 * a dashboard widget no editor can see. `plugins:read` is EDITOR and above
 * (`packages/auth/src/rbac.ts:83`), taken from the table rather than
 * invented. Authors and contributors still see the widget card and get a
 * 403 from the host before this code runs; that is an upstream gap, and
 * the README says which roles see numbers.
 */

import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { langOf, problemText, t, type Lang } from "./i18n.js";
import { entryRefOf, indexEntry, markEntryStatus } from "./index/entries.js";
import { readSettings, type SettingsResult } from "./settings.js";
import {
	buildProvider,
	ensureScheduled,
	noteWaiting,
	readState,
	rememberCollectionLabels,
	requestRebuild,
	requestRefresh,
	runReconcile,
	runSync,
	CATCH_UP_TASKS,
	RECONCILE_TASK,
	REFRESH_TASK,
	SYNC_TASK,
} from "./sync/scheduler.js";
import {
	DEFAULT_RANGE,
	loadPage,
	PAGE_PATH,
	PAGE_REFRESH_ACTION,
	parseRange,
	RANGE_ACTION,
	renderPage,
	SETUP_ACTION,
	type RangeDays,
} from "./ui/page.js";
import { loadSetup, renderSetup } from "./ui/setup.js";
import { CONTENT_PATH, loadContent, parseContentInput, renderContent } from "./ui/content.js";
import { loadPanel, renderPanel } from "./ui/panel.js";
import { loadWidget, renderWidget, REFRESH_ACTION } from "./ui/widget.js";
import { DEFAULT_SYNC_INTERVAL } from "./settings.js";
import { mcpTools } from "./tools/declare.js";
import { entryViews, siteTotals, topEntries, TOOL_ROUTES, unviewedEntries } from "./tools/load.js";

/**
 * The cron hook's own timeout. The default is 5 000 ms, which a tick that
 * makes an outbound HTTPS request and several storage round-trips can
 * exceed on a cold isolate.
 */
const CRON_TIMEOUT_MS = 30_000;

const plugin: SandboxedPlugin = {
	hooks: {
		/**
		 * Fires only when an administrator clicks Enable. A site that
		 * registers the plugin through `plugins: []` never gets one, which is
		 * why this is not the only place scheduling happens.
		 */
		"plugin:activate": async (_event, ctx) => {
			await scheduleFromSettings(ctx);
		},

		cron: {
			timeout: CRON_TIMEOUT_MS,
			handler: async (event, ctx) => {
				if (event.name === SYNC_TASK) {
					await runSync(ctx);
					return;
				}

				if ((CATCH_UP_TASKS as readonly string[]).includes(event.name)) {
					await runSync(ctx, new Date(), { catchUp: event.name });
					return;
				}

				if (event.name === REFRESH_TASK) {
					await runSync(ctx, new Date(), { overview: true });
					return;
				}

				if (event.name === RECONCILE_TASK) {
					const result = await readSettings(ctx);
					const values = result.ok ? result.settings : result.partial;
					await runReconcile(ctx, values.retentionDays ?? 90, new Date(), values.timeZone);
					return;
				}

				ctx.log.debug("analytics: ignoring unknown cron task", { name: event.name });
			},
		},

		// Content hooks never block a save: a failure to index is a reporting
		// problem, not an editorial one.
		"content:afterSave": {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				// Also the reliable scheduling entry point for `plugins: []`
				// installs, where `plugin:activate` never fires.
				await scheduleFromSettings(ctx);
				await index(ctx, event, "published");
			},
		},
		"content:afterPublish": {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				await index(ctx, event, "published");
			},
		},
		"content:afterRestore": {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				await index(ctx, event, "published");
			},
		},
		// Unpublish and delete keep the row and mark it, so past traffic stays
		// attributable to the entry that earned it. `getPublicUrl()` returns
		// null for these, so the row is found by `entryId` instead.
		"content:afterUnpublish": {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const ref = entryRefOf(event);
				if (!ref) return;
				try {
					await markEntryStatus(ctx, ref, "unpublished", new Date());
				} catch (error) {
					ctx.log.warn("analytics: could not mark entry unpublished", { error: String(error) });
				}
			},
		},
		"content:afterDelete": {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const ref = entryRefOf(event);
				if (!ref) return;
				try {
					await markEntryStatus(ctx, ref, "deleted", new Date());
				} catch (error) {
					ctx.log.warn("analytics: could not mark entry deleted", { error: String(error) });
				}
			},
		},
	},

	routes: {
		admin: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => {
				const interaction = parseInteraction(routeCtx.input);
				const now = new Date();
				// English when the host passes no locale, which is the case for
				// plugins registered in `plugins: []`.
				const lang = langOf(routeCtx.ui?.locale);

				if (interaction.surface === "page") {
					return await handlePage(ctx, interaction, now, lang);
				}
				if (interaction.surface === "content") {
					return await handleContent(ctx, interaction.input, now, lang);
				}

				if (interaction.kind === "refresh") {
					const toast = await refresh(ctx, await readSettings(ctx), now, lang);
					const state = await readState(ctx);
					const input = await loadWidget(ctx, state, now, lang);
					return { blocks: renderWidget(input), toast };
				}

				// The widget's own page load is the third scheduling entry
				// point, and the one the PoC measures: after a single dashboard
				// visit, `_emdash_cron_tasks` should hold the sync row without
				// anybody having clicked Enable.
				await scheduleFromSettings(ctx);

				const state = await readState(ctx);
				await noteWaiting(ctx, state, now);
				const input = await loadWidget(ctx, state, now, lang);
				return { blocks: renderWidget(input) };
			},
		},

		// The entry editor's Views panel. Its own route because it needs a
		// lower permission than the analytics pages: `content:edit_own` is
		// AUTHOR and above, and the host additionally checks that the user
		// may edit this entry (`http-route-dispatch.ts`), so authors see
		// their own entries' numbers and nobody else's.
		panel: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const ui = routeCtx.ui;
				const entryId = ui?.surface === "content-editor-panel" ? ui.entry.id : null;
				const state = await readState(ctx);
				return { blocks: renderPanel(await loadPanel(ctx, entryId, state, new Date(), ui?.locale)) };
			},
		},

		// The MCP tools' routes read what the analytics pages show, so they
		// need the same permission.
		[TOOL_ROUTES.topEntries]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await topEntries(ctx, routeCtx.input, new Date()),
		},
		[TOOL_ROUTES.unviewedEntries]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await unviewedEntries(ctx, routeCtx.input, new Date()),
		},
		[TOOL_ROUTES.entryViews]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await entryViews(ctx, routeCtx.input, new Date()),
		},
		[TOOL_ROUTES.siteTotals]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await siteTotals(ctx, routeCtx.input, new Date()),
		},
	},

	mcp: { tools: mcpTools() },
};

/**
 * Index best-effort.
 *
 * `errorPolicy: "continue"` stops the host aborting the save, but the
 * handler still has to not throw: failing to record where an entry lives is
 * a reporting problem, and an editor pressing Publish should never see it.
 */
async function index(ctx: PluginContext, event: unknown, status: "published"): Promise<void> {
	const ref = entryRefOf(event);
	if (!ref) return;
	try {
		await indexEntry(ctx, ref, status, new Date(), contentOf(event));
	} catch (error) {
		ctx.log.warn("analytics: could not index entry", { collection: ref.collection, error: String(error) });
	}
}

/** The entry's fields as the hook delivered them, when it delivered any. */
function contentOf(event: unknown): Record<string, unknown> | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const content = (event as Record<string, unknown>).content;
	return typeof content === "object" && content !== null ? (content as Record<string, unknown>) : undefined;
}

/**
 * Schedule with whatever interval is configured, falling back to the
 * default when settings are not readable yet.
 *
 * `CronAccess.schedule` upserts on (plugin, task), so calling this from
 * three different entry points costs one statement and cannot duplicate a
 * task.
 */
async function scheduleFromSettings(ctx: PluginContext): Promise<void> {
	let interval = DEFAULT_SYNC_INTERVAL;
	try {
		const result = await readSettings(ctx);
		if (result.ok) interval = result.settings.syncInterval;
		else if (result.partial.syncInterval) interval = result.partial.syncInterval;
	} catch {
		// Fall through with the default: an unscheduled plugin is worse than
		// one scheduled at the wrong cadence.
	}
	await ensureScheduled(ctx, interval);
}

type Interaction =
	| { surface: "widget"; kind: "load" | "refresh" }
	| { surface: "page"; kind: "load" | "refresh" | "setup"; range: RangeDays }
	| { surface: "content"; input: Record<string, unknown> };

/**
 * Block Kit sends `page_load` on mount and `block_action` on an element,
 * both naming the page or widget they came from. Anything unrecognised
 * renders rather than errors: an unknown interaction is not worth a broken
 * card.
 */
function parseInteraction(input: unknown): Interaction {
	if (typeof input !== "object" || input === null) return { surface: "widget", kind: "load" };
	const record = input as Record<string, unknown>;
	const isAction = record.type === "block_action";

	if (record.page === CONTENT_PATH) return { surface: "content", input: record };

	if (record.page === PAGE_PATH) {
		if (isAction && record.action_id === PAGE_REFRESH_ACTION) {
			return { surface: "page", kind: "refresh", range: parseRange(record.value) };
		}
		if (isAction && record.action_id === RANGE_ACTION) {
			return { surface: "page", kind: "load", range: parseRange(record.value) };
		}
		if (isAction && record.action_id === SETUP_ACTION) {
			return { surface: "page", kind: "setup", range: parseRange(record.value) };
		}
		return { surface: "page", kind: "load", range: DEFAULT_RANGE };
	}

	if (isAction && record.action_id === REFRESH_ACTION) return { surface: "widget", kind: "refresh" };
	return { surface: "widget", kind: "load" };
}

/**
 * The analytics page. It reads the provider live, so its Refresh just
 * loads it again and says whether the live read worked; it schedules
 * nothing. Loading it does not schedule the cron either: the dashboard
 * widget does that on every visit.
 */
async function handlePage(
	ctx: PluginContext,
	interaction: Extract<Interaction, { surface: "page" }>,
	now: Date,
	lang: Lang,
) {
	if (interaction.kind === "setup") {
		return { blocks: renderSetup(await loadSetup(ctx, now), interaction.range, lang) };
	}

	const settings = await readSettings(ctx);
	const state = await readState(ctx);
	const provider = liveProvider(ctx, settings);
	const properties = settings.ok ? settings.settings.breakdownProperties : [];
	const input = await loadPage(ctx, state, interaction.range, now, dashboardUrl(ctx, settings), lang, provider, properties);
	const blocks = renderPage(input);
	if (interaction.kind !== "refresh") return { blocks };

	const live = Boolean(input.breakdowns);
	return {
		blocks,
		toast:
			live || !provider
				? { message: t(lang, "pageRefreshed"), type: "success" as const }
				: { message: t(lang, "pageRefreshFailed"), type: "error" as const },
	};
}

/**
 * The per-entry page. It reads storage only: the numbers it sorts by are
 * the ones the sync stored, so asking the provider live would show values
 * the order does not follow.
 */
async function handleContent(ctx: PluginContext, input: Record<string, unknown>, now: Date, lang: Lang) {
	const { view, rebuild } = parseContentInput(input);
	const state = rebuild ? await requestRebuild(ctx) : await readState(ctx);
	const content = await loadContent(ctx, view, state, now, lang);
	await rememberCollectionLabels(ctx, state, Object.fromEntries(content.collections.map((c) => [c.slug, c.label])));
	const blocks = renderContent(content);
	if (!rebuild) return { blocks };
	return { blocks, toast: { message: t(lang, "rebuildRequested"), type: "success" as const } };
}

/** The provider to ask live, or null when it could not answer anyway. */
function liveProvider(ctx: PluginContext, settings: SettingsResult) {
	if (!settings.ok) return null;
	if (settings.settings.provider !== "demo" && !settings.settings.siteTag) return null;
	return buildProvider(ctx, settings.settings);
}

/** The configured provider's own dashboard, or null (demo data, or not configured). */
function dashboardUrl(ctx: PluginContext, settings: SettingsResult): string | null {
	if (!settings.ok) return null;
	return buildProvider(ctx, settings.settings)?.dashboardUrl?.() ?? null;
}

/**
 * Refresh schedules a tick rather than running one (see `requestRefresh`).
 * An incomplete configuration is answered at once: the tick could only
 * record the same problem, minutes later.
 */
async function refresh(
	ctx: PluginContext,
	settings: SettingsResult,
	now: Date,
	lang: Lang,
): Promise<{ message: string; type: "success" | "error" }> {
	if (!settings.ok) {
		const problem = { key: "notConfigured" as const, params: { missing: settings.missing.join(",") } };
		return { message: problemText(lang, problem), type: "error" };
	}
	if (!(await requestRefresh(ctx, now))) return { message: t(lang, "syncUnschedulable"), type: "error" };
	return { message: t(lang, "syncRequested"), type: "success" };
}

export default plugin;
