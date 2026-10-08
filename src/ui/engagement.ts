/**
 * Engagement and read-through blocks, shared by the analytics page and the
 * dashboard widget. Pure: everything comes from stored rows and the sync
 * state.
 */

import { langOf, t, type Lang } from "../i18n.js";
import { engagementByDay, engagementOver, engagementReaches } from "../store/engagement.js";
import type { RollupRow } from "../store/rows.js";
import type { ReadSnapshot } from "../sync/reads.js";
import { addDays, dayStartMs, daysBetween, DEFAULT_TIME_ZONE, type Day } from "../sync/window.js";
import { columns, context, header, stats, timeseries, type AnalyticsBlock } from "./blocks.js";
import { comparisonText, formatAge, formatDay, formatDuration, formatPercent, formatRatio, pointsText, trendOf } from "./format.js";

/**
 * A chart point's time: the day's local midnight in the site's zone, which
 * the chart shows as that day to a reader in that zone.
 */
const at = (day: Day, zone: string) => dayStartMs(day, zone);

function within(day: Day, since: Day, until: Day): boolean {
	return daysBetween(since, day) >= 0 && daysBetween(day, until) >= 0;
}

/**
 * Bounce rate, average visit and page views per visit over the last `days`
 * days, each against the period before when stored engagement reaches back
 * that far. Null when no day in the range carries engagement.
 *
 * The bounce rate has no trend arrow: an arrow up reads as good news, and a
 * rising bounce rate is not.
 */
export function engagementStats(
	rows: RollupRow[],
	days: number,
	today: Day,
	locale: string | undefined,
): { blocks: AnalyticsBlock[]; since: Day | null } | null {
	const lang = langOf(locale);
	const start = addDays(today, -(days - 1));
	const previousStart = addDays(today, -(days * 2 - 1));
	const current = engagementOver(rows.filter((r) => within(r.date, start, today)));
	if (!current) return null;
	const previous = engagementReaches(rows, previousStart)
		? engagementOver(rows.filter((r) => within(r.date, previousStart, addDays(today, -days))))
		: null;

	const timeTrend = trendOf(current.averageVisit, previous?.averageVisit ?? null);
	const pagesTrend = trendOf(current.pagesPerVisit, previous?.pagesPerVisit ?? null);
	return {
		blocks: [
			stats(
				[
					{
						label: t(lang, "bounceRateLastDays", { days }),
						value: formatPercent(current.bounceRate, lang),
						description: pointsText(current.bounceRate, previous?.bounceRate ?? null, lang),
					},
					{
						label: t(lang, "averageVisitLastDays", { days }),
						value: formatDuration(current.averageVisit, lang),
						description: comparisonText(current.averageVisit, previous?.averageVisit ?? null, lang),
						...(timeTrend ? { trend: timeTrend } : {}),
					},
					{
						label: t(lang, "pagesPerVisitLastDays", { days }),
						value: formatRatio(current.pagesPerVisit, lang),
						description: comparisonText(current.pagesPerVisit, previous?.pagesPerVisit ?? null, lang),
						...(pagesTrend ? { trend: pagesTrend } : {}),
					},
				],
				{ blockId: "analytics:engagement" },
			),
		],
		since: daysBetween(start, current.since) > 0 ? current.since : null,
	};
}

/**
 * Two charts side by side, in the style of the visits chart above them:
 * the bounce rate by day in percent, and the average visit by day in
 * seconds. Two charts because the units differ and the block has one
 * axis. Days without engagement are left out, not drawn as zero.
 */
export function engagementCharts(
	rows: RollupRow[],
	days: number,
	today: Day,
	lang: Lang,
	zone: string = DEFAULT_TIME_ZONE,
): AnalyticsBlock | null {
	const start = addDays(today, -(days - 1));
	const byDay = engagementByDay(rows.filter((r) => within(r.date, start, today)));
	if (byDay.length === 0) return null;
	return columns([
		[
			header(t(lang, "bounceRateByDay")),
			timeseries(
				[
					{
						name: t(lang, "bounceRate"),
						data: byDay.map((d) => [at(d.date, zone), Math.round(d.bounceRate * 1000) / 10] as [number, number]),
					},
				],
				{ blockId: "analytics:chart:bounce-rate", height: 220, gradient: true, yAxisName: t(lang, "axisPercent") },
			),
		],
		[
			header(t(lang, "averageVisitByDay")),
			timeseries(
				[{ name: t(lang, "averageVisit"), data: byDay.map((d) => [at(d.date, zone), Math.round(d.averageVisit)] as [number, number]) }],
				{ blockId: "analytics:chart:visit-time", height: 220, gradient: true, yAxisName: t(lang, "axisSeconds") },
			),
		],
	]);
}

/** The engagement section of the analytics page: figures, charts and what they cover. */
export function engagementSection(
	rows: RollupRow[],
	days: number,
	today: Day,
	locale: string | undefined,
	zone: string = DEFAULT_TIME_ZONE,
): AnalyticsBlock[] {
	const lang = langOf(locale);
	const figures = engagementStats(rows, days, today, lang);
	if (!figures) return [];
	const charts = engagementCharts(rows, days, today, lang, zone);
	const notes = [
		t(lang, "engagementNote"),
		...(figures.since ? [t(lang, "engagementSince", { date: formatDay(figures.since, lang) })] : []),
	];
	return [...figures.blocks, ...(charts ? [charts] : []), context(notes.join(" "))];
}

/**
 * Reads by day as bars, one series per depth in the order the settings
 * give them, over the days of the range the snapshot covers. Nothing when
 * there is no snapshot or no read in the range.
 */
export function readsChart(
	snapshot: ReadSnapshot | undefined,
	days: number,
	today: Day,
	now: Date,
	locale: string | undefined,
	zone: string = DEFAULT_TIME_ZONE,
): AnalyticsBlock[] {
	if (!snapshot) return [];
	const lang = langOf(locale);
	const start = addDays(today, -(days - 1));
	const inRange = snapshot.daily.filter((row) => within(row.date, start, today));
	if (!inRange.some((row) => row.counts.some((n) => n > 0))) return [];

	const series = snapshot.depths.map((depth, i) => ({
		name: depth,
		data: inRange.map((row) => [at(row.date, zone), row.counts[i] ?? 0] as [number, number]),
	}));
	const age = formatAge(snapshot.at, now, lang) ?? t(lang, "recently");
	const notes = [
		t(lang, "readsNote", { event: snapshot.event, property: snapshot.depthProperty, age }),
		...(snapshot.partial ? [t(lang, "readsPartial")] : []),
	];
	return [
		header(t(lang, "readsByDay")),
		timeseries(series, { blockId: "analytics:chart:reads", height: 240, style: "bar" }),
		context(notes.join(" ")),
	];
}
