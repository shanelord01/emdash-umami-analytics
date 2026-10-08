/**
 * The analytics page: the widget's numbers with room to breathe.
 *
 * Unlike the widget, the page asks the provider live, once per load: it is
 * opened on purpose, and a fresh install would otherwise show nothing
 * until the sync has caught up, which takes hours to days. The live read
 * never reaches past the provider's exact window: measured on
 * eisbachcode.de, a sampled 30-day query reported 300 page views on one
 * day for a week that had 25 over five. Older days come from the store
 * only, so a young install shows a shorter history rather than a wrong
 * one. Block Kit keeps no state between interactions, so the chosen range
 * travels in the range buttons' and the refresh button's `value`.
 *
 * When the live read fails, the page falls back to the store alone, and
 * two limits shape what it can honestly show:
 *
 * - Per-entry numbers live in `daily`, one row per path and day, written
 *   only from the day the plugin started syncing that entry. The entry
 *   table therefore says which days it covers instead of implying the full
 *   range.
 * - Referrers and countries are a snapshot of the latest overview window,
 *   not a per-day store, so they are labelled with the day they start.
 */

import type { PluginContext } from "emdash/plugin";

import { entriesStore, dailyStore, rollupStore, BIND_LIMIT } from "../store/access.js";
import type { LabelledRow, Overview, PropertyBreakdown, Provider } from "../providers/types.js";
import { historyReaches, sumWindow, type EntryRow, type RollupRow } from "../store/rows.js";
import type { SyncState } from "../sync/scheduler.js";
import { addDays, dayStartMs, daysBetween, localDay, stateZone, type Day } from "../sync/window.js";
import {
	actions,
	button,
	columns,
	context,
	empty,
	header,
	link,
	stats,
	table,
	timeseries,
	type AnalyticsBlock,
} from "./blocks.js";
import { langOf, t, type Lang } from "../i18n.js";
import { comparisonText, formatCount, formatDay, trendOf } from "./format.js";
import { emptyReason, statusLine } from "./status.js";
import { engagementSection, readsChart } from "./engagement.js";

export const PAGE_PATH = "/analytics";
/** The per-entry page (`./content.ts`), named here to keep the import one-way. */
const CONTENT_PAGE_PATH = "/analytics/content";
export const RANGE_ACTION = "analytics:range";
export const PAGE_REFRESH_ACTION = "analytics:page:refresh";
/** Opens the setup check (`./setup.ts`), carrying the range to return to. */
export const SETUP_ACTION = "analytics:setup";

const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const DEFAULT_RANGE: RangeDays = 30;

const TOP_ENTRIES = 20;
/** Rollup pages per render: the range plus the previous period, at most 180 days. */
const ROLLUP_PAGES = 2;
/**
 * Daily pages per render. Each is one bridge call in the sandbox, which
 * allows ten per invocation; three leave room for the rest of the load.
 */
const DAILY_PAGES = 3;

export function parseRange(value: unknown): RangeDays {
	const n = typeof value === "string" ? Number(value) : value;
	return (RANGES as readonly unknown[]).includes(n) ? (n as RangeDays) : DEFAULT_RANGE;
}

export interface EntryTotals {
	path: string;
	pageviews: number;
	visits: number;
}

export interface TopEntries {
	rows: EntryTotals[];
	/** Oldest day the totals include; absent when nothing was read. */
	coveredSince?: Day;
	/** True when the read budget ran out before the start of the range. */
	partial: boolean;
}

export interface PageInput {
	state: SyncState;
	range: RangeDays;
	/** Rollups for the range and the equal period before it. */
	rollups: RollupRow[];
	topEntries: TopEntries;
	entriesByPath: Map<string, EntryRow>;
	/** The provider's own dashboard, or null when it has none (demo data). */
	dashboardUrl: string | null;
	/**
	 * Referrers and countries from the live answer, and the first day it
	 * covers, which is later than the range start for long ranges.
	 */
	breakdowns?: {
		referrers: LabelledRow[];
		countries: LabelledRow[];
		since: Day;
		/** Page views by event data property, when the provider read them. */
		properties?: PropertyBreakdown[];
	};
	now: Date;
	locale?: string;
}

/**
 * Gather the page. Calls: the live read (one fetch), up to two rollup
 * pages, one entries lookup; without a live answer, up to three daily
 * pages as well.
 *
 * Event data breakdowns come with the live read, in the same number of
 * requests (see `OverviewOptions`), and are shown only when it answers.
 *
 * A provider whose overview is several requests counts them (`requests`).
 * When such a read fails after the first request, each further one it
 * sent takes a daily page away, so the fallback still fits the budget.
 */
