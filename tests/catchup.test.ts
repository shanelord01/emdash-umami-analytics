import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HISTORY_VERSION } from "../src/sync/history.js";
import { CATCH_UP_DELAY_MS, CATCH_UP_TASKS, type SyncState } from "../src/sync/scheduler.js";
import { addDays } from "../src/sync/window.js";
import { bridgeCalls } from "./bridge-calls.js";
import {
	newHost,
	respondUmamiOverview,
	routableCollection,
	seedEntries,
	setState,
	synced,
	tick,
	TODAY,
	umamiJson,
	umamiRows,
	umamiStats,
	umamiUrl,
} from "./host.js";

/**
 * Chained catch-up runs: while there is history to read, a run in a paths
 * slot schedules the next one a little under a minute later.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const YESTERDAY = addDays(TODAY, -1);

/** History not read yet: catching up. Paths slot next. */
const behind: SyncState = { ...synced, provider: "umami", phase: "paths", lastWork: "paths" };
/** Every day read: not catching up. */
const caughtUp: SyncState = {
	...behind,
	history: { since: addDays(TODAY, -90), until: YESTERDAY, version: HISTORY_VERSION },
};

const pending = async (runtime: PluginRuntimeTestHost) =>
	(await runtime.inspect.scheduledTasks()).filter((task) => (CATCH_UP_TASKS as readonly string[]).includes(String(task.name)));
const state = async (runtime: PluginRuntimeTestHost) => (await runtime.inspect.kv.get<SyncState>("state"))!;

async function respondYesterday(runtime: PluginRuntimeTestHost) {
	await runtime.http.respond(umamiUrl.dayPaths(YESTERDAY), umamiRows([["/a/", 3, 2]]));
	await runtime.http.respond(umamiUrl.stats(YESTERDAY), umamiStats(3, 2));
}

describe("a chained run", () => {
	it("is scheduled by a sync in a paths slot while history is still to read", async () => {
		host = await newHost("umami");
		await setState(host, behind);
		await respondYesterday(host);

		await tick(host)();

		const tasks = await pending(host);
		expect(tasks.map((t) => String(t.name))).toEqual([CATCH_UP_TASKS[0]]);
		const due = Date.parse(String(tasks[0]!.schedule)) - Date.now();
		expect(due).toBeGreaterThan(CATCH_UP_DELAY_MS - 30_000);
		expect(due).toBeLessThanOrEqual(CATCH_UP_DELAY_MS + 1_000);
		expect((await state(host)).chain?.next).toBe(CATCH_UP_TASKS[0]);
	});

	it("schedules the other chained task, and takes a paths slot even when the overview is next", async () => {
		// A one-shot is deleted when its run returns, so a run that scheduled
		// its own name would lose the next run.
		host = await newHost("umami");
		await setState(host, { ...behind, phase: "overview" });
		await respondYesterday(host);

		await tick(host, CATCH_UP_TASKS[0])();

		expect(host.http.requests().map((r) => r.url)).toEqual([umamiUrl.dayPaths(YESTERDAY), umamiUrl.stats(YESTERDAY)]);
		expect((await pending(host)).map((t) => String(t.name))).toEqual([CATCH_UP_TASKS[1]]);
		// The recurring sync finds the overview next again.
		expect((await state(host)).phase).toBe("overview");
	});

	it("is not started a second time while one is pending, so the rate never doubles", async () => {
		host = await newHost("umami");
		await setState(host, { ...behind, chain: { next: CATCH_UP_TASKS[1], at: new Date(Date.now() + 40_000).toISOString() } });
		await respondYesterday(host);

		const calls = await bridgeCalls(tick(host));

		expect(calls).not.toContain("cronSchedule");
		expect(await pending(host)).toEqual([]);
	});

	it("is started again once a chain has stopped, under the name it would have used next", async () => {
		host = await newHost("umami");
		await setState(host, { ...behind, chain: { next: CATCH_UP_TASKS[1], at: new Date(Date.now() - 10 * 60_000).toISOString() } });
		await respondYesterday(host);

		await tick(host)();

		expect((await pending(host)).map((t) => String(t.name))).toEqual([CATCH_UP_TASKS[1]]);
	});

	it("is not scheduled after a run that failed, which leaves Umami to the normal interval", async () => {
		host = await newHost("umami");
		await setState(host, behind);
		await host.http.respond(umamiUrl.dayPaths(YESTERDAY), umamiJson("Too many requests", 429));

		await tick(host, CATCH_UP_TASKS[0])();

		expect((await state(host)).lastProblem?.key).toBe("umamiRateLimited");
		expect(await pending(host)).toEqual([]);
	});

	it("is not scheduled by a run that is not catching up", async () => {
		host = await newHost("umami");
		await seedEntries(host, ["/a/"]);
		await setState(host, caughtUp);
		await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([["/a/", 1, 1]]));

		const calls = await bridgeCalls(tick(host));

		expect(calls).not.toContain("cronSchedule");
		expect(await pending(host)).toEqual([]);
		expect((await state(host)).chain).toBeUndefined();
	});

	it("is not scheduled by an overview, which the recurring sync keeps to its interval", async () => {
		host = await newHost("umami");
		await setState(host, { ...behind, phase: "overview" });
		await respondUmamiOverview(host);

		const calls = await bridgeCalls(tick(host));

		expect(calls).not.toContain("cronSchedule");
		expect((await state(host)).phase).toBe("paths");
	});

	it("stops scheduling once the run that reads the last day has finished", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("retentionDays", 7);
		await setState(host, { ...behind, history: { since: addDays(TODAY, -6), until: YESTERDAY, version: HISTORY_VERSION } });
		await host.http.respond(umamiUrl.dayPaths(addDays(TODAY, -7)), umamiRows([]));

		await tick(host, CATCH_UP_TASKS[1])();

		expect((await state(host)).history?.since).toBe(addDays(TODAY, -7));
		expect(await pending(host)).toEqual([]);
	});
});

describe("catching up", () => {
	it("also covers the first index walk on demo data, which has no history to read", async () => {
		host = await newHost();
		await routableCollection(host, 5);
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		await tick(host)();

		expect((await pending(host)).map((t) => String(t.name))).toEqual([CATCH_UP_TASKS[0]]);
	});
});

