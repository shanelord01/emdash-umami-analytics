/**
 * Read-through: how far readers get into an entry, from a custom event
 * the site sends as a reader reaches each depth.
 *
 * A site sends one event per depth reached, naming the entry and the
 * depth: for example `post_read` with `post` set to the entry's slug and
 * `depth` set to `half` or `end`. Counting those per entry and per day is
 * more than a page or a panel can ask the provider for within its ten
 * bridge calls, so the sync reads them into a snapshot in its state: per
 * entry over the last 30 days, the window of `views30`, and per day over
 * the last 90, the longest range the analytics page offers. Pages, the
 * panel and the widget read the snapshot and ask the provider nothing.
 *
 * The snapshot is read again every few hours, when the local day changes,
 * and when the settings change.
 */

import { normalizePath, type TrailingSlash } from "../index/paths.js";
import type { ReadSpec } from "../providers/types.js";
import { addDays, type Day } from "./window.js";

/** Days the per-entry counts cover, today included: the window of `views30`. */
export const READ_ENTRY_DAYS = 30;
/** Days the per-day counts cover, today included: the longest range the analytics page shows. */
export const READ_DAILY_DAYS = 90;
/** How old a snapshot may get before the sync reads it again. */
export const READ_REFRESH_MS = 6 * 3_600_000;
/** Depths read at most. Each costs two requests, and the step has seven calls. */
export const MAX_READ_DEPTHS = 3;

export interface ReadSnapshot {
	/** When it was read. */
	at: string;
	event: string;
	entryProperty: string;
	depthProperty: string;
	depths: string[];
	/** The first day of the per-entry counts. */
	since: Day;
	/**
	 * Reads per depth, in the order of `depths`, by the value the site sent
	 * for the entry. A value that is a path is stored normalized.
	 */
	byEntry: Record<string, number[]>;
	/** Reads per depth for each day that had any, oldest first. */
	daily: Array<{ date: Day; counts: number[] }>;
	/** True when the provider cut a per-entry list short, so the least read entries are missing. */
	partial: boolean;
}

/** Has the read event never been read under these settings? */
export function readsMissing(snapshot: ReadSnapshot | undefined, spec: ReadSpec): boolean {
	return (
		!snapshot ||
		snapshot.event !== spec.event ||
		snapshot.entryProperty !== spec.entryProperty ||
		snapshot.depthProperty !== spec.depthProperty ||
		snapshot.depths.join(",") !== spec.depths.join(",")
	);
}

/** Is the snapshot missing, stale, from another day or from other settings? */
export function readsDue(snapshot: ReadSnapshot | undefined, spec: ReadSpec, now: Date, today: Day): boolean {
	if (!snapshot || readsMissing(snapshot, spec)) return true;
	if (snapshot.since !== addDays(today, -(READ_ENTRY_DAYS - 1))) return true;
	return now.getTime() - Date.parse(snapshot.at) > READ_REFRESH_MS;
}

/** The ranges a snapshot taken today covers. */
export function readRanges(today: Day): { entries: { since: Day; until: Day }; daily: { since: Day; until: Day } } {
	return {
		entries: { since: addDays(today, -(READ_ENTRY_DAYS - 1)), until: today },
		daily: { since: addDays(today, -(READ_DAILY_DAYS - 1)), until: today },
	};
}

/**
 * The key an entry's reads are stored under, for a value the site sent.
 * A value that starts with `/` is a path; anything else is a slug.
 */
export function readKey(value: string, trailingSlash?: TrailingSlash): string {
	return value.startsWith("/") ? normalizePath(value, trailingSlash) : value;
}

/**
 * An entry's reads per depth, or null when the snapshot has none for it.
 *
 * The site names the entry by path or by slug. A path matches the entry's
 * path exactly; a slug matches the last segment of the entry's path, which
 * is the slug under the usual URL patterns (`/blog/{slug}`).
 */
export function readsFor(snapshot: ReadSnapshot | undefined, path: string): number[] | null {
	if (!snapshot) return null;
	const byPath = snapshot.byEntry[path];
	if (byPath) return byPath;
	const slug = path.split("/").filter(Boolean).pop();
	return (slug && snapshot.byEntry[slug]) || null;
}
