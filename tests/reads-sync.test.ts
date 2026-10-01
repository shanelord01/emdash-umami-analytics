import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HISTORY_VERSION } from "../src/sync/history.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { addDays } from "../src/sync/window.js";
import { CONTENT_PATH } from "../src/ui/content.js";
import { RANGE_ACTION } from "../src/ui/page.js";
import {
	newHost,
	NOW,
	pendingChain,
	respondReads,
	respondUmamiOverview,
	seedEntries,
	setReadSettings,
	setState,
	synced,
	tick,
	TODAY,
	umamiRows,
	umamiStats,
	umamiUrl,
} from "./host.js";

/**
 * Engagement and read-through through the real sandbox, bridge and storage.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const YESTERDAY = addDays(TODAY, -1);

/** Caught up, paths slot next, no chained run to start. */
const caughtUp: SyncState = {
	...synced,
	provider: "umami",
	phase: "paths",
	lastWork: "paths",
	history: { since: addDays(TODAY, -90), until: YESTERDAY, version: HISTORY_VERSION },
	chain: pendingChain,
};

async function state(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.kv.get<SyncState>("state"))!;
}

/** The owner's last 30 days, as far as reads go: one post, 51 halfway and 43 to the end. */
async function ownersReads(runtime: PluginRuntimeTestHost) {
	await respondReads(runtime, {
		half: { entries: [["a-post", 51]], days: [[addDays(TODAY, -3), 20], [YESTERDAY, 31]] },
		end: { entries: [["a-post", 43]], days: [[addDays(TODAY, -3), 15], [YESTERDAY, 28]] },
	});
}

describe("engagement", () => {
	it("is stored with each day's totals by the overview tick, at no extra request", async () => {
		host = await newHost("umami");
		await host.http.respond(
			umamiUrl.stats(TODAY),
			new Response(JSON.stringify({ pageviews: 20, visits: 10, visitors: 9, bounces: 7, totaltime: 830 }), {
				headers: { "Content-Type": "application/json" },
			}),
		);
		await respondUmamiOverview(host);

		await tick(host)();

		expect(host.http.requests()).toHaveLength(5);
		expect(await host.inspect.storage.get("rollup", TODAY)).toMatchObject({ visits: 10, bounces: 7, totaltime: 830 });
	});

	it("is read for days stored before it, by a history pass started again", async () => {
		// A pass from 0.1.1 read every day without bounces. Reading the days
		// again writes the rows that gain them and leaves the rest alone.
		host = await newHost("umami");
		await host.fixtures.plugin.storage("rollup", YESTERDAY, {
			date: YESTERDAY,
			pageviews: 9,
			visits: 4,
			sampleInterval: 1,
			fetchedAt: NOW.toISOString(),
		});
		await setState(host, { ...caughtUp, history: { since: addDays(TODAY, -90), until: YESTERDAY } });
		await host.http.respond(umamiUrl.dayPaths(YESTERDAY), umamiRows([["/a/", 9, 4]]));
		await host.http.respond(
			umamiUrl.stats(YESTERDAY),
			new Response(JSON.stringify({ pageviews: 9, visits: 4, visitors: 4, bounces: 3, totaltime: 200 }), {
				headers: { "Content-Type": "application/json" },
			}),
		);

		await tick(host)();

		expect(await host.inspect.storage.get("rollup", YESTERDAY)).toMatchObject({ visits: 4, bounces: 3, totaltime: 200 });
		expect((await state(host)).history).toEqual({ since: YESTERDAY, until: YESTERDAY, version: HISTORY_VERSION });
	});

	it("shows on the analytics page with its charts", async () => {
		host = await newHost("umami");
		for (let i = 0; i < 14; i++) {
			const date = addDays(TODAY, -i);
			await host.fixtures.plugin.storage("rollup", date, {
				date,
				pageviews: 66,
				visits: 32,
				bounces: 25,
				totaltime: 2650,
				sampleInterval: 1,
				fetchedAt: NOW.toISOString(),
			});
		}
		await setState(host, caughtUp);
		await respondUmamiOverview(host, { today: [66, 32] });

		const text = JSON.stringify((await host.admin.act("/analytics", RANGE_ACTION, { value: 7 })).blocks);

		expect(text).toMatch(/Bounce rate, last 7 days/);
		expect(text).toMatch(/"block_id":"analytics:chart:bounce-rate"/);
		expect(text).toMatch(/"block_id":"analytics:chart:visit-time"/);
	});
});

