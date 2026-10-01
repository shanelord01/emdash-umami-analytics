/**
 * Stored row shapes and the one decision that guards every write.
 *
 * Pure, because `decideWrite` is where two separate findings meet and
 * both are easy to get quietly wrong:
 *
 * - **Write budget** (review 1.3). D1's free plan allows 100 000 written
 *   rows per day, and plugin storage writes the row plus one more per
 *   declared index — so roughly 5 rows for a `daily` put and 8 for an
 *   `entries` put. Re-writing an unchanged chunk every 15 minutes blows
 *   through the daily budget by more than 2x. Writing only rows whose
 *   numbers actually changed brings a quiet site down to a handful.
 * - **Freezing** (measured 2026-09-20). Cloudflare stops being able to
 *   reproduce exact numbers after seven days. A row read while it was
 *   still exact is better data than anything the provider can return
 *   later, so once frozen it is never overwritten.
 */

import { daysBetween, isFrozen, isProvisional, type Day } from "../sync/window.js";

/** One day of one path. `id` is `<date>|<path>`. */
export interface DailyRow {
	date: Day;
	path: string;
	pageviews: number;
	visits: number;
	/** 1 means Cloudflare counted every beacon. Above 1 the row is an estimate. */
	sampleInterval: number;
	/** ISO timestamp of the read that produced this row. */
	fetchedAt: string;
}

/** Site totals for one day. `id` is the date. */
export interface RollupRow {
	date: Day;
	pageviews: number;
	visits: number;
	/**
	 * Visits with a single page view, and the seconds all visits lasted, when
	 * the provider reports them. Rows stored before 0.1.2 lack both, which
	 * means unknown, not zero.
	 */
	bounces?: number;
	totaltime?: number;
	sampleInterval: number;
	fetchedAt: string;
}

/** The engagement fields of a day's totals, only those it has. */
export function engagementOf(row: { bounces?: number; totaltime?: number }): { bounces?: number; totaltime?: number } {
	return {
		...(row.bounces !== undefined && { bounces: row.bounces }),
		...(row.totaltime !== undefined && { totaltime: row.totaltime }),
	};
}

/** The path -> entry join. `id` is the normalized path. */
export interface EntryRow {
	path: string;
	collection: string;
	entryId: string;
	translationGroup: string;
	locale: string;
	title: string;
	/**
	 * `moved`: the entry is published at another path now, after a slug or
	 * URL pattern change. The row stays so the old URL's history does too.
	 */
	status: "published" | "unpublished" | "deleted" | "moved";
	/** When the entry was first published, if the content API said. */
	publishedAt?: string;
	/** Page views over the last seven days, today included. Written by the paths tick. */
	views7: number;
	/**
	 * Page views over the last 30 days, today included: `olderViews` plus
	 * `recentViews`. Stored rather than computed on read because the content
	 * page sorts by it, and storage sorts only on a stored, indexed field.
	 */
	views30: number;
	/** Page views over the provider's exact window, `today - 7` to today, from the latest paths tick. */
	recentViews?: number;
	/** Page views from the store over `today - 29` to `today - 8`, summed once a day. */
	olderViews?: number;
	/** The day `olderViews` was summed for. */
	olderDay?: Day;
	updatedAt: string;
}

/** Rows kept for history after an unpublish, a delete or a move are not on the site. */
export function isPublished(row: EntryRow): boolean {
	return row.status === "published";
}

export const DAILY_ID_SEPARATOR = "|";

export function dailyId(date: Day, path: string): string {
	return `${date}${DAILY_ID_SEPARATOR}${path}`;
}

/**
 * Split a `daily` id back into its parts.
 *
 * The path may itself contain the separator — nothing forbids a `|` in a
 * URL path — so the split is on the first occurrence only.
 */
export function parseDailyId(id: string): { date: Day; path: string } | null {
	const i = id.indexOf(DAILY_ID_SEPARATOR);
	if (i < 0) return null;
	return { date: id.slice(0, i), path: id.slice(i + 1) };
}

export type WriteDecision =
	/** Numbers changed and the row is still writable. */
	| { action: "write" }
	/** The stored row is exact history; the incoming one is not better. */
	| { action: "skip"; reason: "frozen" }
	/** Identical numbers. Writing would cost D1 rows and change nothing. */
	| { action: "skip"; reason: "unchanged" }
	/** Never replace an exact reading with an estimate. */
	| { action: "skip"; reason: "would-downgrade" };

/**
 * Should this freshly fetched row be written over what is stored?
 *
 * Order matters. "Frozen" is checked before "unchanged" so the reason
 * reported is the meaningful one, and the downgrade guard sits in front
 * of the equality check because a sampled row may happen to carry the
 * same numbers as the exact one it would replace.
 */
export function decideWrite(
	existing: DailyRow | RollupRow | undefined,
	incoming: DailyRow | RollupRow,
	today: Day,
	freezeAfterDays?: number,
): WriteDecision {
	if (!existing) return { action: "write" };

	if (isFrozen(existing.date, today, existing.sampleInterval, freezeAfterDays)) {
		return { action: "skip", reason: "frozen" };
	}

	// An exact stored reading outranks a sampled fresh one regardless of
	// age. This is the guard that makes an accidental wide query harmless
	// rather than destructive.
	if (existing.sampleInterval === 1 && incoming.sampleInterval > 1) {
		return { action: "skip", reason: "would-downgrade" };
	}

	if (
		existing.pageviews === incoming.pageviews &&
		existing.visits === incoming.visits &&
		existing.sampleInterval === incoming.sampleInterval &&
		engagementSame(existing, incoming)
	) {
		return { action: "skip", reason: "unchanged" };
	}

	return { action: "write" };
}

/** Daily path rows have no engagement fields, so they always compare equal here. */
function engagementSame(a: DailyRow | RollupRow, b: DailyRow | RollupRow): boolean {
	const x = a as { bounces?: number; totaltime?: number };
	const y = b as { bounces?: number; totaltime?: number };
	return x.bounces === y.bounces && x.totaltime === y.totaltime;
}

/**
 * Does stored history reach back to `day`?
 *
 * A comparison period the store covers only in part compares a few days
 * against a whole period: after a backfill, one day against seven. Quiet
 * days are absent rather than zero, so this can only ask whether the
 * oldest stored day is early enough, and on a very quiet site it errs
 * towards showing no comparison.
 */
export function historyReaches(rows: Array<{ date: Day }>, day: Day): boolean {
	return rows.some((row) => daysBetween(row.date, day) >= 0);
}

/**
 * Sum the days of one path inside a window.
 *
 * Provisional days are included — leaving today out would make the widget
 * look broken all morning — but the caller is told, so the number can be
 * labelled as still moving.
 */
export function sumWindow(rows: Array<{ date: Day; pageviews: number; visits: number; sampleInterval: number }>, today: Day) {
	let pageviews = 0;
	let visits = 0;
	let estimated = false;
	let provisional = false;
	for (const row of rows) {
		pageviews += row.pageviews;
		visits += row.visits;
		if (row.sampleInterval > 1) estimated = true;
		if (isProvisional(row.date, today)) provisional = true;
	}
	return { pageviews, visits, estimated, provisional };
}
