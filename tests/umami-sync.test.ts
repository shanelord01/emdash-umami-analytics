import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DailyRow, EntryRow, RollupRow } from "../src/store/rows.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { addDays } from "../src/sync/window.js";
import { RANGE_ACTION, SETUP_ACTION } from "../src/ui/page.js";
import {
	daysBack,
	newHost,
	NOW,
	respondUmamiOverview,
	seedDaily,
	seedEntries,
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
 * Umami through the real sandbox, bridge and storage, against faked API
 * responses. The test host answers a request only when its URL matches a
 * registered one exactly, so every tick here also checks what was asked.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const YESTERDAY = addDays(TODAY, -1);

/** A caught-up Umami site with the paths slot next and nothing else due. */
const caughtUp: SyncState = {
	...synced,
	provider: "umami",
	phase: "paths",
	lastWork: "paths",
	history: { since: addDays(TODAY, -90), until: YESTERDAY },
};

async function state(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.kv.get<SyncState>("state"))!;
}

/** Give the next tick the paths slot again, keeping everything else the last tick stored. */
async function pathsSlotNext(runtime: PluginRuntimeTestHost) {
	await setState(runtime, { ...(await state(runtime)), phase: "paths", lastWork: "paths" });
}

const daily = (runtime: PluginRuntimeTestHost, day: string, path: string) =>
	runtime.inspect.storage.get("daily", `${day}|${path}`) as Promise<DailyRow | null>;
const rollup = (runtime: PluginRuntimeTestHost, day: string) =>
	runtime.inspect.storage.get("rollup", day) as Promise<RollupRow | null>;

describe("the overview tick", () => {
	it("stores today's and yesterday's totals and the week's snapshot, from five requests", async () => {
		host = await newHost("umami");
		await respondUmamiOverview(host, { today: [10, 5], yesterday: [20, 8], paths: [["/b", 3, 2], ["/a", 30, 13]] });

		await tick(host)();

		expect(host.http.requests()).toHaveLength(5);
		expect(await rollup(host, TODAY)).toMatchObject({ pageviews: 10, visits: 5, sampleInterval: 1 });
		expect(await rollup(host, YESTERDAY)).toMatchObject({ pageviews: 20, visits: 8, sampleInterval: 1 });
		expect(await state(host)).toMatchObject({
			phase: "paths",
			provider: "umami",
			estimated: false,
			snapshotSince: addDays(TODAY, -6),
			topPaths: [
				{ path: "/a/", pageviews: 30, visits: 13 },
				{ path: "/b/", pageviews: 3, visits: 2 },
			],
			referrers: [{ label: "google.com", visits: 6 }],
			countries: [{ label: "DE", visits: 11 }],
		});
		expect((await state(host)).lastError).toBeUndefined();
	});

	it("sends the key as a bearer token and nothing to any other host", async () => {
		host = await newHost("umami");
		await respondUmamiOverview(host);
		await tick(host)();
		for (const request of host.http.requests()) {
			expect(request.method).toBe("GET");
			expect(request.headers.authorization).toBe("Bearer umami_test");
			expect(new URL(request.url).host).toBe("api.umami.is");
		}
	});

	it("records a refused key as the problem and keeps the phase", async () => {
		host = await newHost("umami");
		await host.http.respond(umamiUrl.stats(TODAY), umamiJson({ error: { code: "unauthorized" } }, 401));

		await tick(host)();

		expect(host.http.requests()).toHaveLength(1);
		expect(await state(host)).toMatchObject({ phase: "overview", lastProblem: { key: "umamiUnauthorized" } });
	});

});