export async function loadPage(
	ctx: PluginContext,
	state: SyncState,
	range: RangeDays,
	now: Date,
	dashboardUrl: string | null,
	locale?: string,
	provider?: Provider | null,
	properties: string[] = [],
): Promise<PageInput> {
	const today = localDay(now, stateZone(state));

	const rangeStart = addDays(today, -(range - 1));
	// One day short of the exact window: measured on eisbachcode.de,
	// Cloudflare answers a query reaching back to today - 7 in about 1.1 s
	// and one starting at today - 6 in about 0.1 s. The day in between is
	// in the store from the first sync.
	const exactStart = provider ? addDays(today, -(provider.capabilities.exactWindowDays - 1)) : rangeStart;
	const liveSince = daysBetween(rangeStart, exactStart) > 0 ? exactStart : rangeStart;
	const live = provider ? await provider.overview({ since: liveSince, until: today }, { properties }) : null;

	const stored: RollupRow[] = [];
	const rollup = rollupStore(ctx);
	let rollupCursor: string | undefined;
	for (let i = 0; rollup && i < ROLLUP_PAGES; i++) {
		const page = await rollup.query({
			where: { date: { gte: addDays(today, -(range * 2 - 1)) } },
			orderBy: { date: "asc" },
			limit: BIND_LIMIT,
			...(rollupCursor ? { cursor: rollupCursor } : {}),
		});
		stored.push(...page.items.map((item) => item.data));
		if (!page.hasMore || !page.cursor) break;
		rollupCursor = page.cursor;
	}

	const entries = entriesStore(ctx);
	const lookup = async (top: TopEntries) => {
		const paths = top.rows.map((row) => row.path);
		return paths.length > 0 && entries ? await entries.getMany(paths) : new Map<string, EntryRow>();
	};

	if (live?.ok) {
		const topEntries: TopEntries = {
			rows: live.value.topPaths
				.slice(0, TOP_ENTRIES)
				.map((p) => ({ path: p.path, pageviews: p.pageviews, visits: p.visits })),
			...(liveSince !== rangeStart && { coveredSince: liveSince }),
			partial: liveSince !== rangeStart,
		};
		return {
			state,
			range,
			rollups: mergeDays(stored, live.value, now),
			topEntries,
			entriesByPath: await lookup(topEntries),
			dashboardUrl,
			breakdowns: {
				referrers: live.value.referrers,
				countries: live.value.countries,
				since: liveSince,
				...(live.value.properties && { properties: live.value.properties }),
			},
			now,
			locale,
		};
	}

	const dailyRows: Array<{ date: Day; path: string; pageviews: number; visits: number }> = [];
	const daily = dailyStore(ctx);
	const dailyPages = Math.max(0, DAILY_PAGES - Math.max(0, (provider?.requests?.() ?? 1) - 1));
	let dailyCursor: string | undefined;
	let hasMore = false;
	for (let i = 0; daily && i < dailyPages; i++) {
		const page = await daily.query({
			where: { date: { gte: addDays(today, -(range - 1)) } },
			orderBy: { date: "desc" },
			limit: BIND_LIMIT,
			...(dailyCursor ? { cursor: dailyCursor } : {}),
		});
		dailyRows.push(...page.items.map((item) => item.data));
		hasMore = page.hasMore && Boolean(page.cursor);
		if (!hasMore) break;
		dailyCursor = page.cursor;
	}

	const topEntries = summarizeDaily(dailyRows, hasMore);
	return {
		state,
		range,
		rollups: stored,
		topEntries,
		entriesByPath: await lookup(topEntries),
		dashboardUrl,
		now,
		locale,
	};
}

/**
 * One row per day: the live answer where it has the day, being the newer
 * of the two, and the store for every day before the live window.
 */
export function mergeDays(stored: RollupRow[], live: Overview, now: Date): RollupRow[] {
	const byDay = new Map<Day, RollupRow>();
	for (const row of live.series) {
		byDay.set(row.date, { ...row, fetchedAt: now.toISOString() });
	}
	for (const row of stored) {
		if (!byDay.has(row.date)) byDay.set(row.date, row);
	}
	return [...byDay.values()];
}

/**
 * Per-path totals from daily rows read newest first.
 *
 * When the read stopped with more rows left, the oldest day in hand may be
 * missing some paths, so it is dropped rather than undercounted.
 */
export function summarizeDaily(
	rows: Array<{ date: Day; path: string; pageviews: number; visits: number }>,
	hasMore: boolean,
): TopEntries {
	let usable = rows;
	if (hasMore && rows.length > 0) {
		const oldest = rows.reduce((min, row) => (daysBetween(row.date, min) > 0 ? row.date : min), rows[0]!.date);
		usable = rows.filter((row) => row.date !== oldest);
	}

	const byPath = new Map<string, EntryTotals>();
	let coveredSince: Day | undefined;
	for (const row of usable) {
		const acc = byPath.get(row.path) ?? { path: row.path, pageviews: 0, visits: 0 };
		acc.pageviews += row.pageviews;
		acc.visits += row.visits;
		byPath.set(row.path, acc);
		if (coveredSince === undefined || daysBetween(row.date, coveredSince) > 0) coveredSince = row.date;
	}

	const sorted = [...byPath.values()]
		.sort((a, b) => b.pageviews - a.pageviews || a.path.localeCompare(b.path))
		.slice(0, TOP_ENTRIES);
	return { rows: sorted, ...(coveredSince !== undefined && { coveredSince }), partial: hasMore };
}

