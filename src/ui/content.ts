/**
 * The per-entry page: every published entry with its 7- and 30-day views.
 *
 * This is the page the join exists for. Cloudflare's own dashboard lists
 * paths that got traffic; this lists the site's entries, including the
 * ones that got none, which is the list an editor can act on.
 *
 * Block Kit keeps no state between interactions, so the view (collection,
 * sort, mode) travels in every control's `action_id`, and the position in
 * the table's cursor. The table's sortable headers and its "Load more"
 * send only `{ sort, cursor }`, which is why the rest has to be in the id.
 * "Load more" replaces the table rather than appending to it: the response
 * is a whole new page of blocks.
 *
 * Two modes:
 *
 * - **Each language** sorts server-side on the indexed `views7`/`views30`
 *   columns and pages with the storage cursor, so it scales with the site.
 *   Each row also carries its translations' 30-day total.
 * - **Languages combined** shows one row per translation group. A group
 *   total is not stored, so it cannot be sorted in storage: the page reads
 *   up to `COMBINED_READ` entries in the chosen order, groups and sorts
 *   those, and says so when there were more.
 */

import type { PluginContext } from "emdash/plugin";

import { readsFor, type ReadSnapshot } from "../sync/reads.js";

import { langOf, t, type Lang } from "../i18n.js";
import { dailyStore, entriesStore, oldestDay, BIND_LIMIT, type Typed } from "../store/access.js";
import { isPublished, type EntryRow } from "../store/rows.js";
import { indexOutdated, type SyncState } from "../sync/scheduler.js";
import { addDays, daysBetween, utcDay, type Day } from "../sync/window.js";
import { actions, button, context, empty, link, table, type AnalyticsBlock } from "./blocks.js";
import { formatCount, formatDay } from "./format.js";
import { PAGE_PATH } from "./page.js";
import { statusLine } from "./status.js";

export const CONTENT_PATH = "/analytics/content";
export const VIEW_ACTION = "analytics:content:view";
export const TABLE_ACTION = "analytics:content:table";
export const REBUILD_ACTION = "analytics:content:rebuild";

/**
 * Rows per table page. A sandboxed response is capped at 2 000 nodes and
 * 256 KiB, and a row here has up to eight cells.
 */
export const PAGE_ROWS = 50;

/** Entries the combined mode reads: three storage pages. */
export const COMBINED_READ = 3 * BIND_LIMIT;

/** Pages of translations read to total the groups on one table page. */
const MEMBER_PAGES = 2;

export type SortKey = "views7" | "views30";

export interface ContentView {
	/** A collection slug, or null for all routable collections. */
	collection: string | null;
	sort: SortKey;
	dir: "asc" | "desc";
	mode: "entries" | "combined";
	/** Rows before this table page, for the "Entries 51 to 100" line. */
	offset: number;
	/** The storage cursor of this table page; combined mode pages in memory. */
	cursor?: string;
}

export const DEFAULT_VIEW: ContentView = { collection: null, sort: "views30", dir: "desc", mode: "entries", offset: 0 };

export interface ContentRow {
	title: string;
	collection: string;
	locale: string;
	path: string;
	views7: number;
	views30: number;
	/** 30-day views of every published translation, this entry included. */
	allLanguages?: number;
	/** Combined mode: each language's views in the sort's window, "de 30 · en 12". */
	byLanguage?: string;
	publishedAt?: string;
}

export interface ContentInput {
	view: ContentView;
	state: SyncState;
	collections: Array<{ slug: string; label: string }>;
	rows: ContentRow[];
	/** The table's `next_cursor`, when there is another page. */
	nextCursor?: string;
	/** True when the rows show more than one language. */
	multilingual: boolean;
	/** The oldest stored day, when the store has any. */
	historySince?: Day;
	/** Combined mode: how many entries were read when more existed. */
	partial?: number;
	/** Where an index walk stands, while one runs. */
	indexing?: { at: number; total: number; rebuilding: boolean };
	now: Date;
	locale?: string;
}