describe("the paths tick", () => {
	it("asks for today only and sums the rest of the window from the store", async () => {
		host = await newHost("umami");
		await seedEntries(host, ["/a/", "/b/", "/quiet/"]);
		// Three views a day on each of the eight days before today. The
		// oldest of them is outside the window and must not count.
		await seedDaily(host, ["/a/", "/b/"], daysBack(9).slice(1));
		await setState(host, caughtUp);
		await host.http.respond(
			umamiUrl.dayPaths(TODAY),
			umamiRows([
				["/a", 4, 2],
				["/a/", 1, 1],
				["/not-an-entry", 50, 9],
			]),
		);

		await tick(host)();

		expect(host.http.requests().map((r) => r.url)).toEqual([umamiUrl.dayPaths(TODAY)]);
		// Both spellings of /a today, six stored days for the week, seven for
		// the recent part of the 30 days.
		expect(await host.inspect.storage.get("entries", "/a/")).toMatchObject({ views7: 5 + 6 * 3, recentViews: 5 + 7 * 3 });
		// No traffic today still leaves the stored days.
		expect(await host.inspect.storage.get("entries", "/b/")).toMatchObject({ views7: 6 * 3, recentViews: 7 * 3 });
		expect(await host.inspect.storage.get("entries", "/quiet/")).toMatchObject({ views7: 0, views30: 0 });
		expect(await daily(host, TODAY, "/a/")).toMatchObject({ pageviews: 5, visits: 3, sampleInterval: 1 });
		// The tick writes the paths it asked about, which are the entries.
		expect(await daily(host, TODAY, "/not-an-entry/")).toBeNull();
		expect(await state(host)).toMatchObject({ phase: "overview", lastWork: "paths" });
	});

	it("does not rewrite today's row when the numbers have not moved", async () => {
		host = await newHost("umami");
		await seedEntries(host, ["/a/"]);
		await setState(host, caughtUp);
		const earlier = new Date(NOW.getTime() - 3_600_000).toISOString();
		await host.fixtures.plugin.storage("daily", `${TODAY}|/a/`, {
			date: TODAY,
			path: "/a/",
			pageviews: 4,
			visits: 2,
			sampleInterval: 1,
			fetchedAt: earlier,
		});
		await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([["/a/", 4, 2]]));

		await tick(host)();

		expect((await daily(host, TODAY, "/a/"))?.fetchedAt).toBe(earlier);
	});
});

