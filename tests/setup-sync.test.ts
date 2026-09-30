import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WAITING_KEY } from "../src/sync/scheduler.js";
import { SETUP_ACTION } from "../src/ui/page.js";
import { newHost, NOW } from "./host.js";

/**
 * The setup check through the real sandbox, bridge and route, reproducing
 * each failure from the state a real site would be in. The failures that
 * need an answer from Umami are in `umami-sync.test.ts`, beside the
 * fixtures that fake one.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

type Row = Record<string, unknown>;

async function openSetup(runtime: PluginRuntimeTestHost) {
	const response = await runtime.admin.act("/analytics", SETUP_ACTION, { value: 30 });
	const pages = (runtime.manifest.admin?.pages ?? []).map((page) => page.path);
	expect(validateBlockResponse(response, { pluginPagePaths: pages }).valid).toBe(true);
	const checks = response.blocks.find((b) => b.block_id === "analytics:setup:checks") as { rows: Row[] } | undefined;
	return { response, rows: checks?.rows ?? [], text: JSON.stringify(response.blocks) };
}

function row(rows: Row[], check: string): Row | undefined {
	return rows.find((r) => r.check === check);
}

describe("the setup check", () => {
	it("is one button away on the analytics page, also before any data", async () => {
		host = await newHost();
		const page = await host.admin.loadPage("/analytics");
		expect(JSON.stringify(page.blocks)).toMatch(/"action_id":"analytics:setup"/);
	});

	it("finds a site without a stored URL", async () => {
		host = await createPluginRuntimeTestHost({ site: { url: "", locale: "en", trailingSlash: "always" } });
		await host.fixtures.plugin.setting("provider", "demo");

		const { rows } = await openSetup(host);
		expect(row(rows, "Site URL")).toMatchObject({ status: "Problem", detail: expect.stringMatching(/emdash:site_url/) });
	});

	it("finds a scheduler that never ran after the dashboard scheduled the sync", async () => {
		host = await newHost();
		await host.admin.loadWidget("traffic");
		await host.fixtures.plugin.kv(WAITING_KEY, new Date(NOW.getTime() - 2 * 3_600_000).toISOString());

		const { rows, text } = await openSetup(host);
		expect(row(rows, "Scheduled sync")).toMatchObject({
			status: "Problem",
			detail: expect.stringMatching(/has never run/),
		});
		expect(text).toMatch(/createScheduledHandler/);
	});

	it("waits on a fresh install instead of calling it broken", async () => {
		host = await newHost();
		await host.admin.loadWidget("traffic");

		const { rows } = await openSetup(host);
		expect(row(rows, "Scheduled sync")).toMatchObject({ status: "Waiting" });
	});
});

describe("the waiting mark", () => {
	it("is written by the first dashboard visit and kept by later ones", async () => {
		host = await newHost();
		await host.admin.loadWidget("traffic");
		const first = await host.inspect.kv.get<string>(WAITING_KEY);
		expect(first).toEqual(expect.any(String));

		await host.admin.loadWidget("traffic");
		expect(await host.inspect.kv.get<string>(WAITING_KEY)).toBe(first);
	});
});
