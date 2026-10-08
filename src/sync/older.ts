/**
 * The once-a-day pass that sums the older part of `views30`.
 *
 * It walks the stored `daily` rows of the older window (`today - 29` to
 * `today - 8`, see `store/views.ts`) in path order, sums each path, and
 * writes the sums into the matching `entries` rows. Rows in that window
 * are never rewritten, because the paths tick only fetches the last eight
 * days, so the sums hold for the rest of the local day.
 *
 * The walk is sized to the budget it is given and resumes from a stored
 * cursor. A path whose rows straddle two pages is carried to the next
 * page, or to the next tick, before its sum is written, so a sum is never
 * written with half its days. Each write is absolute rather than a delta,
 * so a tick that dies after writing and is repeated writes the same
 * numbers again.
 *
 * What it cannot see is an entry with no rows in the window at all. Those
 * keep yesterday's number until the paths tick reaches them and, seeing
 * the pass finished, sets their older part to zero (`withRecent`).
 */

import type { PluginContext } from "emdash/plugin";

import { dailyStore, entriesStore, BIND_LIMIT, ID_BATCH } from "../store/access.js";
import type { EntryRow } from "../store/rows.js";
import { foldByPath, olderWindow, withOlder } from "../store/views.js";
import type { Day } from "./window.js";

/** Where the pass for one local day stands. */
export interface OlderPass {
	day: Day;
	complete: boolean;
	cursor?: string;
	carry?: { path: string; views: number };
}

export function olderDue(pass: OlderPass | undefined, today: Day): boolean {
	return !pass || pass.day !== today || !pass.complete;
}

/** True once today's pass has reached every path with stored older traffic. */
export function olderSettled(pass: OlderPass | undefined, today: Day): boolean {
	return pass?.day === today && pass.complete;
}

/**
 * One step of today's pass, spending at most `budget` bridge calls on
 * storage: its `daily` pages, one `getMany` per 98 finished paths, and a
 * `putMany` if anything changed.
 */
export async function runOlderStep(
	ctx: PluginContext,
	previous: OlderPass | undefined,
	today: Day,
	budget: number,
): Promise<{ pass: OlderPass; written: number }> {
	const daily = dailyStore(ctx);
	const entries = entriesStore(ctx);
	if (!daily || !entries) return { pass: { day: today, complete: true }, written: 0 };

	// Yesterday's unfinished pass is abandoned: its sums are for a window
	// that has moved on.
	const start = previous && previous.day === today && !previous.complete ? previous : { day: today, complete: false };
	const { since, until } = olderWindow(today);

	const finished = new Map<string, number>();
	let carry = start.carry;
	let cursor = start.cursor;
	let done = false;
	let spent = 0;

	// Another page is read only if the writes it could cause still fit: up to
	// a hundred more finished paths, so one or two more `getMany`s, and the
	// `putMany`.
	while (!done && spent + 1 + Math.ceil((finished.size + BIND_LIMIT) / ID_BATCH) + 1 <= budget) {
		const page = await daily.query({
			where: { date: { gte: since, lte: until } },
			orderBy: { path: "asc" },
			limit: BIND_LIMIT,
			...(cursor ? { cursor } : {}),
		});
		spent++;
		done = !page.hasMore || !page.cursor;
		const folded = foldByPath(
			page.items.map((item) => item.data),
			carry,
			!done,
		);
		for (const [path, views] of folded.finished) finished.set(path, (finished.get(path) ?? 0) + views);
		carry = folded.carry;
		cursor = done ? undefined : page.cursor;
	}

	let written = 0;
	if (finished.size > 0) {
		const stored = await entries.getMany([...finished.keys()]);
		const updates: Array<{ id: string; data: EntryRow }> = [];
		for (const [path, views] of finished) {
			const row = stored.get(path);
			// Traffic on a path no entry claims (any more) has nowhere to go.
			if (!row) continue;
			const next = withOlder(row, views, today);
			if (next) updates.push({ id: path, data: next });
		}
		if (updates.length > 0) await entries.putMany(updates);
		written = updates.length;
	}

	const pass: OlderPass = done
		? { day: today, complete: true }
		: { day: today, complete: false, ...(cursor && { cursor }), ...(carry && { carry }) };
	return { pass, written };
}
