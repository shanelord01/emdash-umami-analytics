/**
 * Date windows for the sync job. Pure, so the rules that matter can be
 * tested without a provider.
 *
 * A day is a calendar day in the site's time zone (the Time zone
 * setting), written `YYYY-MM-DD`. Umami's own dashboard shows days in the
 * website's time zone, and a page view at 8:15 am in Sydney belongs to that
 * Sydney day, not to the UTC day before it. So every day key the plugin
 * stores and every window it asks for is a local day:
 *
 * - `localDay` names the day an instant falls on, from the zone's own
 *   calendar (`Intl.DateTimeFormat` parts), never from a fixed offset.
 * - `dayStartMs` and `dayEndMs` give the first and last millisecond of a
 *   day, which is what Umami's `startAt` and `endAt` take. A day is 23, 24
 *   or 25 hours long where the zone changes its clocks.
 * - `addDays`, `daysBetween` and `enumerateDays` are calendar arithmetic
 *   on the day keys. They need no zone, and a clock change cannot move
 *   them, because they never pass through an instant.
 *
 * The sampling rules below come from the Cloudflare plugin this one is
 * derived from, whose API had no time zone at all. Their measurements are
 * kept as they were taken.
 */

import { dayOf, dayStartMs, DEFAULT_TIME_ZONE } from "../time/zone.js";

// The zone helper is shared with emdash-to-buffer-plus and copied as it
// is, so both plugins count days the same way.
export { dayStartMs, DEFAULT_TIME_ZONE, resolveTimeZone } from "../time/zone.js";

/**
 * How far back `date_geq` may reach before Cloudflare switches the whole
 * query to its aggregated sample.
 *
 * This is the most important number in the plugin. Measured against a live
 * account on 2026-09-20, holding `date_leq` at today and walking `date_geq`
 * backwards one day at a time:
 *
 *   date_geq  today-6  ->  25 page views, sampleInterval 1.47
 *   date_geq  today-7  ->  31 page views, sampleInterval 1.35
 *   date_geq  today-8  ->  10 page views, sampleInterval 10
 *   date_geq  today-9  ->  10 page views, sampleInterval 10
 *
 * Widening the window by one single day cut the reported total from 31 to
 * 10. Past the cliff every value is a multiple of ten, and days quiet
 * enough to contribute no sampled row disappear from the response
 * altogether — a day that reports 7 views in a one-day window is simply
 * absent from any query starting eight days back.
 *
 * The sampling decision is made per query, from the oldest day requested,
 * and then applied to every day in the result including today. So a wider
 * window is not a cheaper request, it is a corrupt one, and no caller may
 * widen it to save a round trip.
 */
export const UNSAMPLED_WINDOW_DAYS = 7;

/**
 * Days of overlap re-fetched on every tick.
 *
 * Beacon data arrives late, and today's row is never final anyway (see
 * `isProvisional`), so each tick re-reads the last few days and lets the
 * newer answer win until the day freezes.
 */
export const DEFAULT_OVERLAP_DAYS = 2;


const MS_PER_DAY = 86_400_000;

/** A calendar day in the site's time zone, `YYYY-MM-DD`. */
export type Day = string;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is Day {
	return typeof value === "string" && DAY_PATTERN.test(value);
}

/**
 * The zone the stored days are keyed in (the sync state's `dayZone`), for
 * the pages, the widget and the MCP tools, which read the state and not the
 * settings. Before the first sync it is the setting's default.
 */
export function stateZone(state: { dayZone?: string }): string {
	return state.dayZone ?? DEFAULT_TIME_ZONE;
}

/** The calendar day in `zone` that contains `at`. */
export function localDay(at: Date, zone: string): Day {
	return dayOf(at, zone);
}

/**
 * The last millisecond of `day` in `zone`: one before the next day starts.
 * A day is 23 or 25 hours long where the zone changes its clocks.
 */
export function dayEndMs(day: Day, zone: string): number {
	return dayStartMs(addDays(day, 1), zone) - 1;
}