/**
 * The view an interaction asks for, and whether it asks for a rebuild.
 * Anything unrecognised gets the default view rather than an error.
 */
export function parseContentInput(input: Record<string, unknown>): { view: ContentView; rebuild: boolean } {
	const id = typeof input.action_id === "string" ? input.action_id : "";
	if (input.type !== "block_action" || !id) return { view: DEFAULT_VIEW, rebuild: false };

	const cut = id.indexOf("|");
	const base = cut < 0 ? id : id.slice(0, cut);
	const view = decodeView(cut < 0 ? "" : id.slice(cut + 1));

	if (base === REBUILD_ACTION) return { view, rebuild: true };
	if (base === VIEW_ACTION) return { view, rebuild: false };
	if (base !== TABLE_ACTION) return { view: DEFAULT_VIEW, rebuild: false };

	const value = typeof input.value === "object" && input.value !== null ? (input.value as Record<string, unknown>) : {};
	const sort = sortOf(value.sort);
	const position = typeof value.cursor === "string" ? decodeCursor(value.cursor) : { offset: 0 };
	return { view: { ...view, ...(sort ?? {}), ...position }, rebuild: false };
}

export function viewAction(view: ContentView): string {
	return `${VIEW_ACTION}|${encodeView(view)}`;
}

/**
 * Gather the page. Calls: the schema's collection list, the oldest stored
 * day, then either one entries page and up to two pages of translations,
 * or up to three entries pages for the combined mode.
 */
export async function loadContent(
	ctx: PluginContext,
	requested: ContentView,
	state: SyncState,
	now: Date,
	locale?: string,
): Promise<ContentInput> {
	const routable = ctx.schema
		? (await ctx.schema.listCollections())
				.filter((c) => c.routable && !c.hidden)
				.map((c) => ({ slug: c.slug, label: c.label || c.slug }))
				.sort((a, b) => a.slug.localeCompare(b.slug))
		: [];

	// A collection that is gone, or never was routable, falls back to all.
	const collection =
		requested.collection && routable.some((c) => c.slug === requested.collection) ? requested.collection : null;
	const view = { ...requested, collection };

	const historySince = await oldestDay(dailyStore(ctx));
	const base = {
		state,
		collections: routable,
		...(historySince && { historySince }),
		indexing: indexingOf(state, routable.map((c) => c.slug)),
		now,
		locale,
	};

	const entries = entriesStore(ctx);
	if (!entries) return { ...base, view, rows: [], multilingual: false };

	const where = collection ? { where: { collection } } : {};
	const siteLocale = ctx.site.locale;

	if (view.mode === "combined") {
		const read: EntryRow[] = [];
		let cursor: string | undefined;
		let more = false;
		for (let i = 0; i < COMBINED_READ / BIND_LIMIT; i++) {
			const page = await entries.query({
				...where,
				orderBy: { [view.sort]: view.dir },
				limit: BIND_LIMIT,
				...(cursor ? { cursor } : {}),
			});
			read.push(...page.items.map((item) => item.data));
			more = page.hasMore && Boolean(page.cursor);
			if (!more) break;
			cursor = page.cursor;
		}

		const groups = combine(published(read), view, siteLocale, locale);
		const rows = groups.slice(view.offset, view.offset + PAGE_ROWS);
		const end = view.offset + rows.length;
		return {
			...base,
			view,
			rows,
			...(end < groups.length && { nextCursor: encodeCursor(end) }),
			multilingual: true,
			...(more && { partial: read.length }),
		};
	}

	const page = await entries.query({
		...where,
		orderBy: { [view.sort]: view.dir },
		limit: PAGE_ROWS,
		...(view.cursor ? { cursor: view.cursor } : {}),
	});
	const shown = published(page.items.map((item) => item.data));
	const members = await readMembers(entries, [...new Set(shown.map((row) => row.translationGroup))]);

	const rows = shown.map((row) => ({
		...rowOf(row),
		allLanguages: (members.get(row.translationGroup) ?? [row]).reduce((sum, m) => sum + m.views30, 0),
	}));
	// More than one language in sight, not "a locale other than the site's":
	// `ctx.site.locale` is not the content's default language everywhere
	// (on eisbachcode.de, whose default is de, it is not "de").
	const multilingual =
		[...members.values()].some((group) => group.length > 1) || new Set(shown.map((row) => row.locale)).size > 1;

	return {
		...base,
		view,
		rows,
		// Counted in rows shown, so "Entries 51 to 100" matches what the reader
		// saw; unpublished rows the page skipped do not count.
		...(page.hasMore && page.cursor && { nextCursor: encodeCursor(view.offset + shown.length, page.cursor) }),
		multilingual,
	};
}

