/**
 * The dashboard widget.
 *
 * Reads storage only. No provider call happens during a render: the
 * widget dispatches one `page_load` per mount with no polling and no
 * server cache, and `cacheControl` is stripped for private routes, so a
 * render that called Cloudflare would call it once per editor per page
 * view and still show whatever arrived last.
 *
 * Blocks come from `./blocks.js`, whose constructors return upstream's own
 * block interfaces and emit snake_case keys. Hand-written camelCase keys
 * are silently ignored by the renderer — that is the live bug in upstream's
 * own `audit-log` widget, where "Load more" and the empty text never
 * render. `tests/widget.test.ts` runs the host's real `validateBlocks()`
 * over this output, so that class of mistake fails a test rather than
 * shipping.
 */

import type { PluginContext } from "emdash/plugin";

import { actions, button, context, empty, link, stats, table, type AnalyticsBlock } from "./blocks.js";
import { entriesStore, rollupStore, BIND_LIMIT } from "../store/access.js";
import { historyReaches, type EntryRow, type RollupRow } from "../store/rows.js";
import { addDays, daysBetween, localDay, stateZone, type Day } from "../sync/window.js";
import { WIDGET_DAYS, type SyncState } from "../sync/scheduler.js";
import { langOf, t, type Lang } from "../i18n.js";
import { comparisonText, formatCount, trendOf } from "./format.js";
import { PAGE_PATH } from "./page.js";
import { emptyReason, statusLine } from "./status.js";
import { engagementStats } from "./engagement.js";

export const REFRESH_ACTION = "analytics:refresh";

export interface WidgetInput {
	state: SyncState;
	rollups: RollupRow[];
	entriesByPath: Map<string, EntryRow>;
	now: Date;
	locale?: string;
}

/**
 * Gather what the widget needs: two storage reads, no more.
 *
 * `rollup.query` is bounded by the 14 days the comparison needs, well
 * inside the 100-row clamp, and the entry lookup is a single `getMany`
 * over the five paths actually being shown.
 */
export async function loadWidget(ctx: PluginContext, state: SyncState, now: Date, locale?: string): Promise<WidgetInput> {
	const rollup = rollupStore(ctx);
	const entries = entriesStore(ctx);

	const since = addDays(localDay(now, stateZone(state)), -(WIDGET_DAYS * 2 - 1));
	const page = await rollup?.query({
		where: { date: { gte: since } },
		orderBy: { date: "asc" },
		limit: BIND_LIMIT,
	});

	const paths = weeklyTopPaths(state, localDay(now, stateZone(state))).map((p) => p.path);
	const entriesByPath = paths.length > 0 && entries ? await entries.getMany(paths) : new Map<string, EntryRow>();

	return {
		state,
		rollups: (page?.items ?? []).map((item) => item.data),
		entriesByPath,
		now,
		locale,
	};
}

