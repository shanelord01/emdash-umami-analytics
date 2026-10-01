/**
 * The pass that reads closed days from a `wide-pull` provider, one day at
 * a time.
 *
 * Such a provider answers one day per request, so the paths tick asks it
 * for today only. Everything else comes through here: yesterday, once it
 * has closed, and then the days before it back to the retention limit,
 * newest first. Each day is one request for its paths and one for its
 * site totals, written to `daily` and `rollup`.
 *
 * The scheduler gives the pass paths slots. While it still has earlier
 * days to read it gets three of every four, and once it has reached the
 * retention limit, every other one at most (`historyBackfilling`).
 *
 * The provider is exact at any age, which is what makes both halves
 * sound: a day that is weeks old is as good as one read on the day, and a
 * row stored while its day was still open may be corrected afterwards,
 * however long ago that was. `decideWrite` is therefore told never to
 * treat a stored row as frozen here.
 *
 * Every path the provider reports is stored, not only the paths of
 * entries: matching them to entries first would cost a lookup per 98
 * paths, and an entry indexed later finds its history already there.
 *
 * The step is sized to the budget it is given and resumes from stored
 * state. A day with more paths than one step can compare is continued in
 * the next step from the last path written, in path order, so the cursor
 * does not depend on the order the provider returns rows in. Writes are
 * absolute, so a step that dies and is repeated writes the same numbers.
 */

import type { PluginContext } from "emdash/plugin";

import { failure } from "../i18n.js";
import type { PathDayRow, Provider, Result } from "../providers/types.js";
import { dailyStore, rollupStore, ID_BATCH } from "../store/access.js";
import { dailyId, decideWrite, engagementOf, type DailyRow, type RollupRow } from "../store/rows.js";
import { addDays, daysBetween, type Day } from "./window.js";

/** Which closed days have been read whole. */
export interface HistoryPass {
	/** The oldest and the newest day read. Every day between them is in the store. */
	since?: Day;
	until?: Day;
	/** A day whose paths did not fit one step, and the last path written. */
	partial?: { day: Day; after: string };
	/** The `HISTORY_VERSION` the pass was started under. */
	version?: number;
}

/**
 * Raised when a step starts storing more with each day. Version 2 stores
 * each day's bounces and visit time with its totals. A pass from an older
 * version is started again, so the days it read gain what it did not
 * store; rows whose numbers are unchanged are compared and not written.
 */
export const HISTORY_VERSION = 2;

/** The pass as this version continues it: one from an older version counts as not started. */
function current(pass: HistoryPass | undefined): HistoryPass | undefined {
	return pass?.version === HISTORY_VERSION ? pass : undefined;
}

/**
 * Bridge calls a day with traffic needs after its paths are read: its site
 * totals, the `rollup` read and write, and the `daily` write. What is left
 * of the budget pays for `daily` reads of 98 ids each.
 */
const DAY_OVERHEAD = 4;

/**
 * The next day to read, or null when the pass has caught up.
 *
 * Newly closed days come first, oldest first, so the read days stay one
 * unbroken run. Then the run grows backwards to `floor`, the oldest day
 * the store keeps.
 */
export function nextHistoryDay(stored: HistoryPass | undefined, today: Day, floor: Day): Day | null {
	const pass = current(stored);
	const yesterday = addDays(today, -1);
	// Nothing read yet, or a run that ended before the retention limit and
	// cannot be joined up any more: start again at yesterday.
	if (!pass?.since || !pass.until || daysBetween(pass.until, floor) > 0) return yesterday;
	if (daysBetween(pass.until, yesterday) > 0) return addDays(pass.until, 1);
	if (daysBetween(floor, pass.since) > 0) return addDays(pass.since, -1);
	return null;
}

export function historyDue(pass: HistoryPass | undefined, today: Day, floor: Day): boolean {
	return nextHistoryDay(pass, today, floor) !== null;
}

/**
 * Does the pass still have earlier days to read before it reaches `floor`?
 *
 * True on a first run, and again after the retention setting was raised.
 * False once the oldest day read is at the limit: from then on the only
 * work left is the day that closed last night.
 */
export function historyBackfilling(stored: HistoryPass | undefined, floor: Day): boolean {
	const pass = current(stored);
	if (!pass?.since || !pass.until || daysBetween(pass.until, floor) > 0) return true;
	return daysBetween(floor, pass.since) > 0;
}

