import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HISTORY_VERSION } from "../src/sync/history.js";
import { WAITING_KEY, type SyncState } from "../src/sync/scheduler.js";
import { addDays, DEFAULT_TIME_ZONE } from "../src/sync/window.js";
import { PAGE_REFRESH_ACTION, RANGE_ACTION, SETUP_ACTION } from "../src/ui/page.js";
import { TOOL_ROUTES } from "../src/tools/load.js";
import { bridgeCalls, failNextCall } from "./bridge-calls.js";
import {
	daysBack,
	newHost,
	NOW,
	pathsOf,
	pendingChain,
	respondUmamiOverview,
	respondUmamiWebsites,
	routableCollection,
	seedDaily,
	seedEntries,
	seedRollup,
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
 * Every invocation, at its worst case, against EmDash's sandbox limit.
 *
 * A sandboxed invocation may make ten subrequests and each `ctx` call is
 * one; the eleventh throws "Too many subrequests" on Cloudflare and aborts
 * the tick or the render. The harness does not enforce the limit, so each
 * test here counts the calls and also checks the invocation did its full
 * share of work, so a fixture too small to reach the worst case fails
 * instead of passing quietly.
 */

const LIMIT = 10;

/** The most paths a paths tick asks about; the fixture below covers exactly that many. */
const PATHS_PER_TICK = 36;

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

describe("sync ticks", () => {
	it("a first overview tick, which stores 91 days of demo history", async () => {
		host = await newHost();

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("rollup", addDays(TODAY, -90))).resolves.not.toBeNull();
	});

	it("an index tick", async () => {
		host = await newHost();
		await routableCollection(host, 5);
		await setState(host, { ...synced, phase: "paths", indexComplete: false, chain: pendingChain });

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		const state = await host.inspect.kv.get<SyncState>("state");
		expect(state?.lastError).toBeUndefined();
		expect(state?.indexed).toBeGreaterThanOrEqual(3);
	});

	it("a paths tick of a provider that answers a whole window at once", async () => {
		// Demo data is the one provider of that kind here. More entries than
		// one tick may ask about, none of their rows stored yet.
		host = await newHost();
		const paths = pathsOf(40);
		await seedEntries(host, paths);
		await setState(host, { ...synced, phase: "paths" });

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		const state = await host.inspect.kv.get<SyncState>("state");
		expect(state).toMatchObject({ phase: "overview", lastWork: "paths" });
		expect(state?.cursor).toEqual(expect.any(String));
		// Rows for the whole eight-day window, and the entries' counts with them.
		const stored = await host.inspect.storage.list<{ date: string; path: string }>("daily");
		expect(new Set(stored.map((row) => row.data.date)).size).toBe(8);
		const counted = await host.inspect.storage.list<{ views7: number }>("entries");
		expect(counted.some((row) => row.data.views7 > 0)).toBe(true);
	});

	it("every step of an older pass over more paths than one step can finish", async () => {
		// One row per path is the expensive shape: every row read finishes a
		// path, so every page can add a hundred entries to look up and write.
		host = await newHost();
		const paths = pathsOf(300, "/q-");
		await seedEntries(host, paths);
		await seedDaily(host, paths, [addDays(TODAY, -20)]);
		await setState(host, { ...synced, phase: "paths", lastWork: "paths", older: { day: addDays(TODAY, -1), complete: true } });

		let steps = 0;
		for (let i = 0; i < 60; i++) {
			const before = await host.inspect.kv.get<SyncState>("state");
			if (before?.older?.day === TODAY && before.older.complete) break;
			const calls = await bridgeCalls(tick(host));
			expect(calls.length, `tick ${i}: ${calls.join(", ")}`).toBeLessThanOrEqual(LIMIT);
			if ((await host.inspect.kv.get<SyncState>("state"))?.lastWork === "older" && before?.lastWork !== "older") steps++;
		}

		expect(steps).toBeGreaterThan(1);
		await expect(host.inspect.storage.get("entries", paths[299]!)).resolves.toMatchObject({ olderViews: 3 });
	});

	it("a Refresh tick", async () => {
		host = await newHost();
		await setState(host, { ...synced, phase: "paths" });
		const calls = await bridgeCalls(tick(host, "refresh"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("rollup", TODAY)).resolves.not.toBeNull();
	});

	it("every tick of a provider-switch wipe, until it completes", async () => {
		host = await newHost();
		await host.fixtures.plugin.setting("provider", "umami");
		const paths = pathsOf(40);
		await seedEntries(host, paths, 12);
		await seedRollup(host, 150);
		await seedDaily(host, paths, daysBack(10));
		await setState(host, synced);

		let ticks = 0;
		let state: SyncState | null = null;
		for (; ticks < 20 && state?.provider !== "umami"; ticks++) {
			const calls = await bridgeCalls(tick(host));
			expect(calls.length, `tick ${ticks}: ${calls.join(", ")}`).toBeLessThanOrEqual(LIMIT);
			state = await host.inspect.kv.get<SyncState>("state");
		}

		expect(state?.provider).toBe("umami");
		expect(ticks).toBeGreaterThan(1);
		await expect(host.inspect.storage.list("rollup")).resolves.toEqual([]);
		await expect(host.inspect.storage.list("daily")).resolves.toEqual([]);
		await expect(host.inspect.storage.get("entries", paths[39]!)).resolves.toMatchObject({ views7: 0, views30: 0 });
	});

	it("every tick of a wipe of days keyed in UTC by 0.1.2, chained runs included", async () => {
		host = await newHost();
		const paths = pathsOf(40);
		await seedEntries(host, paths, 12);
		await seedRollup(host, 150);
		await seedDaily(host, paths, daysBack(10));
		const { dayZone: _zone, ...utc } = synced;
		await setState(host, utc);

		let ticks = 0;
		let state: SyncState | null = null;
		for (; ticks < 20 && state?.dayZone === undefined; ticks++) {
			// Every other run as the chained task the wipe schedules, which
			// spends the call it kept back on scheduling the next.
			const name = ticks % 2 === 0 ? "sync" : (state?.chain?.next ?? "sync");
			const calls = await bridgeCalls(tick(host, name));
			expect(calls.length, `tick ${ticks}: ${calls.join(", ")}`).toBeLessThanOrEqual(LIMIT);
			state = await host.inspect.kv.get<SyncState>("state");
		}

		expect(state?.dayZone).toBe(DEFAULT_TIME_ZONE);
		expect(ticks).toBeGreaterThan(1);
		await expect(host.inspect.storage.list("daily")).resolves.toEqual([]);
	});

	it("a reconcile run with more to prune than one run can delete", async () => {
		host = await newHost();
		const old = Array.from({ length: 10 }, (_, i) => addDays(TODAY, -200 - i));
		await seedDaily(host, pathsOf(50), old);

		const calls = await bridgeCalls(tick(host, "reconcile"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		const left = (await host.inspect.storage.list("daily")).length;
		expect(left).toBeGreaterThan(0);
		expect(left).toBeLessThan(500);
	});
});

describe("admin requests", () => {
	/** Five top paths, a full comparison window, and 90 days of per-entry rows. */
	async function withData(runtime: PluginRuntimeTestHost) {
		const paths = pathsOf(5);
		await seedEntries(runtime, paths);
		await seedRollup(runtime, 180);
		await seedDaily(runtime, paths, daysBack(60));
		await setState(runtime, {
			...synced,
			topPaths: paths.map((path) => ({ path, pageviews: 10, visits: 5 })),
		});
	}

	it("a widget load", async () => {
		host = await newHost();
		await withData(host);
		const calls = await bridgeCalls(() => host!.admin.loadWidget("traffic"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("cronSchedule");
	});

	it("a widget load before the first sync, which marks the wait", async () => {
		host = await newHost();
		await withData(host);
		await setState(host, { phase: "overview", topPaths: pathsOf(5).map((path) => ({ path, pageviews: 10, visits: 5 })) });
		const calls = await bridgeCalls(() => host!.admin.loadWidget("traffic"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(await host.inspect.kv.get(WAITING_KEY)).toEqual(expect.any(String));
	});

	it("a widget Refresh", async () => {
		host = await newHost();
		await withData(host);
		const calls = await bridgeCalls(() => host!.admin.act("widget:traffic", "analytics:refresh"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await host.inspect.scheduledTasks()).map((t) => String(t.name))).toContain("refresh");
	});

	it("an editor panel load, with translations and read-through", async () => {
		// The panel's worst case: the state, the entry, its translation group
		// and the oldest stored day, which heads the 30-day figure while the
		// stored history is shorter.
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		for (const [path, entryId, locale] of [
			["/blog/post-0/", id!, "en"],
			["/de/blog/post-0/", "de-0", "de"],
		] as const) {
			await host.fixtures.plugin.storage("entries", path, {
				path,
				collection: "posts",
				entryId,
				translationGroup: id!,
				locale,
				title: path,
				status: "published",
				views7: 4,
				views30: 9,
				updatedAt: NOW.toISOString(),
			});
		}
		await seedDaily(host, ["/blog/post-0/"], daysBack(5));
		await setState(host, {
			...synced,
			reads: {
				at: NOW.toISOString(),
				event: "post_read",
				entryProperty: "post",
				depthProperty: "depth",
				depths: ["half", "end"],
				since: addDays(TODAY, -29),
				byEntry: { "/blog/post-0/": [3, 1] },
				daily: [],
				partial: false,
			},
		});

		let blocks: unknown;
		const calls = await bridgeCalls(async () => {
			blocks = (await host!.admin.loadEditorPanel("views", "posts", id!)).blocks;
		});

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toEqual(["kvGet", "storageQuery", "storageQuery", "storageQuery"]);
		expect(JSON.stringify(blocks)).toMatch(/Page views since/);
	});

	it("an analytics page load over 90 days, answered live", async () => {
		host = await newHost();
		await withData(host);
		const calls = await bridgeCalls(() => host!.admin.act("/analytics", RANGE_ACTION, { value: 90 }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageGetMany");
	});
});

describe("Umami, which answers one day per request", () => {
	const YESTERDAY = addDays(TODAY, -1);
	const refused = () => umamiJson({ error: { code: "unauthorized" } }, 401);

	/** A caught-up Umami site with the paths slot next and nothing else due. */
	const caughtUp: SyncState = {
		...synced,
		provider: "umami",
		phase: "paths",
		lastWork: "paths",
		history: { since: addDays(TODAY, -90), until: YESTERDAY, version: HISTORY_VERSION },
		chain: pendingChain,
	};

	it("an overview tick, with both days' totals new", async () => {
		host = await newHost("umami");
		await respondUmamiOverview(host);

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(5);
		await expect(host.inspect.storage.get("rollup", TODAY)).resolves.not.toBeNull();
		await expect(host.inspect.storage.get("rollup", YESTERDAY)).resolves.not.toBeNull();
	});

	it("a Refresh tick", async () => {
		host = await newHost("umami");
		await setState(host, caughtUp);
		await respondUmamiOverview(host);

		const calls = await bridgeCalls(tick(host, "refresh"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("rollup", TODAY)).resolves.not.toBeNull();
	});

	it("a paths tick", async () => {
		host = await newHost("umami");
		// More entries than one tick may ask about. Each has traffic today,
		// not stored yet, and a stored row on every earlier day of the
		// window, so all three reads are full and both writes happen.
		const paths = pathsOf(40);
		const asked = paths.slice(0, PATHS_PER_TICK);
		await seedEntries(host, paths);
		await seedDaily(host, asked, daysBack(8).slice(1));
		await setState(host, caughtUp);
		await host.http.respond(umamiUrl.dayPaths(TODAY), umamiRows(paths.map((path) => [path, 7, 3])));

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "storageGetMany")).toHaveLength(3);
		await expect(host.inspect.storage.get("daily", `${TODAY}|${asked[35]}`)).resolves.not.toBeNull();
		await expect(host.inspect.storage.get("daily", `${TODAY}|${paths[36]}`)).resolves.toBeNull();
		// Seven today, three on each of the seven stored days: six of them
		// are in views7, all seven in the recent part of views30.
		await expect(host.inspect.storage.get("entries", asked[35]!)).resolves.toMatchObject({ views7: 25, views30: 28 });
	});

	it("every step of a history pass over a day with more paths than one step can compare", async () => {
		host = await newHost("umami");
		await setState(host, { ...caughtUp, history: undefined });
		const rows = pathsOf(540, "/h-").map((path): [string, number, number] => [path, 2, 1]);

		let steps = 0;
		for (let i = 0; i < 6; i++) {
			const before = await host.inspect.kv.get<SyncState>("state");
			if (before?.history?.until === YESTERDAY) break;
			await setState(host, { ...before!, phase: "paths", lastWork: "paths" });
			await host.http.respond(umamiUrl.dayPaths(YESTERDAY), umamiRows(rows));
			await host.http.respond(umamiUrl.stats(YESTERDAY), umamiStats(1080, 540));
			const calls = await bridgeCalls(tick(host));
			host.http.clear();
			expect(calls.length, `step ${i}: ${calls.join(", ")}`).toBeLessThanOrEqual(LIMIT);
			steps++;
		}

		// Two steps of 196 paths, and a last one that has two reads left to
		// make as well, then reads the day's totals and writes the site's row.
		expect(steps).toBe(3);
		await expect(host.inspect.storage.get("daily", `${YESTERDAY}|/h-539/`)).resolves.not.toBeNull();
		await expect(host.inspect.storage.get("rollup", YESTERDAY)).resolves.toMatchObject({ pageviews: 1080 });
	});

	it("a history step that writes a whole day after crossing an empty one", async () => {
		// The empty day's request comes out of the same budget, which leaves
		// the day after it one read of 98 paths instead of two.
		host = await newHost("umami");
		const empty = addDays(TODAY, -2);
		const busy = addDays(TODAY, -3);
		await setState(host, { ...caughtUp, history: { since: YESTERDAY, until: YESTERDAY, version: HISTORY_VERSION } });
		await host.http.respond(umamiUrl.dayPaths(empty), umamiRows([]));
		await host.http.respond(umamiUrl.dayPaths(busy), umamiRows(pathsOf(98, "/e-").map((path) => [path, 2, 1])));
		await host.http.respond(umamiUrl.stats(busy), umamiStats(196, 98));

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await host.inspect.kv.get<SyncState>("state"))?.history).toEqual({ since: busy, until: YESTERDAY, version: HISTORY_VERSION });
		await expect(host.inspect.storage.get("daily", `${busy}|/e-97/`)).resolves.not.toBeNull();
		await expect(host.inspect.storage.get("rollup", busy)).resolves.toMatchObject({ visits: 98 });
	});

	it("a history step across as many empty days as it may ask about", async () => {
		host = await newHost("umami");
		await setState(host, { ...caughtUp, history: { since: YESTERDAY, until: YESTERDAY, version: HISTORY_VERSION } });
		for (const day of daysBack(10).slice(2)) await host.http.respond(umamiUrl.dayPaths(day), umamiRows([]));

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(7);
		expect((await host.inspect.kv.get<SyncState>("state"))?.history).toEqual({
			since: addDays(TODAY, -8),
			until: YESTERDAY,
			version: HISTORY_VERSION,
		});
	});

	/** As many teams as one discovery reads, each with a website of its own. */
	const fourTeams = ["a", "b", "c", "d"].map((t) => [{ id: `site-${t}`, domain: `${t}.example.test` }]);

	it("a tick without a website ID, which lists the user's and four teams' websites instead", async () => {
		host = await newHost("umami");
		await host.fixtures.plugin.setting("umamiWebsiteId", "");
		await respondUmamiWebsites(host, [{ id: "site-own", domain: "example.test" }], fourTeams);

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(6);
		expect((await host.inspect.kv.get<SyncState>("state"))?.lastProblem).toEqual({
			key: "noWebsiteIdSites",
			params: {
				sites: "site-own (example.test), site-a (a.example.test), site-b (b.example.test), site-c (c.example.test), site-d (d.example.test)",
			},
		});
	});

	it("a setup check without a website ID, which lists the same", async () => {
		// The tightest discovery: the check's own four calls leave six
		// requests, which is what caps the teams read at four.
		host = await newHost("umami");
		await host.fixtures.plugin.setting("umamiWebsiteId", "");
		await respondUmamiWebsites(host, [{ id: "site-own", domain: "example.test" }], fourTeams);

		let blocks: unknown;
		const calls = await bridgeCalls(async () => {
			blocks = (await host!.admin.act("/analytics", SETUP_ACTION, { value: 30 })).blocks;
		});

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(6);
		expect(JSON.stringify(blocks)).toContain("site-d");
	});

	it("a setup check whose website is refused, which asks a second time", async () => {
		host = await newHost("umami");
		await host.http.respond(umamiUrl.hostnames(addDays(TODAY, -6), TODAY), refused());
		await host.http.respond(umamiUrl.websites(), umamiJson({ data: [] }));
		// Telling the key from the website takes the user's own list only.
		await respondUmamiWebsites(host, [], fourTeams);

		const calls = await bridgeCalls(() => host!.admin.act("/analytics", SETUP_ACTION, { value: 30 }));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(2);
	});

	/** A full comparison window and 90 days of per-entry rows, as the page's fallback reads them. */
	async function withStore(runtime: PluginRuntimeTestHost) {
		const paths = pathsOf(5);
		await seedEntries(runtime, paths);
		await seedRollup(runtime, 180);
		await seedDaily(runtime, paths, daysBack(60));
		await setState(runtime, caughtUp);
		return paths;
	}

	it("an analytics page load over 90 days, answered live by five requests", async () => {
		host = await newHost("umami");
		const paths = await withStore(host);
		await respondUmamiOverview(host, {
			since: addDays(TODAY, -89),
			paths: paths.map((path) => [path, 9, 4]),
			eventData: [["category", "our-trips", 12]],
		});

		const calls = await bridgeCalls(() => host!.admin.act("/analytics", RANGE_ACTION, { value: 90 }));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		// The breakdown by event data is one of the five.
		expect(host.http.requests().map((r) => r.url)).toContain(umamiUrl.eventData(addDays(TODAY, -89), TODAY));
		expect(host.http.requests()).toHaveLength(5);
		expect(calls).toContain("storageGetMany");
	});

	it("an analytics page Refresh over 90 days whose first request fails, falling back to the store", async () => {
		host = await newHost("umami");
		await withStore(host);
		await host.http.respond(umamiUrl.stats(TODAY), refused());

		let toast: unknown;
		const calls = await bridgeCalls(async () => {
			toast = (await host!.admin.act("/analytics", PAGE_REFRESH_ACTION, { value: 90 })).toast;
		});

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(toast).toMatchObject({ type: "error" });
		expect(host.http.requests()).toHaveLength(1);
		// The full fallback: two rollup pages and three daily pages.
		expect(calls.filter((c) => c === "storageQuery").length).toBeGreaterThanOrEqual(5);
	});

	it("an analytics page Refresh over 90 days whose last request fails, after all five were sent", async () => {
		// The worst case for the fallback: the five requests are spent, so it
		// reads the site totals and leaves the per-entry pages out.
		host = await newHost("umami");
		await withStore(host);
		const since = addDays(TODAY, -89);
		await host.http.respond(umamiUrl.stats(TODAY), umamiStats(10, 5));
		await host.http.respond(umamiUrl.stats(YESTERDAY), umamiStats(20, 8));
		await host.http.respond(umamiUrl.metrics("path", since, TODAY, 100), umamiRows([]));
		await host.http.respond(umamiUrl.metrics("referrer", since, TODAY, 20), umamiRows([]));
		await host.http.respond(umamiUrl.metrics("country", since, TODAY, 50), umamiJson("Too many requests", 429));

		let response: { toast?: unknown; blocks: unknown[] } | undefined;
		const calls = await bridgeCalls(async () => {
			response = await host!.admin.act("/analytics", PAGE_REFRESH_ACTION, { value: 90 });
		});

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(5);
		expect(response?.toast).toMatchObject({ type: "error" });
		// The stored totals still render.
		expect(JSON.stringify(response?.blocks)).toMatch(/Visits, last 90 days/);
	});
});

describe("MCP tools", () => {
	/**
	 * Rows kept for history ahead of the published ones in both sort
	 * orders, so a list tool reads every page it may and fills its page
	 * part-way through the last one, which costs the exact re-read.
	 */
	async function withHistoryRows(runtime: PluginRuntimeTestHost, views: { kept: number; published: number }) {
		const entry = (path: string, status: "moved" | "published", n: number) =>
			runtime.fixtures.plugin.storage("entries", path, {
				path,
				collection: "posts",
				entryId: `id${path}`,
				translationGroup: `id${path}`,
				locale: "en",
				title: path,
				status,
				views7: n,
				views30: n,
				updatedAt: NOW.toISOString(),
			});
		for (const path of pathsOf(80, "/a-")) await entry(path, "moved", views.kept);
		for (const path of pathsOf(20, "/p-")) await entry(path, "published", views.published);
		await seedDaily(runtime, ["/p-00/"], daysBack(3));
		await setState(runtime, synced);
	}

	it("top_entries, reading past a hundred rows kept for history", async () => {
		host = await newHost();
		await withHistoryRows(host, { kept: 100, published: 50 });
		let result: { items: unknown[] } | undefined;
		const calls = await bridgeCalls(async () => {
			result = (await host!.transport.invokeRoute(TOOL_ROUTES.topEntries, { limit: 10 })) as { items: unknown[] };
		});
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "storageQuery").length).toBe(6);
		expect(result!.items).toHaveLength(10);
	});

	it("unviewed_entries, reading past a hundred rows kept for history", async () => {
		host = await newHost();
		await withHistoryRows(host, { kept: 0, published: 0 });
		let result: { items: unknown[] } | undefined;
		const calls = await bridgeCalls(async () => {
			result = (await host!.transport.invokeRoute(TOOL_ROUTES.unviewedEntries, { limit: 10 })) as { items: unknown[] };
		});
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "storageQuery").length).toBe(6);
		expect(result!.items).toHaveLength(10);
	});

	it("entry_views by path, for an entry with translations", async () => {
		host = await newHost();
		for (const locale of ["de", "en", "fr"]) {
			const path = `/${locale}/a/`;
			await host.fixtures.plugin.storage("entries", path, {
				path,
				collection: "posts",
				entryId: `a-${locale}`,
				translationGroup: "a-de",
				locale,
				title: path,
				status: "published",
				views7: 1,
				views30: 2,
				updatedAt: NOW.toISOString(),
			});
		}
		await setState(host, synced);
		let result: unknown;
		const calls = await bridgeCalls(async () => {
			result = await host!.transport.invokeRoute(TOOL_ROUTES.entryViews, { path: "/en/a" });
		});
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(result).toMatchObject({ found: true, allLanguages: { views30: 6 } });
	});

	it("site_totals over 90 days with a full comparison period", async () => {
		host = await newHost();
		await seedRollup(host, 180);
		await setState(host, synced);
		const calls = await bridgeCalls(() => host!.transport.invokeRoute(TOOL_ROUTES.siteTotals, { days: 90 }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "storageQuery").length).toBe(3);
	});
});

describe("content hooks", () => {
	it("a save, which also schedules", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		const calls = await bridgeCalls(() =>
			host!.transport.invokeHook("content:afterSave", {
				collection: "posts",
				content: { id, title: "Post 0" },
				isNew: false,
			}),
		);
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("entries", "/blog/post-0/")).resolves.toMatchObject({ entryId: id });
	});

	it("an unpublish", async () => {
		host = await newHost();
		await seedEntries(host, ["/blog/post-0/"]);
		const calls = await bridgeCalls(() =>
			host!.transport.invokeHook("content:afterUnpublish", { collection: "posts", content: { id: "id/blog/post-0/" } }),
		);
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("entries", "/blog/post-0/")).resolves.toMatchObject({
			status: "unpublished",
		});
	});
});

