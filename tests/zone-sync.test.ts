import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EntryRow, RollupRow } from "../src/store/rows.js";
import { HISTORY_VERSION } from "../src/sync/history.js";
import { CATCH_UP_TASKS, type SyncState } from "../src/sync/scheduler.js";
import { addDays, DEFAULT_TIME_ZONE, localDay } from "../src/sync/window.js";
import {
	daysBack,
	newHost,
	NOW,
	pathsOf,
	pendingChain,
	respondUmamiOverview,
	seedDaily,
	seedEntries,
	seedRollup,
	setState,
	synced,
	tick,
	TODAY,
	UMAMI_WEBSITE,
	umamiJson,
	umamiRows,
	umamiStats,
	umamiUrl,
} from "./host.js";

/**
 * Days are keyed in the site's time zone. Version 0.1.2 keyed them in UTC
 * and recorded no zone, so on update the stored days are cleared and read
 * again. A changed Time zone setting does the same.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const YESTERDAY = addDays(TODAY, -1);

async function state(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.kv.get<SyncState>("state"))!;
}

/** What 0.1.2 left behind: a caught-up Umami store whose state names no zone. */
function fromVersion012(): SyncState {
	const { dayZone: _zone, ...rest } = synced;
	return {
		...rest,
		provider: "umami",
		phase: "paths",
		lastWork: "paths",
		history: { since: addDays(TODAY, -7), until: YESTERDAY, version: HISTORY_VERSION },
		older: { day: TODAY, complete: true },
		topPaths: [{ path: "/p-00/", pageviews: 10, visits: 5 }],
	};
}

/** Wipe ticks until the state names `zone`, with no request to Umami on the way. */
async function wipeUntil(runtime: PluginRuntimeTestHost, zone: string): Promise<number> {
	let ticks = 0;
	for (; ticks < 20 && (await state(runtime)).dayZone !== zone; ticks++) await tick(runtime)();
	expect(runtime.http.requests()).toEqual([]);
	return ticks;
}

describe("days stored by 0.1.2 in UTC", () => {
	it("are cleared on update, frozen rows and per-entry sums included", async () => {
		host = await newHost("umami");
		const paths = pathsOf(5);
		await seedEntries(host, paths, 12);
		const entry = (await host.inspect.storage.get("entries", paths[0]!)) as EntryRow;
		await host.fixtures.plugin.storage("entries", paths[0]!, { ...entry, recentViews: 4, olderViews: 8, olderDay: TODAY });
		// Old enough to be frozen, and exact: nothing but a delete would
		// replace these.
		await seedRollup(host, 30);
		await seedDaily(host, paths, daysBack(30));
		await setState(host, fromVersion012());

		const ticks = await wipeUntil(host, DEFAULT_TIME_ZONE);

		expect(ticks).toBeGreaterThan(1);
		await expect(host.inspect.storage.list("rollup")).resolves.toEqual([]);
		await expect(host.inspect.storage.list("daily")).resolves.toEqual([]);
		const cleared = (await host.inspect.storage.get("entries", paths[0]!)) as EntryRow;
		expect(cleared).toMatchObject({ views7: 0, views30: 0, recentViews: 0, olderViews: 0 });
		expect(cleared.olderDay).toBeUndefined();
		const after = await state(host);
		expect(after).toMatchObject({ provider: "umami", dayZone: DEFAULT_TIME_ZONE, phase: "overview", indexComplete: true });
		// Nothing says the days were read: the history pass starts again.
		expect(after.history).toBeUndefined();
		expect(after.older).toBeUndefined();
		expect(after.topPaths).toBeUndefined();
	});

	it("are read again in the site's zone once cleared, newest first, back to the retention limit", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("retentionDays", 7);
		const paths = pathsOf(2);
		await seedEntries(host, paths, 12);
		// Yesterday's UTC total, frozen: a re-read could not overwrite it.
		await host.fixtures.plugin.storage("rollup", YESTERDAY, {
			date: YESTERDAY,
			pageviews: 999,
			visits: 999,
			sampleInterval: 1,
			fetchedAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
		});
		await setState(host, { ...fromVersion012(), chain: pendingChain });
		await wipeUntil(host, DEFAULT_TIME_ZONE);

		// A test response answers one request, so Umami is answered afresh
		// before each tick: the overview, and every day's paths and totals.
		const umami = async (runtime: PluginRuntimeTestHost) => {
			await respondUmamiOverview(runtime, { today: [10, 5], yesterday: [20, 8] });
			for (const day of daysBack(8)) {
				await runtime.http.respond(umamiUrl.dayPaths(day), umamiRows([[paths[0]!, 3, 2]]));
				if (day !== TODAY && day !== YESTERDAY) await runtime.http.respond(umamiUrl.stats(day), umamiStats(3, 2));
			}
		};
		const floor = addDays(TODAY, -7);
		for (let i = 0; i < 30 && (await state(host)).history?.since !== floor; i++) {
			host.http.clear();
			await umami(host);
			await tick(host)();
			expect((await state(host)).lastError, `tick ${i}`).toBeUndefined();
		}

		expect((await state(host)).history).toEqual({ since: floor, until: YESTERDAY, version: HISTORY_VERSION });
		expect((await host.inspect.storage.get("rollup", YESTERDAY)) as RollupRow).toMatchObject({ pageviews: 20, visits: 8 });
		expect((await host.inspect.storage.get("rollup", floor)) as RollupRow).toMatchObject({ pageviews: 3, visits: 2 });
		await expect(host.inspect.storage.get("daily", `${floor}|${paths[0]}`)).resolves.toMatchObject({ pageviews: 3 });
	});

	it("are cleared a minute at a time when there is more than one run can delete", async () => {
		host = await newHost("umami");
		const paths = pathsOf(40);
		await seedEntries(host, paths);
		await seedDaily(host, paths, daysBack(10));
		await setState(host, fromVersion012());

		await tick(host)();

		const chained = (await host.inspect.scheduledTasks()).filter((task) =>
			(CATCH_UP_TASKS as readonly string[]).includes(String(task.name)),
		);
		expect(chained.map((task) => task.name)).toEqual([CATCH_UP_TASKS[0]]);
		expect((await state(host)).chain?.next).toBe(CATCH_UP_TASKS[0]);
		expect((await state(host)).dayZone).toBeUndefined();
	});
});