export function renderPage(input: PageInput): AnalyticsBlock[] {
	const { state, range, rollups, now, locale } = input;
	const lang = langOf(locale);
	const zone = stateZone(state);
	const today = localDay(now, zone);

	if (rollups.length === 0) {
		return [
			empty({
				title: t(lang, "noAnalyticsYet"),
				description: emptyReason(state, now, lang),
				actions: [refreshButton(range, lang), setupButton(range, lang)],
			}),
		];
	}

	const inRange = rollups.filter((r) => within(r.date, addDays(today, -(range - 1)), today));
	const before = rollups.filter((r) => within(r.date, addDays(today, -(range * 2 - 1)), addDays(today, -range)));
	const current = sumWindow(inRange, today);
	const previous = historyReaches(rollups, addDays(today, -(range * 2 - 1))) ? sumWindow(before, today) : null;

	const out: AnalyticsBlock[] = [controls(input, lang)];

	const visitsTrend = trendOf(current.visits, previous?.visits ?? null);
	const viewsTrend = trendOf(current.pageviews, previous?.pageviews ?? null);
	out.push(
		stats([
			{
				label: t(lang, "visitsLastDays", { days: range }),
				value: formatCount(current.visits, lang),
				description: comparisonText(current.visits, previous?.visits ?? null, lang),
				...(visitsTrend ? { trend: visitsTrend } : {}),
			},
			{
				label: t(lang, "pageviewsLastDays", { days: range }),
				value: formatCount(current.pageviews, lang),
				description: comparisonText(current.pageviews, previous?.pageviews ?? null, lang),
				...(viewsTrend ? { trend: viewsTrend } : {}),
			},
		]),
	);

	const days = [...inRange].sort((a, b) => daysBetween(b.date, a.date));
	// Each point sits at its day's local midnight, which the chart shows as
	// that day to a reader in the site's time zone.
	const at = (day: Day) => dayStartMs(day, zone);
	out.push(
		timeseries(
			[
				{ name: t(lang, "pageviews"), data: days.map((d) => [at(d.date), d.pageviews] as [number, number]) },
				{ name: t(lang, "visits"), data: days.map((d) => [at(d.date), d.visits] as [number, number]) },
			],
			{ blockId: "analytics:chart", height: 300, gradient: true },
		),
	);

	const history = rollups.reduce<Day | undefined>(
		(min, r) => (min === undefined || daysBetween(r.date, min) > 0 ? r.date : min),
		undefined,
	);
	const startsLate = history !== undefined && daysBetween(addDays(today, -(range - 1)), history) > 0;
	const note = statusLine(state, now, lang, {
		estimated: current.estimated,
		provisional: current.provisional,
		unmatched: true,
	});
	const notes = [note, startsLate && history ? t(lang, "historyStarts", { date: formatDay(history, lang) }) : null]
		.filter(Boolean)
		.join(" · ");
	if (notes) out.push(context(notes));

	out.push(...engagementSection(rollups, range, today, lang, zone));
	out.push(...readsChart(state.reads, range, today, now, lang, zone));

	out.push(header(t(lang, "topEntries")));
	out.push(context(coverageText(input.topEntries, range, lang, Boolean(input.breakdowns))));
	out.push(
		table({
			blockId: "analytics:entries",
			pageActionId: "analytics:entries:page",
			columns: [
				{ key: "entry", label: t(lang, "colEntry"), format: "text" },
				// Text, not a badge: paths that are not entries have no
				// collection, and an empty badge renders as a black pill.
				{ key: "collection", label: t(lang, "colCollection"), format: "text" },
				{ key: "path", label: t(lang, "colPath"), format: "code" },
				{ key: "views", label: t(lang, "colViews"), format: "number" },
				{ key: "visits", label: t(lang, "colVisits"), format: "number" },
			],
			rows: input.topEntries.rows.map((row) => {
				const known = input.entriesByPath.get(row.path);
				return {
					entry: known?.title || "—",
					collection: known ? (state.collectionLabels?.[known.collection] ?? known.collection) : "",
					path: row.path,
					views: row.pageviews,
					visits: row.visits,
				};
			}),
			emptyText: t(lang, "entriesEmpty"),
		}),
	);

	out.push(
		columns([
			[
				header(t(lang, "referrers")),
				labelledTable(
					"analytics:referrers",
					t(lang, "colSource"),
					input.breakdowns?.referrers ?? state.referrers ?? [],
					(l) => l,
					lang,
				),
			],
			[
				header(t(lang, "countries")),
				labelledTable(
					"analytics:countries",
					t(lang, "colCountry"),
					input.breakdowns?.countries ?? state.countries ?? [],
					countryName(lang),
					lang,
				),
			],
		]),
	);
	if (input.breakdowns && input.breakdowns.since !== addDays(today, -(range - 1))) {
		out.push(context(t(lang, "breakdownsSince", { date: formatDay(input.breakdowns.since, lang) })));
	} else if (!input.breakdowns && state.snapshotSince) {
		out.push(context(t(lang, "snapshotSince", { date: formatDay(state.snapshotSince, lang) })));
	}

	out.push(...propertyTables(input.breakdowns?.properties ?? [], lang));

	return out;
}