function advanced(stored: HistoryPass | undefined, day: Day, floor: Day): HistoryPass {
	const pass = current(stored);
	const version = HISTORY_VERSION;
	if (!pass?.since || !pass.until || daysBetween(pass.until, floor) > 0) return { since: day, until: day, version };
	return daysBetween(pass.until, day) > 0
		? { since: pass.since, until: day, version }
		: { since: day, until: pass.until, version };
}

/**
 * One step of the pass, spending at most `budget` bridge calls on the
 * provider and on storage.
 *
 * A day without page views costs one request and the step moves on to the
 * next, so an empty stretch of history is crossed seven days at a time. A
 * day with traffic ends the step.
 */
export async function runHistoryStep(
	ctx: PluginContext,
	provider: Provider,
	previous: HistoryPass | undefined,
	today: Day,
	floor: Day,
	budget: number,
	now: Date,
): Promise<Result<{ pass: HistoryPass | undefined; written: number; skipped: number }>> {
	const daily = dailyStore(ctx);
	const rollup = rollupStore(ctx);
	if (!daily || !rollup) return failure("storageUnavailable");
	if (!provider.day || !provider.dayTotals) return { ok: true, value: { pass: previous, written: 0, skipped: 0 } };

	let pass = current(previous);
	let spent = 0;
	let written = 0;
	let skipped = 0;
	const fetchedAt = now.toISOString();

	while (spent < budget) {
		const day = nextHistoryDay(pass, today, floor);
		if (!day) break;

		const pulled = await provider.day(day);
		spent++;
		if (!pulled.ok) return pulled;

		if (pulled.value.length === 0) {
			pass = advanced(pass, day, floor);
			continue;
		}

		// Not enough left for this day after the empty ones before it: the
		// next step starts here.
		const reads = budget - spent - DAY_OVERHEAD;
		if (reads < 1) break;

		const after = pass?.partial?.day === day ? pass.partial.after : undefined;
		const pending = pulled.value
			.filter((row) => after === undefined || row.path > after)
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const batch = pending.slice(0, reads * ID_BATCH);

		const counts = await writeDaily(daily, batch, today, fetchedAt);
		written += counts.written;
		skipped += counts.skipped;

		if (batch.length < pending.length) {
			pass = { ...pass, version: HISTORY_VERSION, partial: { day, after: batch[batch.length - 1]!.path } };
			break;
		}

		const totals = await provider.dayTotals(day);
		if (!totals.ok) return totals;
		if (totals.value) {
			const row: RollupRow = {
				date: day,
				pageviews: totals.value.pageviews,
				visits: totals.value.visits,
				...engagementOf(totals.value),
				sampleInterval: totals.value.sampleInterval,
				fetchedAt,
			};
			const stored = (await rollup.getMany([day])).get(day);
			if (decideWrite(stored, row, today, Number.POSITIVE_INFINITY).action === "write") {
				await rollup.putMany([{ id: day, data: row }]);
				written++;
			} else {
				skipped++;
			}
		}

		pass = advanced(pass, day, floor);
		break;
	}

	return { ok: true, value: { pass, written, skipped } };
}

/** Read before write, as everywhere: only rows whose numbers changed are written. */
async function writeDaily(
	daily: NonNullable<ReturnType<typeof dailyStore>>,
	rows: PathDayRow[],
	today: Day,
	fetchedAt: string,
): Promise<{ written: number; skipped: number }> {
	const incoming = new Map<string, DailyRow>();
	for (const row of rows) {
		incoming.set(dailyId(row.date, row.path), {
			date: row.date,
			path: row.path,
			pageviews: row.pageviews,
			visits: row.visits,
			sampleInterval: row.sampleInterval,
			fetchedAt,
		});
	}

	const existing = await daily.getMany([...incoming.keys()]);
	const toWrite: Array<{ id: string; data: DailyRow }> = [];
	for (const [id, row] of incoming) {
		if (decideWrite(existing.get(id), row, today, Number.POSITIVE_INFINITY).action === "write") {
			toWrite.push({ id, data: row });
		}
	}
	if (toWrite.length > 0) await daily.putMany(toWrite);
	return { written: toWrite.length, skipped: incoming.size - toWrite.length };
}
