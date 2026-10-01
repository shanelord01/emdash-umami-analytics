/**
 * The MCP tools' routes: read-only answers from storage.
 *
 * Each call is one sandboxed route invocation with ten bridge calls, so
 * nothing here asks the provider live. The numbers are the ones the sync
 * stored, and every answer says which UTC days they cover, where stored
 * history starts and when the last sync ran, so an agent can tell thin
 * data from a full window.
 *
 * The input schemas in `./declare.ts` are build metadata: the build
 * strips them from the runtime, and EmDash's MCP server validates a call
 * against them before the route runs. The same route is reachable over
 * HTTP without that validation, so each handler reads its input
 * defensively, falls back to the default, and names the window it used.
 */

import type { PluginContext } from "emdash/plugin";

import { engagementOver, engagementReaches, type Engagement } from "../store/engagement.js";

import { normalizePath } from "../index/paths.js";
import { dailyStore, entriesStore, oldestDay, rollupStore, BIND_LIMIT, type Typed } from "../store/access.js";
import { isPublished, sumWindow, type EntryRow, type RollupRow } from "../store/rows.js";
import { indexOutdated, readState, type SyncState } from "../sync/scheduler.js";
import { addDays, daysBetween, utcDay, type Day } from "../sync/window.js";
import { loadPanel } from "../ui/panel.js";

export const TOOL_ROUTES = {
	topEntries: "mcp/top_entries",
	entryViews: "mcp/entry_views",
	unviewedEntries: "mcp/unviewed_entries",
	siteTotals: "mcp/site_totals",
} as const;

export const ENTRY_DAYS = [7, 30] as const;
export const TOTALS_DAYS = [7, 30, 90] as const;
export const DEFAULT_DAYS = 30;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MAX_CURSOR = 2048;
export const MAX_ENTRY_ID = 128;
export const MAX_PATH = 2048;

const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;
const MAX_COLLECTION = 63;

/**
 * Entries pages a list tool reads to fill its page past rows that are not
 * published, plus one exact re-read (see `collect`).
 */
const LIST_PAGES = 4;
/** Rows read per page while filling, however few items are still missing. */
const SCAN_ROWS = 25;

/** Rollup pages per call: 180 days, the longest range plus its comparison. */
const ROLLUP_PAGES = 2;

export interface ToolWindow {
	days: number;
	/** First UTC day of the window. */
	since: Day;
	/** Last UTC day of the window: today, still counting. */
	until: Day;
	/** True when stored history starts after `since`, so the numbers cover fewer days. */
	partial: boolean;
}

export interface ToolEntry {
	entryId: string;
	title: string;
	collection: string;
	collectionLabel: string;
	locale: string;
	path: string;
	views: number;
	publishedAt?: string;
}

export interface EntryListResult {
	window: ToolWindow;
	collection: string | null;
	items: ToolEntry[];
	nextCursor?: string;
	historySince: Day | null;
	indexComplete: boolean;
	lastSync: string | null;
}

export interface EntryViewsResult {
	found: boolean;
	entry: {
		entryId: string;
		title: string;
		collection: string;
		collectionLabel: string;
		locale: string;
		path: string;
		status: EntryRow["status"];
		views7: number;
		views30: number;
		publishedAt?: string;
	} | null;
	translations: Array<{
		entryId: string;
		title: string;
		locale: string;
		path: string;
		views7: number;
		views30: number;
	}>;
	allLanguages: { views7: number; views30: number } | null;
	windows: { views7: ToolWindow; views30: ToolWindow };
	historySince: Day | null;
	indexComplete: boolean;
	lastSync: string | null;
}

export interface SiteTotalsResult {
	window: ToolWindow;
	visits: number;
	pageviews: number;
	/** True when the provider sampled at least one day in the window. */
	estimated: boolean;
	/** True when the window holds today, whose numbers still move. */
	provisional: boolean;
	previous: { since: Day; until: Day; visits: number; pageviews: number; estimated: boolean } | null;
	engagement: {
		since: Day;
		bounceRate: number;
		averageVisitSeconds: number;
		pagesPerVisit: number;
		previous: { bounceRate: number; averageVisitSeconds: number; pagesPerVisit: number } | null;
	} | null;
	historySince: Day | null;
	lastSync: string | null;
}

