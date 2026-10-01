/**
 * Engagement from stored daily totals: bounce rate, average visit time and
 * page views per visit. Pure.
 *
 * Only days that carry bounces and visit time count. Rows stored before
 * the provider reported them have neither, and reading their absence as
 * zero would show a perfect bounce rate for every day the plugin did not
 * know about. So every figure here covers the days that have the data,
 * and says from which day that is.
 */

import { daysBetween, type Day } from "../sync/window.js";
import type { RollupRow } from "./rows.js";

export interface Engagement {
	/** Bounces over visits, between 0 and 1. */
	bounceRate: number;
	/** Seconds per visit. */
	averageVisit: number;
	pagesPerVisit: number;
	visits: number;
	/** The first day that counts, and how many days do. */
	since: Day;
	days: number;
}

/** A day the engagement figures can use. */
export function hasEngagement(row: RollupRow): row is RollupRow & { bounces: number; totaltime: number } {
	return row.bounces !== undefined && row.totaltime !== undefined && row.visits > 0;
}

/** Engagement over the given days, or null when none of them carries it. */
export function engagementOver(rows: RollupRow[]): Engagement | null {
	const usable = rows.filter(hasEngagement);
	if (usable.length === 0) return null;

	let visits = 0;
	let bounces = 0;
	let totaltime = 0;
	let pageviews = 0;
	let since = usable[0]!.date;
	for (const row of usable) {
		visits += row.visits;
		bounces += row.bounces;
		totaltime += row.totaltime;
		pageviews += row.pageviews;
		if (daysBetween(row.date, since) > 0) since = row.date;
	}
	return {
		bounceRate: bounces / visits,
		averageVisit: totaltime / visits,
		pagesPerVisit: pageviews / visits,
		visits,
		since,
		days: usable.length,
	};
}

/** One day's bounce rate and average visit, for the charts. */
export function engagementByDay(rows: RollupRow[]): Array<{ date: Day; bounceRate: number; averageVisit: number }> {
	return rows
		.filter(hasEngagement)
		.map((row) => ({ date: row.date, bounceRate: row.bounces / row.visits, averageVisit: row.totaltime / row.visits }))
		.sort((a, b) => daysBetween(b.date, a.date));
}

/** Does the stored engagement reach back to `day`, so a period starting there can be compared? */
export function engagementReaches(rows: RollupRow[], day: Day): boolean {
	return rows.some((row) => hasEngagement(row) && daysBetween(row.date, day) >= 0);
}
