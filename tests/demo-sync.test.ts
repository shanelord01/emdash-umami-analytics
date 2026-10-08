import { validateBlocks, type StatsBlock, type TableBlock } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { addDays, DEFAULT_TIME_ZONE, localDay } from "../src/sync/window.js";

/**
 * Demo data through the real sandbox, bridge and storage.
 *
 * Plugin storage outlives `dispose()` within a file, so every assertion
 * names the row it is about.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function demoHost() {
	const runtime = await createPluginRuntimeTestHost({
		site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
	});
	await runtime.fixtures.plugin.setting("provider", "demo");
	return runtime;
}

/** Click Refresh, then let the scheduler run the tick it asked for. */
async function refreshAndRun(runtime: PluginRuntimeTestHost) {
	const response = await runtime.admin.act("widget:traffic", "analytics:refresh");
	runtime.scheduled.setTime(new Date());
	await runtime.scheduled.run();
	return response;
}

function tick(runtime: PluginRuntimeTestHost) {
	return runtime.transport.invokeHook("cron", { name: "sync", scheduledAt: new Date().toISOString() });
}

describe("demo data", () => {
	it("fills 90 days of history on the first refresh, and says it is demo data", async () => {
		host = await demoHost();
		const today = localDay(new Date(), DEFAULT_TIME_ZONE);

		const response = await refreshAndRun(host);
		expect(response.toast).toMatchObject({ type: "success" });

		await expect(host.inspect.storage.get("rollup", addDays(today, -90))).resolves.toMatchObject({
			date: addDays(today, -90),
		});

		const widget = await host.admin.loadWidget("traffic");
		expect(validateBlocks(widget.blocks).valid).toBe(true);
		expect(JSON.stringify(widget.blocks)).toMatch(/Demo data, not real traffic/);
	});

	it("counts the widget's page table over the same days as its cards", async () => {
		// With three demo paths the table lists every page, so its views
		// add up to the page-view card, unless the two cover different days.
		host = await demoHost();
		// Overview with backfill, indexing, then an overview on the regular window.
		for (let i = 0; i < 3; i++) await tick(host);

		const { blocks } = await host.admin.loadWidget("traffic");
		const cards = blocks.find((b): b is StatsBlock => b.type === "stats");
		const pages = blocks.find((b): b is TableBlock => b.type === "table");
		const pageviews = Number(String(cards?.items[1]?.value).replace(/\D/g, ""));

		expect(pages?.rows).toHaveLength(3);
		expect(pages?.rows.reduce((n, row) => n + Number(row.views), 0)).toBe(pageviews);
	});

	it("gets through a paths phase that reads more ids than D1 binds in one statement", async () => {
		// 13 entries x 8 days is 104 daily ids. Storage binds the plugin id
		// and collection besides the ids, and D1 stops at 100 parameters, so
		// chunks of 100 failed with "too many SQL variables" on the first
		// paths phase of any site with 13 or more entries.
		host = await demoHost();
		await host.fixtures.collection({
			slug: "posts",
			label: "Posts",
			urlPattern: "/blog/{slug}",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		for (let i = 0; i < 13; i++) {
			await host.fixtures.content("posts", {
				slug: `post-${i}`,
				data: { title: `Post ${i}` },
				status: "published",
				publishedAt: new Date().toISOString(),
			});
		}

		const today = localDay(new Date(), DEFAULT_TIME_ZONE);
		let pathsRan = false;
		for (let i = 0; i < 12 && !pathsRan; i++) {
			await tick(host);
			pathsRan = (await host.inspect.storage.get("daily", `${addDays(today, -1)}|/blog/post-0/`)) !== null;
		}
		expect(pathsRan).toBe(true);
	});

	it("clears the generated numbers when the source is switched back to Umami", async () => {
		// Left in place, demo numbers would render as if they were the
		// site's real traffic the moment Umami was configured.
		host = await demoHost();
		const today = localDay(new Date(), DEFAULT_TIME_ZONE);
		await refreshAndRun(host);
		await expect(host.inspect.storage.get("rollup", today)).resolves.not.toBeNull();

		await host.fixtures.plugin.setting("provider", "umami");
		await tick(host);

		await expect(host.inspect.storage.get("rollup", today)).resolves.toBeNull();
		await expect(host.inspect.storage.get("rollup", addDays(today, -90))).resolves.toBeNull();

		const widget = await host.admin.loadWidget("traffic");
		const text = JSON.stringify(widget.blocks);
		expect(text).not.toMatch(/Demo data/);
		expect(text).toMatch(/No analytics yet/);
	});
});