describe("the index walk", () => {
	it("indexes every published entry across ticks and skips drafts", async () => {
		host = await newHost();
		const ids = await routableCollection(host, 7, 2);
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		for (let i = 0; i < 20 && !(await host.inspect.kv.get<SyncState>("state"))?.indexComplete; i++) {
			await tick(host)();
		}

		const rows = await host.inspect.storage.list<{ entryId: string }>("entries");
		expect(rows.map((r) => r.data.entryId).sort()).toEqual(ids.slice(0, 7).sort());
	});

	it("files a translation under its original's group", async () => {
		host = await newHost();
		const [original] = await routableCollection(host, 1);
		const translation = await host.fixtures.content("posts", {
			slug: "post-0-de",
			locale: "de",
			translationOf: original,
			data: { title: "Beitrag 0" },
			status: "published",
			publishedAt: NOW.toISOString(),
		});
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		for (let i = 0; i < 20 && !(await host.inspect.kv.get<SyncState>("state"))?.indexComplete; i++) {
			await tick(host)();
		}

		const rows = await host.inspect.storage.list<{ entryId: string; translationGroup: string }>("entries");
		const groups = Object.fromEntries(rows.map((r) => [r.data.entryId, r.data.translationGroup]));
		expect(groups).toEqual({ [original!]: original, [translation.id]: original });
	});

	it("repeats a page whose tick failed instead of skipping it", async () => {
		// The cursor is saved with the state after the page's rows. Saved
		// before them, a tick that dies in between loses its page for good.
		host = await newHost();
		const ids = await routableCollection(host, 5);
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		failNextCall("storagePutMany");
		await tick(host)();
		expect((await host.inspect.kv.get<SyncState>("state"))?.lastProblem?.key).toBe("indexingFailed");
		await expect(host.inspect.storage.list("entries")).resolves.toEqual([]);

		for (let i = 0; i < 20 && !(await host.inspect.kv.get<SyncState>("state"))?.indexComplete; i++) {
			await tick(host)();
		}

		const rows = await host.inspect.storage.list<{ entryId: string }>("entries");
		expect(rows.map((r) => r.data.entryId).sort()).toEqual([...ids].sort());
	});
});