describe("the history pass", () => {
	/** A site whose paths slot is next and whose history has not been read at all. */
	const fresh: SyncState = { ...caughtUp, history: undefined };

	it("reads yesterday first, then walks back a day per step to the retention limit", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("retentionDays", 7);
		await setState(host, fresh);

		await host.http.respond(umamiUrl.dayPaths(YESTERDAY), umamiRows([["/a", 4, 2], ["/a/", 1, 1], ["/other", 2, 2]]));
		await host.http.respond(umamiUrl.stats(YESTERDAY), umamiStats(7, 4, 3));
		await tick(host)();

		expect(await daily(host, YESTERDAY, "/a/")).toMatchObject({ pageviews: 5, visits: 3, sampleInterval: 1 });
		// Every path Umami reports is kept, an entry or not.
		expect(await daily(host, YESTERDAY, "/other/")).toMatchObject({ pageviews: 2 });
		expect(await rollup(host, YESTERDAY)).toMatchObject({ pageviews: 7, visits: 4, sampleInterval: 1 });
		expect(await state(host)).toMatchObject({
			phase: "overview",
			lastWork: "history",
			history: { since: YESTERDAY, until: YESTERDAY },
		});

		const before = addDays(TODAY, -2);
		await pathsSlotNext(host);
		await host.http.respond(umamiUrl.dayPaths(before), umamiRows([["/a/", 9, 6]]));
		await host.http.respond(umamiUrl.stats(before), umamiStats(9, 6));
		await tick(host)();
		expect(await rollup(host, before)).toMatchObject({ pageviews: 9, visits: 6 });
		expect((await state(host)).history).toEqual({ since: before, until: YESTERDAY });

		// Five days without a page view cost one request each and no totals
		// request, and fit one step.
		await pathsSlotNext(host);
		host.http.clear();
		for (const day of daysBack(8).slice(3)) await host.http.respond(umamiUrl.dayPaths(day), umamiRows([]));
		await tick(host)();
		expect(host.http.requests()).toHaveLength(5);
		expect((await state(host)).history).toEqual({ since: addDays(TODAY, -7), until: YESTERDAY });
		expect(await rollup(host, addDays(TODAY, -4))).toBeNull();

		// Caught up: the slot goes back to the paths tick, which has no
		// entries here and so asks nothing.
		await pathsSlotNext(host);
		host.http.clear();
		await tick(host)();
		expect(host.http.requests()).toHaveLength(0);
		expect(await state(host)).toMatchObject({ lastWork: "paths", history: { since: addDays(TODAY, -7), until: YESTERDAY } });
	});

	/** Give the next tick the paths slot, leaving what the last slot did as the tick recorded it. */
	async function nextSlot(runtime: PluginRuntimeTestHost) {
		await setState(runtime, { ...(await state(runtime)), phase: "paths" });
	}

	it("takes three paths slots of every four while it has earlier days to read", async () => {
		// Every slot would starve the paths tick, which alone writes an
		// entry's view counts. Every other slot takes twice as long.
		host = await newHost("umami");
		await seedEntries(host, ["/a/"]);
		await setState(host, fresh);
		const work: Array<SyncState["lastWork"]> = [];

		for (let slot = 0; slot < 8; slot++) {
			await nextSlot(host);
			host.http.clear();
			for (const day of daysBack(8).slice(1)) await host.http.respond(umamiUrl.dayPaths(day), umamiRows([["/a/", 3, 2]]));
			for (const day of daysBack(8).slice(1)) await host.http.respond(umamiUrl.stats(day), umamiStats(3, 2));
			await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([["/a/", 1, 1]]));
			await tick(host)();
			work.push((await state(host)).lastWork);
		}

		expect(work).toEqual(["history", "history", "history", "paths", "history", "history", "history", "paths"]);
		expect((await state(host)).history).toEqual({ since: addDays(TODAY, -6), until: YESTERDAY });
		// The paths ticks in between put the days read so far into the entry.
		expect(await host.inspect.storage.get("entries", "/a/")).toMatchObject({ views7: 1 + 6 * 3 });
	});

	it("goes back to every other slot once it has reached the retention limit", async () => {
		// Two days closed while the site was not syncing. Reading them is not
		// catching up on history, so the second waits for the paths tick.
		host = await newHost("umami");
		await seedEntries(host, ["/a/"]);
		const behind = addDays(TODAY, -2);
		await setState(host, { ...caughtUp, history: { since: addDays(TODAY, -90), until: addDays(TODAY, -3) } });
		const work: Array<SyncState["lastWork"]> = [];

		for (let slot = 0; slot < 4; slot++) {
			await nextSlot(host);
			host.http.clear();
			for (const day of [behind, YESTERDAY]) {
				await host.http.respond(umamiUrl.dayPaths(day), umamiRows([["/a/", 3, 2]]));
				await host.http.respond(umamiUrl.stats(day), umamiStats(3, 2));
			}
			await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([["/a/", 1, 1]]));
			await tick(host)();
			work.push((await state(host)).lastWork);
		}

		expect(work).toEqual(["history", "paths", "history", "paths"]);
		expect((await state(host)).history).toEqual({ since: addDays(TODAY, -90), until: YESTERDAY });
	});

	it("gives the paths tick its turn even when every step fails", async () => {
		host = await newHost("umami");
		await seedEntries(host, ["/a/"]);
		await setState(host, fresh);
		const work: Array<SyncState["lastWork"]> = [];

		for (let slot = 0; slot < 4; slot++) {
			await nextSlot(host);
			host.http.clear();
			await host.http.respond(umamiUrl.dayPaths(YESTERDAY), umamiJson("Too many requests", 429));
			await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([["/a/", 1, 1]]));
			await tick(host)();
			work.push((await state(host)).lastWork);
		}

		expect(work).toEqual(["history", "history", "history", "paths"]);
		expect((await state(host)).history).toBeUndefined();
	});

	it("corrects a closed day that was stored while it was still open, however old the row is", async () => {
		// The paths tick last saw this day before it ended. The row is exact
		// and old enough to count as frozen, which for a sampling provider
		// would make it the best copy there is. Here the provider still has
		// the whole day.
		host = await newHost("umami");
		const day = addDays(TODAY, -3);
		const partial = { pageviews: 3, visits: 2, sampleInterval: 1, fetchedAt: NOW.toISOString() };
		await host.fixtures.plugin.storage("daily", `${day}|/a/`, { date: day, path: "/a/", ...partial });
		await host.fixtures.plugin.storage("rollup", day, { date: day, ...partial });
		await setState(host, { ...caughtUp, history: { since: addDays(TODAY, -2), until: YESTERDAY } });
		await host.http.respond(umamiUrl.dayPaths(day), umamiRows([["/a/", 11, 7]]));
		await host.http.respond(umamiUrl.stats(day), umamiStats(11, 7));

		await tick(host)();

		expect(await daily(host, day, "/a/")).toMatchObject({ pageviews: 11, visits: 7 });
		expect(await rollup(host, day)).toMatchObject({ pageviews: 11, visits: 7 });
	});

	it("continues a day with more paths than one step can compare, without losing or repeating one", async () => {
		host = await newHost("umami");
		await setState(host, fresh);
		// Returned in an order that is not path order: the cursor must not
		// depend on the order Umami answers in.
		const names = Array.from({ length: 250 }, (_, i) => `/p-${String(i).padStart(3, "0")}`);
		const shuffled = [...names].reverse();
		const answer = () => umamiRows(shuffled.map((name) => [name, 2, 1]));

		await host.http.respond(umamiUrl.dayPaths(YESTERDAY), answer());
		await tick(host)();

		// 196 rows compared and written, the day not finished, no totals yet.
		expect((await state(host)).history).toEqual({ partial: { day: YESTERDAY, after: "/p-195/" } });
		expect(await daily(host, YESTERDAY, "/p-195/")).not.toBeNull();
		expect(await daily(host, YESTERDAY, "/p-196/")).toBeNull();
		expect(await rollup(host, YESTERDAY)).toBeNull();

		await pathsSlotNext(host);
		await host.http.respond(umamiUrl.dayPaths(YESTERDAY), answer());
		await host.http.respond(umamiUrl.stats(YESTERDAY), umamiStats(500, 250));
		await tick(host)();

		expect((await state(host)).history).toEqual({ since: YESTERDAY, until: YESTERDAY });
		const stored = (await host.inspect.storage.list<DailyRow>("daily")).filter(
			(row) => row.data.date === YESTERDAY && row.data.path.startsWith("/p-"),
		);
		expect(stored).toHaveLength(250);
		expect(await rollup(host, YESTERDAY)).toMatchObject({ pageviews: 500, visits: 250 });
	});

	it("stays where it was when Umami fails, and leaves the next slot to the paths tick", async () => {
		host = await newHost("umami");
		await setState(host, fresh);
		await host.http.respond(umamiUrl.dayPaths(YESTERDAY), umamiJson("Too many requests", 429));

		await tick(host)();

		const after = await state(host);
		expect(after).toMatchObject({ lastWork: "history", lastProblem: { key: "umamiRateLimited" }, lastErrorPhase: "paths" });
		expect(after.history).toBeUndefined();
	});

	it("is forgotten when the data source changes, with the numbers it read", async () => {
		host = await newHost("umami");
		await seedDaily(host, ["/a/"], [YESTERDAY]);
		await setState(host, { ...caughtUp, phase: "overview" });
		await host.fixtures.plugin.setting("provider", "demo");

		for (let i = 0; i < 5 && (await state(host)).provider !== "demo"; i++) await tick(host)();

		expect((await state(host)).provider).toBe("demo");
		expect((await state(host)).history).toBeUndefined();
		expect(await daily(host, YESTERDAY, "/a/")).toBeNull();
	});
});