type ListKind = "top" | "unviewed";

interface ListInput {
	kind: ListKind;
	days: (typeof ENTRY_DAYS)[number];
	collection: string | null;
	limit: number;
	/** The storage cursor inside the caller's cursor. */
	cursor?: string;
}

export function parseListInput(kind: ListKind, input: unknown): ListInput {
	const record = asRecord(input);
	const view: ListInput = {
		kind,
		days: pickDays(record.days, ENTRY_DAYS),
		collection: slugOf(record.collection),
		limit: limitOf(record.limit),
	};
	const cursor = boundedString(record.cursor, MAX_CURSOR);
	return cursor ? { ...view, cursor: storageCursor(view, cursor) } : view;
}

/**
 * A storage cursor seeks by the value of the column it was sorted on. One
 * from another tool, window or collection would page through a different
 * order without any sign of it, so the cursor names its query and a
 * mismatch is refused.
 */
function queryTag(view: ListInput): string {
	return `${view.kind}.${view.days}.${view.collection ?? ""}`;
}

function ownCursor(view: ListInput, storage: string): string {
	return `${queryTag(view)}~${storage}`;
}

export function storageCursor(view: ListInput, cursor: string): string {
	const cut = cursor.indexOf("~");
	if (cut < 0 || cursor.slice(0, cut) !== queryTag(view) || cut === cursor.length - 1) {
		throw new Error(
			"This cursor belongs to another query. Pass nextCursor with the days and collection it came with, or leave cursor out to start from the top.",
		);
	}
	return cursor.slice(cut + 1);
}

/**
 * Published entries by views over the window, most viewed first.
 * Calls: state, the oldest stored day, up to `LIST_PAGES` entries pages
 * and one re-read.
 */
export async function topEntries(ctx: PluginContext, input: unknown, now: Date): Promise<EntryListResult> {
	const view = parseListInput("top", input);
	const { state, historySince, entries } = await listContext(ctx);
	const base = listBase(view, state, historySince, utcDay(now));
	if (!entries) return { ...base, items: [] };

	const { rows, nextCursor } = await collect(entries, view, "desc", (row) => (isPublished(row) ? "take" : "skip"));
	return { ...base, items: rows.map((row) => toolEntry(row, view.days, state)), ...(nextCursor && { nextCursor }) };
}

/**
 * Published entries with no views over the window.
 *
 * Rows are read least viewed first, so the first row with views ends the
 * list: everything after it has views too.
 * Calls: state, the oldest stored day, up to `LIST_PAGES` entries pages
 * and one re-read.
 */
export async function unviewedEntries(ctx: PluginContext, input: unknown, now: Date): Promise<EntryListResult> {
	const view = parseListInput("unviewed", input);
	const { state, historySince, entries } = await listContext(ctx);
	const base = listBase(view, state, historySince, utcDay(now));
	if (!entries) return { ...base, items: [] };

	const key = sortKey(view.days);
	const { rows, nextCursor } = await collect(entries, view, "asc", (row) => {
		if (row[key] > 0) return "stop";
		return isPublished(row) ? "take" : "skip";
	});
	return { ...base, items: rows.map((row) => toolEntry(row, view.days, state)), ...(nextCursor && { nextCursor }) };
}

/**
 * Up to `view.limit` rows in view order, read past the ones `verdict`
 * skips, and the caller's cursor for the rest.
 *
 * Rows kept for history after an unpublish, a delete or a move sort in
 * among the published ones, so a single page can come back with few items
 * or none. Each read therefore takes at least `SCAN_ROWS` rows. A storage
 * cursor can only point past the end of a page, so when the page fills
 * before a read is used up, the same read is repeated up to the last row
 * taken: the next call then starts right after it.
 */