describe("the Time zone setting", () => {
	it("is adopted without clearing anything while nothing is stored", async () => {
		host = await newHost("umami");
		await respondUmamiOverview(host);

		await tick(host)();

		expect(await state(host)).toMatchObject({ provider: "umami", dayZone: DEFAULT_TIME_ZONE, phase: "paths" });
		await expect(host.inspect.storage.get("rollup", TODAY)).resolves.not.toBeNull();
	});

	it("clears the stored days and keys new ones in the new zone when it changes", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("timeZone", "UTC");
		await seedRollup(host, 10);
		await setState(host, { ...fromVersion012(), dayZone: DEFAULT_TIME_ZONE, chain: pendingChain });

		await wipeUntil(host, "UTC");
		await expect(host.inspect.storage.list("rollup")).resolves.toEqual([]);

		// The overview now asks for today's UTC day first. Answered with an
		// error, it stops there, so that one request is all it sends.
		const today = localDay(NOW, "UTC");
		const start = Date.parse(`${today}T00:00:00.000Z`);
		const filters = `path=${encodeURIComponent("nre.^/_emdash(/|$)")}&hostname=${encodeURIComponent("eq.example.test,www.example.test")}`;
		await host.http.respond(
			`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/stats?startAt=${start}&endAt=${start + 86_399_999}&timezone=UTC&${filters}`,
			umamiJson({ error: {} }, 500),
		);
		await tick(host)();
		expect(host.http.requests()).toHaveLength(1);
		expect(await state(host)).toMatchObject({ dayZone: "UTC", lastProblem: { key: "umamiHttp" } });
	});

	it("falls back to the default for a name that is not a zone, and keeps the stored days", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("timeZone", "Mars/Olympus_Mons");
		await seedRollup(host, 10);
		await setState(host, { ...fromVersion012(), dayZone: DEFAULT_TIME_ZONE, phase: "overview", chain: pendingChain });
		await respondUmamiOverview(host, { today: [10, 5] });

		await tick(host)();

		expect(await state(host)).toMatchObject({ dayZone: DEFAULT_TIME_ZONE, phase: "paths" });
		expect(host.http.requests()).toHaveLength(5);
		await expect(host.inspect.storage.get("rollup", addDays(TODAY, -9))).resolves.not.toBeNull();
	});
});