export function renderContent(input: ContentInput): AnalyticsBlock[] {
	const { view, state, now } = input;
	const lang = langOf(input.locale);
	const out: AnalyticsBlock[] = [collectionButtons(input, lang), controls(input, lang)];

	const notes = [
		t(lang, view.dir === "desc" ? "sortMostViewed" : "sortLeastViewed", { days: windowOf(view.sort) }),
		...(view.offset > 0 || input.nextCursor
			? [t(lang, "showingRows", { from: view.offset + 1, to: view.offset + input.rows.length })]
			: []),
		...historyNote(input, lang),
		...(input.partial ? [t(lang, "combinedPartial", { count: input.partial })] : []),
	];
	out.push(context(notes.join(" ")));

	if (input.indexing) {
		const { at, total, rebuilding } = input.indexing;
		out.push(context(t(lang, rebuilding ? "rebuildingAt" : "indexingAt", { at, total })));
	}
	const status = statusLine(state, now, lang, {});
	if (status) out.push(context(status));

	if (input.rows.length === 0 && view.offset === 0 && view.collection === null) {
		out.push(
			empty({
				title: t(lang, "noEntriesYet"),
				description: t(lang, state.indexComplete ? "noEntriesNoUrls" : "noEntriesIndexing"),
			}),
		);
		return out;
	}

	out.push(entryTable(input, lang));
	return out;
}

function collectionButtons(input: ContentInput, lang: Lang) {
	const { view } = input;
	// Buttons rather than a select: the host's select shows the raw value
	// when closed. Sites rarely route more than a handful of collections,
	// and the row wraps when they do.
	const choices: Array<{ slug: string | null; label: string }> = [
		{ slug: null, label: t(lang, "allCollections") },
		...input.collections,
	];
	return actions(
		choices.map((choice) =>
			button(viewAction({ ...view, collection: choice.slug, offset: 0, cursor: undefined }), choice.label, {
				style: choice.slug === view.collection ? "primary" : "secondary",
			}),
		),
		{ blockId: "analytics:content:collections" },
	);
}

function controls(input: ContentInput, lang: Lang) {
	const { view } = input;
	const start = { ...view, offset: 0, cursor: undefined };
	const elements = [
		...(input.multilingual || view.mode === "combined"
			? (["entries", "combined"] as const).map((mode) =>
					button(viewAction({ ...start, mode }), t(lang, mode === "entries" ? "modeEntries" : "modeCombined"), {
						style: mode === view.mode ? "primary" : "secondary",
					}),
				)
			: []),
		...(view.offset > 0 ? [button(viewAction(start), t(lang, "firstPage"), { style: "secondary" })] : []),
		button(`${REBUILD_ACTION}|${encodeView(view)}`, t(lang, "rebuildIndex"), { style: "secondary" }),
		link(t(lang, "overview"), { kind: "plugin-page", path: PAGE_PATH }, { appearance: "secondary" }),
	];
	return actions(elements, { blockId: "analytics:content:controls" });
}