describe("without a website ID", () => {
	it("names the websites the key can list instead of syncing", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("umamiWebsiteId", "");
		await host.http.respond(
			umamiUrl.websites(),
			umamiJson({ data: [{ id: "site-a", name: "Blog", domain: "example.test" }], count: 1, page: 1, pageSize: 100 }),
		);

		await tick(host)();

		const after = await state(host);
		expect(after.lastProblem).toEqual({ key: "noWebsiteIdSites", params: { sites: "site-a (example.test)" } });
		const widget = JSON.stringify((await host.admin.loadWidget("traffic")).blocks);
		expect(widget).toMatch(/No website ID set\. Websites this API key can list: site-a \(example\.test\)\./);
	});

	it("says where to find the ID when the key's user owns no website to list", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("umamiWebsiteId", "");
		await host.http.respond(umamiUrl.websites(), umamiJson({ data: [], count: 0, page: 1, pageSize: 100 }));

		await tick(host)();

		expect((await state(host)).lastProblem).toEqual({ key: "noWebsiteIdNoList" });
	});
});

describe("the setup check", () => {
	type Row = Record<string, unknown>;
	const week = { since: addDays(TODAY, -6), until: TODAY };

	async function openSetup(runtime: PluginRuntimeTestHost) {
		const response = await runtime.admin.act("/analytics", SETUP_ACTION, { value: 30 });
		const pages = (runtime.manifest.admin?.pages ?? []).map((page) => page.path);
		expect(validateBlockResponse(response, { pluginPagePaths: pages }).valid).toBe(true);
		const checks = response.blocks.find((b) => b.block_id === "analytics:setup:checks") as { rows: Row[] } | undefined;
		const row = (check: string) => checks?.rows.find((r) => r.check === check);
		return { row, text: JSON.stringify(response.blocks) };
	}

	it("runs under Umami's names and passes with one request", async () => {
		host = await newHost("umami");
		await host.http.respond(umamiUrl.hostnames(week.since, week.until), umamiRows([["example.test", 42, 20]]));

		const { row } = await openSetup(host);

		expect(host.http.requests()).toHaveLength(1);
		expect(row("Data source")).toMatchObject({ status: "OK", detail: "Umami." });
		expect(row("API key")).toMatchObject({ status: "OK" });
		expect(row("Umami access")).toMatchObject({ status: "OK" });
		expect(row("Website ID")).toMatchObject({ status: "OK", detail: expect.stringMatching(/42 page views in the last 7 days/) });
		expect(row("Hostnames")).toMatchObject({ status: "OK", detail: "Counted: example.test." });
	});

	it("finds a hostname filter that excludes the host Umami reports", async () => {
		host = await newHost("umami");
		await host.http.respond(umamiUrl.hostnames(week.since, week.until), umamiRows([["www.other.test", 42, 20]]));

		const { row, text } = await openSetup(host);

		expect(row("Hostnames")).toMatchObject({
			status: "Problem",
			detail: expect.stringMatching(/Umami reports this website under www\.other\.test, but the plugin counts only example\.test/),
		});
		expect(text).toMatch(/www\.other\.test/);
	});

	it("tells a website the key cannot view from a wrong key", async () => {
		host = await newHost("umami");
		await host.http.respond(umamiUrl.hostnames(week.since, week.until), umamiJson({ error: { code: "unauthorized" } }, 401));
		await host.http.respond(umamiUrl.websites(), umamiJson({ data: [], count: 0, page: 1, pageSize: 100 }));

		const { row } = await openSetup(host);

		expect(row("Umami access")).toMatchObject({
			status: "Problem",
			detail: expect.stringMatching(/no website with this ID that the API key's user can view/),
		});
		expect(row("Website ID")).toMatchObject({ status: "Not checked" });
	});

	it("says so when a web page answers instead of the API", async () => {
		host = await newHost("umami");
		await host.http.respond(
			umamiUrl.hostnames(week.since, week.until),
			new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
		);

		const { row } = await openSetup(host);

		expect(row("Umami access")).toMatchObject({
			status: "Problem",
			detail: expect.stringMatching(/web page instead of JSON \(HTTP 200\)/),
		});
	});

	it("lists the websites to choose from while no website ID is set", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("umamiWebsiteId", "");
		await host.http.respond(
			umamiUrl.websites(),
			umamiJson({ data: [{ id: UMAMI_WEBSITE, name: "Blog", domain: "example.test" }], count: 1, page: 1, pageSize: 100 }),
		);

		const { row, text } = await openSetup(host);

		expect(row("Website ID")).toMatchObject({ status: "Problem", detail: expect.stringMatching(/Copy one from the list below/) });
		expect(text).toMatch(/Websites this API key can list/);
		expect(text).toContain(UMAMI_WEBSITE);
		expect(text).toContain("Blog");
		// The list has no page views to show, so it has no such column.
		expect(text).not.toMatch(/"key":"views"/);
	});

	it("asks for the key, and explains the encryption key, before anything is saved", async () => {
		host = await newHost();
		await host.fixtures.plugin.setting("provider", "umami");

		const { row } = await openSetup(host);

		expect(host.http.requests()).toHaveLength(0);
		expect(row("API key")).toMatchObject({
			status: "Problem",
			detail: expect.stringMatching(/add an Umami API key in the plugin's settings.*EMDASH_ENCRYPTION_KEY/),
		});
		expect(row("Umami access")).toMatchObject({ status: "Not checked", detail: "Needs the API key." });
	});
});

describe("the analytics page", () => {
	it("reads the whole range live and links to the website in Umami", async () => {
		host = await newHost("umami");
		await seedEntries(host, ["/a/"]);
		await respondUmamiOverview(host, { since: addDays(TODAY, -29), paths: [["/a", 30, 13]] });

		const response = await host.admin.act("/analytics", RANGE_ACTION, { value: 30 });
		const text = JSON.stringify(response.blocks);

		expect(host.http.requests()).toHaveLength(5);
		expect(text).toContain(`https://cloud.umami.is/websites/${UMAMI_WEBSITE}`);
		expect(text).toContain("Open in Umami");
		expect(text).not.toContain("Open in Cloudflare");
		// Umami is exact over the whole range, so nothing is qualified as
		// covering only part of it, and nothing as estimated.
		expect(text).toContain("Per-entry numbers for the last 30 days.");
		expect(text).not.toMatch(/as far back as the provider counts/);
		expect(text).not.toMatch(/estimated/);
		const entries = response.blocks.find((b) => b.block_id === "analytics:entries") as { rows: Array<Record<string, unknown>> };
		expect(entries.rows).toEqual([{ entry: "/a/", collection: "posts", path: "/a/", views: 30, visits: 13 }]);
	});

	it("says Umami when a sync found no page views", async () => {
		host = await newHost("umami");
		await setState(host, { ...caughtUp, phase: "overview" });

		const widget = JSON.stringify((await host.admin.loadWidget("traffic")).blocks);

		expect(widget).toMatch(/Umami reported no page views for this website/);
		expect(widget).not.toMatch(/Cloudflare/);
	});
});

describe("stored entries", () => {
	it("keep their older part of the 30 days through a paths tick", async () => {
		// The older pass sums stored days once per UTC day, and the paths tick
		// adds its window on top, for Umami as for every provider.
		host = await newHost("umami");
		await seedEntries(host, ["/a/"]);
		const row = (await host.inspect.storage.get("entries", "/a/")) as EntryRow;
		await host.fixtures.plugin.storage("entries", "/a/", { ...row, olderViews: 40, olderDay: TODAY, views30: 40 });
		await setState(host, caughtUp);
		await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows([["/a/", 2, 1]]));

		await tick(host)();

		expect(await host.inspect.storage.get("entries", "/a/")).toMatchObject({ views7: 2, olderViews: 40, views30: 42 });
	});
});
