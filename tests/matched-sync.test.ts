import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncState } from "../src/sync/scheduler.js";
import { newHost, routableCollection, seedEntries, setState, synced, tick } from "./host.js";

/**
 * "No page is matched to an entry yet" is decided on the entries stored in
 * the index, whatever stored them. On a site whose entries were all
 * published after the plugin was installed, the content hooks store every
 * row before the index walk reaches it, and the walk adds none itself.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const state = async (runtime: PluginRuntimeTestHost) => (await runtime.inspect.kv.get<SyncState>("state"))!;
const widgetText = async (runtime: PluginRuntimeTestHost) => JSON.stringify((await runtime.admin.loadWidget("traffic")).blocks);

describe("matched entries", () => {
	it("are counted by the index walk when the content hooks stored them first", async () => {
		host = await newHost("demo");
		await routableCollection(host, 2);
		// What the publish hooks leave behind: both rows stored before the walk.
		await seedEntries(host, ["/blog/post-0/", "/blog/post-1/"]);

		for (let i = 0; i < 6 && !(await state(host))?.indexComplete; i++) await tick(host)();

		const after = await state(host);
		expect(after.indexComplete).toBe(true);
		expect(after.indexed ?? 0).toBe(0);
		expect(after.matched).toBe(2);
		expect(await widgetText(host)).not.toMatch(/no page is matched/);
	});

	it("are counted again by every paths pass, from storage", async () => {
		host = await newHost("demo");
		// A state from before the count was stored: the walk added none itself.
		await setState(host, { ...synced, phase: "paths", lastWork: "paths", indexed: 0 });
		await seedEntries(host, ["/a/", "/b/", "/c/"]);

		await tick(host)();

		expect((await state(host)).matched).toBe(3);
		expect(await widgetText(host)).not.toMatch(/no page is matched/);
	});

	it("still say nothing matched when the index is empty", async () => {
		host = await newHost("demo");
		await setState(host, { ...synced, phase: "paths", lastWork: "paths", indexed: 0 });

		await tick(host)();
		await tick(host)();

		expect((await state(host)).matched).toBe(0);
		expect(await widgetText(host)).toMatch(/no page is matched to an entry yet/);
	});
});

describe("the first overview's backfill", () => {
	it("keeps no top paths for the widget: they cover ninety days, not the cards' seven", async () => {
		host = await newHost("demo");
		await seedEntries(host, ["/a/"]);

		await tick(host)();

		const first = await state(host);
		expect(first.backfilled).toBe(true);
		expect(first.topPaths).toBeUndefined();
		expect(await widgetText(host)).not.toMatch(/"type":"table"/);
	});
});