function entryTable(input: ContentInput, lang: Lang) {
	const { view } = input;
	const labels = new Map(input.collections.map((c) => [c.slug, c.label]));
	const combined = view.mode === "combined";
	const showCollection = view.collection === null;
	const showLanguage = input.multilingual && !combined;
	// Reads beside the 30-day views they belong to, one column per depth.
	// Not in the combined view, whose rows are groups of entries.
	const reads = combined ? undefined : input.state.reads;

	return table({
		blockId: "analytics:content:entries",
		// The view rides in the id: sorting and "Load more" send only
		// `{ sort, cursor }`.
		pageActionId: `${TABLE_ACTION}|${encodeView(view)}`,
		...(input.nextCursor !== undefined && { nextCursor: input.nextCursor }),
		columns: [
			{ key: "entry", label: t(lang, "colEntry"), format: "text" },
			...(showLanguage ? [{ key: "language", label: t(lang, "colLanguage"), format: "badge" as const }] : []),
			...(showCollection ? [{ key: "collection", label: t(lang, "colCollection"), format: "badge" as const }] : []),
			{ key: "path", label: t(lang, "colPath"), format: "code" },
			...(combined
				? [{ key: "byLanguage", label: t(lang, "colByLanguage", { days: windowOf(view.sort) }), format: "text" as const }]
				: []),
			{ key: "views7", label: t(lang, "col7Days"), format: "number", sortable: true },
			{ key: "views30", label: t(lang, "col30Days"), format: "number", sortable: true },
			...(showLanguage ? [{ key: "allLanguages", label: t(lang, "colAllLanguages"), format: "number" as const }] : []),
			...(reads?.depths.map((depth, i) => ({ key: `read${i}`, label: t(lang, "colReadTo", { depth }), format: "number" as const })) ??
				[]),
			{ key: "published", label: t(lang, "colPublished"), format: "text" },
		],
		rows: input.rows.map((row) => ({
			entry: row.title || "—",
			language: row.locale,
			collection: labels.get(row.collection) ?? row.collection,
			path: row.path,
			byLanguage: row.byLanguage ?? "",
			views7: row.views7,
			views30: row.views30,
			allLanguages: row.allLanguages ?? row.views30,
			...readCells(reads, row.path),
			published: row.publishedAt ? formatDay(row.publishedAt.slice(0, 10), lang) : "",
		})),
		emptyText: t(lang, "noEntriesHere"),
	});
}

/**
 * An entry's reads per depth as table cells. An entry the snapshot does not
 * list had no reads, unless the provider cut the list short, and then it
 * is left blank rather than shown as zero.
 */
function readCells(reads: ReadSnapshot | undefined, path: string): Record<string, number | string> {
	if (!reads) return {};
	const counts = readsFor(reads, path);
	return Object.fromEntries(
		reads.depths.map((_, i) => [`read${i}`, counts ? (counts[i] ?? 0) : reads.partial ? "" : 0]),
	);
}

/**
 * One row per translation group, sorted by the group's total in the
 * view's window. The row is named after the group's original, the entry
 * the others were translated from: its id is the group id. Without it in
 * the rows read, the site-locale version, then the most viewed.
 */
export function combine(rows: EntryRow[], view: ContentView, siteLocale: string, readerLocale?: string): ContentRow[] {
	const groups = new Map<string, EntryRow[]>();
	for (const row of rows) groups.set(row.translationGroup, [...(groups.get(row.translationGroup) ?? []), row]);

	const out: ContentRow[] = [];
	for (const members of groups.values()) {
		const ranked = [...members].sort((a, b) => b[view.sort] - a[view.sort] || a.locale.localeCompare(b.locale));
		const lead =
			members.find((m) => m.entryId === m.translationGroup) ??
			members.find((m) => m.locale === siteLocale) ??
			ranked[0]!;
		out.push({
			...rowOf(lead),
			views7: sum(members, "views7"),
			views30: sum(members, "views30"),
			byLanguage: ranked.map((m) => `${m.locale} ${formatCount(m[view.sort], readerLocale)}`).join(" · "),
		});
	}

	const sign = view.dir === "desc" ? -1 : 1;
	return out.sort((a, b) => sign * (a[view.sort] - b[view.sort]) || a.path.localeCompare(b.path));
}