export function renderWidget(input: WidgetInput): AnalyticsBlock[] {
	const { state, rollups, entriesByPath, now, locale } = input;
	const lang = langOf(locale);
	const today = localDay(now, stateZone(state));

	const current = sumRange(rollups, addDays(today, -(WIDGET_DAYS - 1)), today);
	const previousStart = addDays(today, -(WIDGET_DAYS * 2 - 1));
	const previous = sumRange(rollups, previousStart, addDays(today, -WIDGET_DAYS));

	// A previous period the store does not fully reach is "no history yet",
	// which is different from "zero traffic" and must not render as a trend.
	const hasPrevious = historyReaches(rollups, previousStart);

	const out: AnalyticsBlock[] = [];

	if (rollups.length === 0) {
		out.push(
			empty({
				title: t(lang, "noAnalyticsYet"),
				description: emptyReason(state, now, lang),
			}),
		);
		out.push(refreshRow(lang));
		return out;
	}

	const visitsTrend = trendOf(current.visits, hasPrevious ? previous.visits : null);
	const viewsTrend = trendOf(current.pageviews, hasPrevious ? previous.pageviews : null);

	out.push(
		stats([
			{
				label: t(lang, "visitsLastDays", { days: WIDGET_DAYS }),
				value: formatCount(current.visits, lang),
				description: comparisonText(current.visits, hasPrevious ? previous.visits : null, lang),
				...(visitsTrend ? { trend: visitsTrend } : {}),
			},
			{
				label: t(lang, "pageviewsLastDays", { days: WIDGET_DAYS }),
				value: formatCount(current.pageviews, lang),
				description: comparisonText(current.pageviews, hasPrevious ? previous.pageviews : null, lang),
				...(viewsTrend ? { trend: viewsTrend } : {}),
			},
		]),
	);

	// Engagement from the same rows: no read beyond the two above.
	out.push(...(engagementStats(rollups, WIDGET_DAYS, today, lang)?.blocks ?? []));

	const topPaths = weeklyTopPaths(state, today);
	if (topPaths.length > 0) {
		out.push(
			table({
				blockId: "analytics:top-paths",
				pageActionId: "analytics:top-paths:page",
				columns: [
					{ key: "page", label: t(lang, "colPage"), format: "text" },
					{ key: "path", label: t(lang, "colPath"), format: "code" },
					{ key: "views", label: t(lang, "colViews"), format: "number" },
				],
				rows: topPaths.map((row) => ({
					// The entry title where the join knows it, the raw path
					// otherwise: plenty of real traffic hits paths that are not
					// entries at all, and those are still worth showing.
					page: entriesByPath.get(row.path)?.title || "—",
					path: row.path,
					views: row.pageviews,
				})),
				emptyText: t(lang, "noPagesYet"),
			}),
		);
	}

	const note = statusLine(state, now, lang, {
		estimated: state.estimated || current.estimated,
		provisional: current.provisional,
		unmatched: true,
	});
	if (note) out.push(context(note));

	out.push(refreshRow(lang));
	return out;
}

/**
 * The top paths, when the snapshot covers the week the cards count.
 *
 * The first overview of a provider that backfills (demo data) reads its
 * whole exact window, and a snapshot from such a run counted ninety days
 * under cards that say seven. A snapshot that starts six days before
 * today is the cards' week. One a day older is yesterday's week, kept
 * until the first overview after midnight. Anything else is left out
 * rather than shown under the wrong label. A snapshot without a start day
 * comes from before the start was stored, and is shown as before.
 */
export function weeklyTopPaths(state: SyncState, today: Day): NonNullable<SyncState["topPaths"]> {
	const top = (state.topPaths ?? []).slice(0, 5);
	if (!state.snapshotSince) return top;
	const span = daysBetween(state.snapshotSince, today);
	return span === WIDGET_DAYS - 1 || span === WIDGET_DAYS ? top : [];
}

function refreshRow(lang: Lang) {
	return actions([
		button(REFRESH_ACTION, t(lang, "refresh"), { style: "secondary" }),
		link(t(lang, "openAnalytics"), { kind: "plugin-page", path: PAGE_PATH }, { appearance: "secondary" }),
	]);
}

/**
 * Sum the rollup rows inside an inclusive day range.
 *
 * `days` counts rows that exist, not days in the range: a day Cloudflare
 * never reported is absent rather than zero, and treating absence as zero
 * is what makes a fresh install look like a traffic collapse.
 */
function sumRange(rows: RollupRow[], since: Day, until: Day) {
	let pageviews = 0;
	let visits = 0;
	let days = 0;
	let estimated = false;
	let provisional = false;
	const today = until;

	for (const row of rows) {
		if (daysBetween(since, row.date) < 0) continue;
		if (daysBetween(row.date, until) < 0) continue;
		pageviews += row.pageviews;
		visits += row.visits;
		days++;
		if (row.sampleInterval > 1) estimated = true;
		if (row.date === today) provisional = true;
	}

	return { pageviews, visits, days, estimated, provisional };
}