async function collect(
	entries: Typed<EntryRow>,
	view: ListInput,
	dir: "asc" | "desc",
	verdict: (row: EntryRow) => "take" | "skip" | "stop",
): Promise<{ rows: EntryRow[]; nextCursor?: string }> {
	const rows: EntryRow[] = [];
	const next = (page: { hasMore: boolean; cursor?: string }) =>
		page.hasMore && page.cursor ? { rows, nextCursor: ownCursor(view, page.cursor) } : { rows };
	let cursor = view.cursor;
	for (let i = 0; i < LIST_PAGES; i++) {
		const spec = {
			...(view.collection ? { where: { collection: view.collection } } : {}),
			orderBy: { [sortKey(view.days)]: dir },
			...(cursor ? { cursor } : {}),
		};
		const page = await entries.query({ ...spec, limit: Math.min(BIND_LIMIT, Math.max(view.limit - rows.length, SCAN_ROWS)) });
		for (const [index, { data }] of page.items.entries()) {
			const decision = verdict(data);
			if (decision === "stop") return { rows };
			if (decision === "skip") continue;
			rows.push(data);
			if (rows.length < view.limit) continue;

			const following = page.items[index + 1];
			if (!following) return next(page);
			if (verdict(following.data) === "stop") return { rows };
			return next(await entries.query({ ...spec, limit: index + 1 }));
		}
		if (!page.hasMore || !page.cursor) return { rows };
		cursor = page.cursor;
	}
	return { rows, nextCursor: ownCursor(view, cursor!) };
}

/**
 * One entry's views and its published translations', found by entry id
 * or by the path the site serves it under.
 * Calls: state, the oldest stored day, the path lookup, then the
 * panel's two queries.
 */
export async function entryViews(ctx: PluginContext, input: unknown, now: Date): Promise<EntryViewsResult> {
	const record = asRecord(input);
	const [state, historySince] = await Promise.all([readState(ctx), oldestDay(dailyStore(ctx))]);
	const today = utcDay(now);
	const base = {
		windows: { views7: windowOf(7, today, historySince), views30: windowOf(30, today, historySince) },
		historySince,
		indexComplete: indexComplete(state),
		lastSync: state.lastSync ?? null,
	};
	const missing = { ...base, found: false, entry: null, translations: [], allLanguages: null };

	let entryId = boundedString(record.entryId, MAX_ENTRY_ID);
	const path = boundedString(record.path, MAX_PATH);
	if (!entryId && path) {
		const row = await entriesStore(ctx)?.get(normalizePath(path, ctx.site.trailingSlash));
		entryId = row?.entryId;
	}
	if (!entryId) return missing;

	const { current, members } = await loadPanel(ctx, entryId, state, now);
	if (!current) return missing;

	const others = members
		.filter((row) => row.entryId !== current.entryId)
		.sort((a, b) => a.locale.localeCompare(b.locale));
	// An entry that is no longer published keeps its last path's numbers,
	// but they are not part of what the site serves now.
	const live = [current, ...others].filter(isPublished);
	const translations = others.map((row) => ({
		entryId: row.entryId,
		title: row.title,
		locale: row.locale,
		path: row.path,
		views7: row.views7,
		views30: row.views30,
	}));
	return {
		...base,
		found: true,
		entry: {
			entryId: current.entryId,
			title: current.title,
			collection: current.collection,
			collectionLabel: labelOf(current.collection, state),
			locale: current.locale,
			path: current.path,
			status: current.status,
			views7: current.views7,
			views30: current.views30,
			...(current.publishedAt && { publishedAt: current.publishedAt }),
		},
		translations,
		allLanguages: {
			views7: live.reduce((sum, row) => sum + row.views7, 0),
			views30: live.reduce((sum, row) => sum + row.views30, 0),
		},
	};
}

/**
 * Site-wide visits and page views over the window and the equal period
 * before it, from the stored daily rollups.
 * Calls: state, the oldest stored day, up to two rollup pages.
 */