function rowOf(row: EntryRow): ContentRow {
	return {
		title: row.title,
		collection: row.collection,
		locale: row.locale,
		path: row.path,
		views7: row.views7,
		views30: row.views30,
		...(row.publishedAt && { publishedAt: row.publishedAt }),
	};
}

function published(rows: EntryRow[]): EntryRow[] {
	return rows.filter(isPublished);
}

/** Every published translation of the given groups, by group. */
async function readMembers(entries: Typed<EntryRow>, groups: string[]): Promise<Map<string, EntryRow[]>> {
	const out = new Map<string, EntryRow[]>();
	if (groups.length === 0) return out;
	let cursor: string | undefined;
	for (let i = 0; i < MEMBER_PAGES; i++) {
		const page = await entries.query({
			where: { translationGroup: { in: groups } },
			limit: BIND_LIMIT,
			...(cursor ? { cursor } : {}),
		});
		for (const { data } of page.items) {
			if (data.status !== "published") continue;
			out.set(data.translationGroup, [...(out.get(data.translationGroup) ?? []), data]);
		}
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	return out;
}

function historyNote(input: ContentInput, lang: Lang): string[] {
	if (!input.historySince) return [];
	const thirtyStart = addDays(utcDay(input.now), -29);
	if (daysBetween(thirtyStart, input.historySince) <= 0) return [];
	return [t(lang, "historyThirty", { date: formatDay(input.historySince, lang) })];
}

/** Where a running index walk stands, or undefined when none runs. */
function indexingOf(state: SyncState, slugs: string[]): ContentInput["indexing"] {
	const rebuilding = Boolean(state.indexComplete) && indexOutdated(state);
	if (state.indexComplete && !rebuilding) return undefined;
	const total = slugs.length;
	if (total === 0) return undefined;
	const current = state.index?.collection;
	const at = current ? slugs.filter((slug) => slug <= current).length : 1;
	return { at: Math.max(1, Math.min(at, total)), total, rebuilding };
}

function sum(rows: EntryRow[], key: SortKey): number {
	return rows.reduce((total, row) => total + row[key], 0);
}

function windowOf(sort: SortKey): number {
	return sort === "views7" ? 7 : 30;
}

function sortOf(value: unknown): Pick<ContentView, "sort" | "dir"> | null {
	if (typeof value !== "object" || value === null) return null;
	const { key, dir } = value as Record<string, unknown>;
	if (key !== "views7" && key !== "views30") return null;
	return { sort: key, dir: dir === "asc" ? "asc" : "desc" };
}

/** The view minus its position, as it travels in an action id. */
function encodeView(view: ContentView): string {
	return [view.collection ?? "", view.sort, view.dir, view.mode].map(encodeURIComponent).join("|");
}

function decodeView(encoded: string): ContentView {
	const [collection, sort, dir, mode] = encoded.split("|").map(decodeOnce);
	return {
		collection: collection && /^[a-z][a-z0-9_]*$/.test(collection) ? collection : null,
		sort: sort === "views7" ? "views7" : "views30",
		dir: dir === "asc" ? "asc" : "desc",
		mode: mode === "combined" ? "combined" : "entries",
		offset: 0,
	};
}

function encodeCursor(offset: number, cursor?: string): string {
	return `${offset}~${cursor ?? ""}`;
}

function decodeCursor(value: string): { offset: number; cursor?: string } {
	const cut = value.indexOf("~");
	const offset = Number(cut < 0 ? value : value.slice(0, cut));
	const cursor = cut < 0 ? "" : value.slice(cut + 1);
	return {
		offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
		...(cursor && { cursor }),
	};
}

function decodeOnce(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return "";
	}
}