/** Values shown per breakdown, most viewed first. */
const PROPERTY_ROWS = 10;

/**
 * One table per event data property that page views in the range carry.
 * A property none of them carried shows nothing: it is either not sent by
 * this site or not sent yet, and neither is an error.
 */
function propertyTables(properties: PropertyBreakdown[], lang: Lang): AnalyticsBlock[] {
	const shown = properties.filter((breakdown) => breakdown.values.length > 0);
	if (shown.length === 0) return [];

	const out: AnalyticsBlock[] = [];
	for (const breakdown of shown) {
		const id = `analytics:property:${breakdown.property.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
		out.push(header(t(lang, "viewsBy", { property: breakdown.property })));
		out.push(
			table({
				blockId: id,
				pageActionId: `${id}:page`,
				columns: [
					{ key: "value", label: t(lang, "colValue"), format: "text" },
					{ key: "views", label: t(lang, "colViews"), format: "number" },
				],
				rows: breakdown.values.slice(0, PROPERTY_ROWS).map((row) => ({ value: row.value, views: row.pageviews })),
				emptyText: t(lang, "nothingRecorded"),
			}),
		);
	}
	out.push(context(t(lang, "propertiesNote")));
	return out;
}

function controls(input: PageInput, lang: Lang) {
	// Buttons, not a select: the host's select shows the raw value when
	// closed, and its label sets it out of line with the buttons beside it.
	const elements = [
		...RANGES.map((days) =>
			button(RANGE_ACTION, t(lang, "rangeDays", { count: days }), {
				style: days === input.range ? "primary" : "secondary",
				value: days,
			}),
		),
		refreshButton(input.range, lang),
		link(t(lang, "perEntry"), { kind: "plugin-page", path: CONTENT_PAGE_PATH }, { appearance: "secondary" }),
		...(input.dashboardUrl
			? [link(t(lang, "openInUmami"), { kind: "external", url: input.dashboardUrl }, { appearance: "secondary" })]
			: []),
		setupButton(input.range, lang),
	];
	return actions(elements, { blockId: "analytics:controls" });
}

function refreshButton(range: RangeDays, lang: Lang) {
	return button(PAGE_REFRESH_ACTION, t(lang, "refresh"), { style: "secondary", value: range });
}

function setupButton(range: RangeDays, lang: Lang) {
	return button(SETUP_ACTION, t(lang, "checkSetup"), { style: "secondary", value: range });
}

function labelledTable(
	blockId: string,
	label: string,
	rows: Array<{ label: string; visits: number }>,
	display: (label: string) => string,
	lang: Lang,
) {
	return table({
		blockId,
		pageActionId: `${blockId}:page`,
		columns: [
			{ key: "label", label, format: "text" },
			{ key: "visits", label: t(lang, "colVisits"), format: "number" },
		],
		rows: rows.map((row) => ({ label: display(row.label), visits: row.visits })),
		emptyText: t(lang, "nothingRecorded"),
	});
}

/** ISO-2 codes as names in the reader's language, the code where that fails. */
function countryName(locale: string | undefined): (code: string) => string {
	let names: Intl.DisplayNames | null = null;
	try {
		names = new Intl.DisplayNames([locale ?? "en"], { type: "region" });
	} catch {
		names = null;
	}
	return (code) => {
		try {
			return names?.of(code) ?? code;
		} catch {
			return code;
		}
	};
}

function coverageText(top: TopEntries, range: RangeDays, lang: Lang, live: boolean): string {
	if (!top.coveredSince) return t(lang, "coverageRange", { days: range });
	const date = formatDay(top.coveredSince, lang);
	if (live) return t(lang, "coverageLive", { date });
	return t(lang, top.partial ? "coveragePartial" : "coverageMatched", { date });
}

function within(day: Day, since: Day, until: Day): boolean {
	return daysBetween(since, day) >= 0 && daysBetween(day, until) >= 0;
}
