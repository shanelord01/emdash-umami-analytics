import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncState } from "../src/sync/scheduler.js";
import { addDays } from "../src/sync/window.js";
import { newHost, respondUmamiOverview, seedEntries, setState, synced, TODAY, umamiRows, umamiUrl } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

async function tick(runtime: PluginRuntimeTestHost, name = "sync") {
	await runtime.transport.invokeHook("cron", { name, scheduledAt: new Date().toISOString() });
	return await runtime.inspect.kv.get<SyncState>("state");
}

describe("a failed tick", () => {
	it("stays visible through a Refresh until the phase that failed succeeds", async () => {
		// A Refresh runs an overview out of turn; clearing a paths error there
		// would hide it until the next paths tick fails again.
		host = await newHost("umami");
		await seedEntries(host, ["/about/"]);
		await setState(host, {
			...synced,
			provider: "umami",
			phase: "paths",
			lastWork: "paths",
			history: { since: addDays(TODAY, -90), until: addDays(TODAY, -1) },
		});

		await host.http.respond(umamiUrl.dayPaths(TODAY), new Response("upstream down", { status: 502 }));
		await respondUmamiOverview(host);
		await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([["/about/", 2, 1]]));

		const failed = await tick(host);
		expect(failed?.lastProblem?.key).toBe("umamiHttp");

		const afterRefresh = await tick(host, "refresh");
		expect(afterRefresh?.phase).toBe("paths");
		expect(afterRefresh?.lastProblem?.key).toBe("umamiHttp");

		const afterPaths = await tick(host);
		expect(afterPaths?.lastError).toBeUndefined();
	});
});