/** `day` at midnight UTC, used only for calendar arithmetic on day keys. */
function dayToMs(day: Day): number {
	const ms = isDay(day) ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;
	if (Number.isNaN(ms)) throw new RangeError(`Not a day: ${day}`);
	return ms;
}

/** Shift a day by whole calendar days. Negative moves backwards. */
export function addDays(day: Day, delta: number): Day {
	return new Date(dayToMs(day) + delta * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: Day, to: Day): number {
	return Math.round((dayToMs(to) - dayToMs(from)) / MS_PER_DAY);
}

/** Every day in `[since, until]`, ascending and inclusive. */
export function enumerateDays(since: Day, until: Day): Day[] {
	const span = daysBetween(since, until);
	if (span < 0) return [];
	return Array.from({ length: span + 1 }, (_, i) => addDays(since, i));
}

export interface SyncWindow {
	/** `date_geq` — never older than the unsampled cliff. */
	since: Day;
	/** `date_leq`: today, in the site's time zone. */
	until: Day;
	/** True when the requested overlap had to be shortened to stay unsampled. */
	clamped: boolean;
}

/**
 * The window a tick may ask Cloudflare for.
 *
 * `overlapDays` is a request, not a promise: it is clamped to the
 * provider's exact window (`UNSAMPLED_WINDOW_DAYS` for Cloudflare) because
 * exceeding it silently corrupts every number in the response rather than
 * merely returning more of them.
 */
export function syncWindow(
	now: Date,
	overlapDays: number = DEFAULT_OVERLAP_DAYS,
	exactDays: number = UNSAMPLED_WINDOW_DAYS,
	zone: string = DEFAULT_TIME_ZONE,
): SyncWindow {
	const until = localDay(now, zone);
	const wanted = Math.max(0, Math.trunc(overlapDays));
	const allowed = Math.min(wanted, Math.max(0, Math.trunc(exactDays)));
	return { since: addDays(until, -allowed), until, clamped: allowed < wanted };
}

/**
 * The widest window that is still exact, used by the first-run backfill.
 *
 * Anything older than this has to come from the sampled aggregate, so the
 * backfill stops here and the UI says the store starts on this day rather
 * than inventing tenfold-quantized history.
 */
export function backfillWindow(
	now: Date,
	exactDays: number = UNSAMPLED_WINDOW_DAYS,
	zone: string = DEFAULT_TIME_ZONE,
): SyncWindow {
	return syncWindow(now, exactDays, exactDays, zone);
}

/**
 * Is a day still open, or recent enough that its numbers may still move?
 *
 * Today is always provisional: a one-day query for today reported
 * `sampleInterval` 2.1 to 2.3 in the 2026-09-20 measurements, while every
 * closed day inside the unsampled window reported exactly 1. So today is
 * an estimate by construction, and the UI has to say so.
 */
export function isProvisional(day: Day, today: Day): boolean {
	return daysBetween(day, today) <= 0;
}

/**
 * May a stored row for `day` be overwritten by a freshly fetched one?
 *
 * A day freezes once it is closed, old enough that late beacons have
 * stopped arriving, and was last written from an unsampled response.
 * Frozen rows are the plugin's exact history — after seven days
 * Cloudflare itself can no longer reproduce them — so nothing overwrites
 * one, least of all a sampled re-read.
 */
export function isFrozen(day: Day, today: Day, storedSampleInterval: number, freezeAfterDays: number = DEFAULT_OVERLAP_DAYS): boolean {
	if (isProvisional(day, today)) return false;
	if (daysBetween(day, today) < freezeAfterDays) return false;
	return storedSampleInterval === 1;
}

/**
 * Is a response exact enough to be written as history?
 *
 * `sampleInterval` 1 means Cloudflare counted every beacon. Anything above
 * 1 is an estimate: `count` is already scaled up by this factor, so the
 * number is not raw, it is extrapolated.
 */
export function isExact(sampleInterval: number): boolean {
	return sampleInterval === 1;
}