describe("read-through", () => {
	it("is off until the event and both properties are set, and asks nothing", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("readEvent", "post_read");
		await setState(host, caughtUp);
		await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([]));

		await tick(host)();

		expect(host.http.requests().some((r) => /event-data\/values|events\/series/.test(r.url))).toBe(false);
		expect((await state(host)).reads).toBeUndefined();
	});

	it("is read into a snapshot in a slot after a paths tick, two requests per depth", async () => {
		host = await newHost("umami");
		await setReadSettings(host);
		await setState(host, caughtUp);
		await ownersReads(host);

		await tick(host)();

		expect(host.http.requests()).toHaveLength(4);
		expect(await state(host)).toMatchObject({
			lastWork: "reads",
			reads: {
				event: "post_read",
				depths: ["half", "end"],
				since: addDays(TODAY, -29),
				byEntry: { "a-post": [51, 43] },
				daily: [
					{ date: addDays(TODAY, -3), counts: [20, 15] },
					{ date: YESTERDAY, counts: [31, 28] },
				],
				partial: false,
			},
		});
	});

	it("is not read again until the snapshot is six hours old", async () => {
		host = await newHost("umami");
		await setReadSettings(host);
		await setState(host, caughtUp);
		await ownersReads(host);
		await tick(host)();

		await setState(host, { ...(await state(host)), phase: "paths", lastWork: "paths" });
		host.http.clear();
		await tick(host)();

		// The slot goes to the paths tick, which has no entries here to ask about.
		expect(host.http.requests()).toEqual([]);
		expect((await state(host)).lastWork).toBe("paths");
	});

	it("shows beside each entry's 30-day views, matched by the slug at the end of its path", async () => {
		host = await newHost("umami");
		await seedEntries(host, ["/blog/a-post/", "/blog/unread/"], 120);
		await setReadSettings(host);
		await setState(host, caughtUp);
		await ownersReads(host);
		await tick(host)();

		const page = await host.admin.loadPage(CONTENT_PATH);
		const table = page.blocks.find((b) => b.block_id === "analytics:content:entries") as {
			columns: Array<{ key: string; label: string }>;
			rows: Array<Record<string, unknown>>;
		};
		expect(table.columns.map((c) => c.label)).toEqual(expect.arrayContaining(["Read to half", "Read to end"]));
		const row = (path: string) => table.rows.find((r) => r.path === path)!;
		expect(row("/blog/a-post/")).toMatchObject({ views30: 120, read0: 51, read1: 43 });
		// Listed and unread: a whole list, so zero is the truth.
		expect(row("/blog/unread/")).toMatchObject({ read0: 0, read1: 0 });
	});

	it("shows in the editor panel as a meter per depth against the entry's views", async () => {
		host = await newHost("umami");
		await host.fixtures.collection({
			slug: "posts",
			label: "Posts",
			urlPattern: "/blog/{slug}",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const item = await host.fixtures.content("posts", {
			slug: "a-post",
			data: { title: "A post" },
			status: "published",
			publishedAt: NOW.toISOString(),
		});
		await host.fixtures.plugin.storage("entries", "/blog/a-post/", {
			path: "/blog/a-post/",
			collection: "posts",
			entryId: item.id,
			translationGroup: item.id,
			locale: "en",
			title: "A post",
			status: "published",
			views7: 40,
			views30: 120,
			updatedAt: NOW.toISOString(),
		});
		await setReadSettings(host);
		await setState(host, caughtUp);
		await ownersReads(host);
		await tick(host)();

		const panel = await host.admin.loadEditorPanel("views", "posts", item.id);
		const meters = panel.blocks.filter((b) => b.type === "meter") as Array<{ label: string; value: number; max: number; custom_value: string }>;
		expect(meters).toEqual([
			expect.objectContaining({ label: "Read to half, 30 days", value: 51, max: 120, custom_value: "51 of 120 views" }),
			expect.objectContaining({ label: "Read to end, 30 days", value: 43, max: 120, custom_value: "43 of 120 views" }),
		]);
	});

	it("draws reads by day on the analytics page", async () => {
		host = await newHost("umami");
		await setReadSettings(host);
		await setState(host, caughtUp);
		await ownersReads(host);
		await tick(host)();
		await respondUmamiOverview(host, { since: addDays(TODAY, -29) });

		const text = JSON.stringify((await host.admin.act("/analytics", RANGE_ACTION, { value: 30 })).blocks);

		expect(text).toMatch(/Reads by day/);
		expect(text).toMatch(/"block_id":"analytics:chart:reads"/);
	});

	it("leaves nothing behind once turned off", async () => {
		host = await newHost("umami");
		await setReadSettings(host);
		await setState(host, caughtUp);
		await ownersReads(host);
		await tick(host)();

		await host.fixtures.plugin.setting("readEvent", "");
		await setState(host, { ...(await state(host)), phase: "paths", lastWork: "paths" });
		await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([]));
		await tick(host)();

		expect((await state(host)).reads).toBeUndefined();
	});

	it("records a failed read and leaves the next slot to the paths tick", async () => {
		host = await newHost("umami");
		await setReadSettings(host, "end");
		await setState(host, caughtUp);
		await host.http.respond(umamiUrl.readValues("end"), new Response("Too many requests", { status: 429 }));
		await host.http.respond(umamiUrl.readSeries("end"), umamiStats(0, 0));

		await tick(host)();

		expect(await state(host)).toMatchObject({ lastWork: "reads", lastProblem: { key: "umamiRateLimited" } });
		expect((await state(host)).reads).toBeUndefined();
	});
});
