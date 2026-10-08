/**
 * How an entry's 7- and 30-day view counts are put together. Pure.
 *
 * Thirty days cannot come from the provider: a Cloudflare query reaching
 * back further than `today - 7` is served from a ~10 % sample for every
 * day in it (see `UNSAMPLED_WINDOW_DAYS`). So `views30` has two parts:
 *
 * - **Recent**, `today - 7` to today: the window every paths tick fetches
 *   exactly anyway, summed as it arrives. `views7` is the last seven of
 *   those eight days.
 * - **Older**, `today - 29` to `today - 8`: days the provider can no longer
 *   reproduce and nothing writes any more, so their sum only changes when
 *   the date does. A pass over the stored `daily` rows computes it once
 *   per local day (`sync/older.ts`).
 *
 * Summing all thirty days from the store on every tick would need about
 * thirty `getMany` ids per path, which a ten-call sandbox budget cannot
 * pay for more than a few paths at a time.
 */

import { addDays, daysBetween, UNSAMPLED_WINDOW_DAYS, type Day } from "../sync/window.js";
import type { EntryRow } from "./rows.js";

export const VIEWS7_DAYS = 7;
export const VIEWS30_DAYS = 30;

/** The days the older part covers on `today`: from `today - 29` to `today - 8`. */
export function olderWindow(today: Day): { since: Day; until: Day } {
	return {
		since: addDays(today, -(VIEWS30_DAYS - 1)),
		until: addDays(today, -(UNSAMPLED_WINDOW_DAYS + 1)),
	};
}

/**
 * `views7` and the recent part of `views30` from one path's fetched rows.
 *
 * Rows outside the recent window are ignored rather than trusted: the
 * caller's window is the adapter's business, and a day counted twice
 * would be hard to spot in a sum.
 */
export function recentViewsOf(rows: Array<{ date: Day; pageviews: number }>, today: Day): { views7: number; recent: number } {
	let views7 = 0;
	let recent = 0;
	for (const row of rows) {
		const age = daysBetween(row.date, today);
		if (age < 0 || age > UNSAMPLED_WINDOW_DAYS) continue;
		recent += row.pageviews;
		if (age < VIEWS7_DAYS) views7 += row.pageviews;
	}
	return { views7, recent };
}

/**
 * The entry after a paths tick, or null when nothing changed.
 *
 * `olderSettled` says today's older pass has finished. An entry it did not
 * reach then had no stored traffic in the older window, so its older part
 * is zero, however large it was yesterday. Until the pass finishes,
 * yesterday's older part stands in: off by at most two days' views for a
 * few ticks, where zero would drop 22 days' worth.
 */
export function withRecent(
	entry: EntryRow,
	fetched: { views7: number; recent: number },
	today: Day,
	olderSettled: boolean,
): EntryRow | null {
	const stale = entry.olderDay !== today;
	const olderViews = stale && olderSettled ? 0 : (entry.olderViews ?? 0);
	const olderDay = stale && olderSettled ? today : entry.olderDay;
	const views30 = olderViews + fetched.recent;

	if (
		entry.views7 === fetched.views7 &&
		entry.recentViews === fetched.recent &&
		(entry.olderViews ?? 0) === olderViews &&
		entry.views30 === views30
	) {
		return null;
	}

	return {
		...entry,
		views7: fetched.views7,
		recentViews: fetched.recent,
		olderViews,
		...(olderDay !== undefined && { olderDay }),
		views30,
	};
}

/**
 * The entry after the older pass summed `older` for it on `day`, or null
 * when nothing changed.
 *
 * The day is written even when the number is the same, because it is what
 * tells the paths tick the entry was reached today (see `withRecent`).
 */
export function withOlder(entry: EntryRow, older: number, day: Day): EntryRow | null {
	if (entry.olderViews === older && entry.olderDay === day) return null;
	return { ...entry, olderViews: older, olderDay: day, views30: older + (entry.recentViews ?? 0) };
}

/**
 * Per-path sums from `daily` rows read in path order, one page at a time.
 *
 * A path's rows can straddle two pages, so the last path of a page that
 * has more after it is carried into the next call instead of being
 * reported with half its days. The carry is plain data: the pass stores
 * it with its cursor, so the next tick can pick it up.
 */
export function foldByPath(
	rows: Array<{ path: string; pageviews: number }>,
	carry: { path: string; views: number } | undefined,
	hasMore: boolean,
): { finished: Map<string, number>; carry: { path: string; views: number } | undefined } {
	const finished = new Map<string, number>();
	let current = carry ? { ...carry } : undefined;

	for (const row of rows) {
		if (current && current.path === row.path) {
			current.views += row.pageviews;
			continue;
		}
		if (current) finished.set(current.path, (finished.get(current.path) ?? 0) + current.views);
		current = { path: row.path, views: row.pageviews };
	}

	if (current && !hasMore) {
		finished.set(current.path, (finished.get(current.path) ?? 0) + current.views);
		current = undefined;
	}
	return { finished, carry: current };
}