export async function siteTotals(ctx: PluginContext, input: unknown, now: Date): Promise<SiteTotalsResult> {
	const days = pickDays(asRecord(input).days, TOTALS_DAYS);
	const rollup = rollupStore(ctx);
	const [state, historySince] = await Promise.all([readState(ctx), oldestDay(rollup)]);
	const today = utcDay(now);
	const window = windowOf(days, today, historySince);

	const stored: RollupRow[] = [];
	let cursor: string | undefined;
	for (let i = 0; rollup && i < ROLLUP_PAGES; i++) {
		const page = await rollup.query({
			where: { date: { gte: addDays(today, -(days * 2 - 1)) } },
			orderBy: { date: "asc" },
			limit: BIND_LIMIT,
			...(cursor ? { cursor } : {}),
		});
		stored.push(...page.items.map((item) => item.data));
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}

	const previousSince = addDays(today, -(days * 2 - 1));
	const previousUntil = addDays(today, -days);
	const current = sumWindow(stored.filter((row) => within(row.date, window.since, today)), today);
	// A comparison the store covers only in part would set a few days
	// against a whole period.
	const before =
		historySince !== null && daysBetween(historySince, previousSince) >= 0
			? sumWindow(stored.filter((row) => within(row.date, previousSince, previousUntil)), today)
			: null;

	return {
		window,
		visits: current.visits,
		pageviews: current.pageviews,
		estimated: current.estimated,
		provisional: current.provisional,
		previous: before && {
			since: previousSince,
			until: previousUntil,
			visits: before.visits,
			pageviews: before.pageviews,
			estimated: before.estimated,
		},
		engagement: engagementResult(stored, window.since, today, previousSince, previousUntil),
		historySince,
		lastSync: state.lastSync ?? null,
	};
}

function engagementResult(
	stored: RollupRow[],
	since: Day,
	today: Day,
	previousSince: Day,
	previousUntil: Day,
): SiteTotalsResult["engagement"] {
	const current = engagementOver(stored.filter((row) => within(row.date, since, today)));
	if (!current) return null;
	const before = engagementReaches(stored, previousSince)
		? engagementOver(stored.filter((row) => within(row.date, previousSince, previousUntil)))
		: null;
	const figures = (e: Engagement) => ({
		bounceRate: round(e.bounceRate, 4),
		averageVisitSeconds: round(e.averageVisit, 1),
		pagesPerVisit: round(e.pagesPerVisit, 2),
	});
	return { since: current.since, ...figures(current), previous: before && figures(before) };
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

async function listContext(ctx: PluginContext) {
	const [state, historySince] = await Promise.all([readState(ctx), oldestDay(dailyStore(ctx))]);
	return { state, historySince, entries: entriesStore(ctx) };
}

function listBase(view: ListInput, state: SyncState, historySince: Day | null, today: Day) {
	return {
		window: windowOf(view.days, today, historySince),
		collection: view.collection,
		historySince,
		indexComplete: indexComplete(state),
		lastSync: state.lastSync ?? null,
	};
}

/** A rebuild re-matches pages to entries, so the index is not complete while one runs. */
function indexComplete(state: SyncState): boolean {
	return Boolean(state.indexComplete) && !indexOutdated(state);
}

function windowOf(days: number, today: Day, historySince: Day | null): ToolWindow {
	const since = addDays(today, -(days - 1));
	return { days, since, until: today, partial: historySince === null || daysBetween(since, historySince) > 0 };
}

function toolEntry(row: EntryRow, days: ListInput["days"], state: SyncState): ToolEntry {
	return {
		entryId: row.entryId,
		title: row.title,
		collection: row.collection,
		collectionLabel: labelOf(row.collection, state),
		locale: row.locale,
		path: row.path,
		views: row[sortKey(days)],
		...(row.publishedAt && { publishedAt: row.publishedAt }),
	};
}

function labelOf(collection: string, state: SyncState): string {
	return state.collectionLabels?.[collection] ?? collection;
}

function sortKey(days: ListInput["days"]): "views7" | "views30" {
	return days === 7 ? "views7" : "views30";
}

function within(day: Day, since: Day, until: Day): boolean {
	return daysBetween(since, day) >= 0 && daysBetween(day, until) >= 0;
}

function asRecord(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/** Numbers arrive as strings from a query string, so both are accepted. */
function pickDays<T extends number>(value: unknown, allowed: readonly T[]): T {
	const n = typeof value === "string" ? Number(value) : value;
	return (allowed as readonly unknown[]).includes(n) ? (n as T) : (DEFAULT_DAYS as T);
}

function limitOf(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
	return Math.min(n, MAX_LIMIT);
}

function slugOf(value: unknown): string | null {
	return typeof value === "string" && value.length <= MAX_COLLECTION && COLLECTION_SLUG.test(value) ? value : null;
}

function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}
