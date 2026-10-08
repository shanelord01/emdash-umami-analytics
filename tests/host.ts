import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { expect, vi } from "vitest";

import { INDEX_VERSION } from "../src/index/bootstrap.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { addDays, dayEndMs, dayStartMs, DEFAULT_TIME_ZONE, localDay } from "../src/sync/window.js";

/**
 * Fixtures for tests that run the plugin inside the runtime test host.
 *
 * The host itself is created and disposed by each test file, because
 * disposal belongs in that file's `afterEach`.
 */

export const NOW = new Date();
/** Today in the zone the settings default to, which the host tests leave unset. */
export const TODAY = localDay(NOW, DEFAULT_TIME_ZONE);

export async function newHost(provider: "demo" | "umami" = "demo") {
	if (provider !== "demo") {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	}
	const runtime = await createPluginRuntimeTestHost({
		site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
	});
	if (provider === "umami") {
		const saved = await runtime.actions.plugin.updateSettings({
			provider: "umami",
			umamiApiKey: "umami_test",
			umamiWebsiteId: UMAMI_WEBSITE,
		});
		expect(saved).toMatchObject({ success: true });
	} else {
		await runtime.fixtures.plugin.setting("provider", "demo");
	}
	return runtime;
}

/** The website the Umami fixtures are configured with. */
export const UMAMI_WEBSITE = "11111111-2222-4333-8444-555555555555";

const UMAMI_FILTERS = `path=${encodeURIComponent("nre.^/_emdash(/|$)")}&hostname=${encodeURIComponent("eq.example.test,www.example.test")}`;

/** The `timezone` parameter, sent to the routes whose schema has one. */
const UMAMI_ZONE = `timezone=${encodeURIComponent(DEFAULT_TIME_ZONE)}`;

/** Whole days in the settings' default zone, from local midnight to the last millisecond. */
function umamiRange(since: string, until: string): string {
	return `startAt=${dayStartMs(since, DEFAULT_TIME_ZONE)}&endAt=${dayEndMs(until, DEFAULT_TIME_ZONE)}`;
}

/**
 * The exact URLs the Umami adapter requests for the fixture site, written
 * out here rather than taken from the adapter: the test host answers a URL
 * only when it matches to the character, so a request that changes shape
 * finds no response and fails the tick.
 */
export const umamiUrl = {
	readValues: (depth: string) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/event-data/values?${umamiRange(addDays(TODAY, -29), TODAY)}&${UMAMI_FILTERS}&eventName=post_read&propertyName=post&epf0=${encodeURIComponent(`1.eq.depth.${depth}`)}`,
	readSeries: (depth: string) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/events/series?${umamiRange(addDays(TODAY, -89), TODAY)}&${UMAMI_ZONE}&${UMAMI_FILTERS}&unit=day&event=${encodeURIComponent("eq.post_read")}&epf0=${encodeURIComponent(`1.eq.depth.${depth}`)}`,
	eventData: (since: string, until: string) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/event-data/events?${umamiRange(since, until)}&event=${encodeURIComponent("eq.emdash-umami-analytics:page-views")}&match=any&path=${encodeURIComponent("nre.^/_emdash(/|$)")}&eventType=1`,
	stats: (day: string, base = "https://api.umami.is/v1") =>
		`${base}/websites/${UMAMI_WEBSITE}/stats?${umamiRange(day, day)}&${UMAMI_ZONE}&${UMAMI_FILTERS}`,
	metrics: (type: "path" | "referrer" | "country", since: string, until: string, limit: number) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/metrics/expanded?${umamiRange(since, until)}&${UMAMI_ZONE}&${UMAMI_FILTERS}&type=${type}&limit=${limit}`,
	dayPaths: (day: string) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/metrics/expanded?${umamiRange(day, day)}&${UMAMI_ZONE}&${UMAMI_FILTERS}&type=path&limit=10000`,
	hostnames: (since: string, until: string) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/metrics/expanded?${umamiRange(since, until)}&${UMAMI_ZONE}&path=${encodeURIComponent("nre.^/_emdash(/|$)")}&type=hostname&limit=50`,
	websites: () => "https://api.umami.is/v1/websites?includeTeams=true&pageSize=100",
	teams: () => "https://api.umami.is/v1/me/teams?pageSize=4",
	teamWebsites: (teamId: string) => `https://api.umami.is/v1/teams/${teamId}/websites?pageSize=100`,
};

/** A page of results, as Umami's list endpoints answer. */
export function umamiPage(rows: unknown[]): Response {
	return umamiJson({ data: rows, count: rows.length, page: 1, pageSize: 100 });
}

/**
 * Answer a website discovery: the user's own websites, and one team per
 * entry of `teams` with that team's websites.
 */
export async function respondUmamiWebsites(
	runtime: PluginRuntimeTestHost,
	own: Array<{ id: string; name?: string; domain?: string }>,
	teams: Array<Array<{ id: string; name?: string; domain?: string }>> = [],
) {
	await runtime.http.respond(umamiUrl.websites(), umamiPage(own));
	await runtime.http.respond(umamiUrl.teams(), umamiPage(teams.map((_, i) => ({ id: `team-${i}`, name: `Team ${i}` }))));
	for (const [i, websites] of teams.entries()) {
		await runtime.http.respond(umamiUrl.teamWebsites(`team-${i}`), umamiPage(websites));
	}
}

export function umamiJson(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function umamiStats(pageviews: number, visits: number, visitors = visits) {
	return umamiJson({ pageviews, visitors, visits, bounces: 0, totaltime: 0 });
}

export function umamiRows(rows: Array<[name: string, pageviews: number, visits: number]>) {
	return umamiJson(rows.map(([name, pageviews, visits]) => ({ name, pageviews, visitors: visits, visits, bounces: 0, totaltime: 0 })));
}

/** Answer one overview: totals for today and yesterday, and the three breakdowns over the widget's week. */
export async function respondUmamiOverview(
	runtime: PluginRuntimeTestHost,
	opts: {
		since?: string;
		today?: [number, number];
		yesterday?: [number, number];
		paths?: Array<[string, number, number]>;
		/** Page view event data as `event-data/events` counts it: property, value, page views. */
		eventData?: Array<[string, string, number]>;
	} = {},
) {
	const since = opts.since ?? addDays(TODAY, -6);
	// The analytics page reads event data in place of yesterday's totals;
	// a sync tick reads yesterday. Either finds its answer here.
	await runtime.http.respond(umamiUrl.eventData(since, TODAY), umamiEventData(opts.eventData ?? []));
	await runtime.http.respond(umamiUrl.stats(TODAY), umamiStats(...(opts.today ?? [10, 5])));
	await runtime.http.respond(umamiUrl.stats(addDays(TODAY, -1)), umamiStats(...(opts.yesterday ?? [20, 8])));
	await runtime.http.respond(umamiUrl.metrics("path", since, TODAY, 100), umamiRows(opts.paths ?? [["/", 30, 13]]));
	await runtime.http.respond(umamiUrl.metrics("referrer", since, TODAY, 20), umamiRows([["google.com", 9, 6]]));
	await runtime.http.respond(umamiUrl.metrics("country", since, TODAY, 50), umamiRows([["DE", 25, 11]]));
}

/** Read-through settings as a site sending `post_read` with `post` and `depth` would enter them. */
export async function setReadSettings(runtime: PluginRuntimeTestHost, depths = "half,end") {
	await runtime.fixtures.plugin.setting("readEvent", "post_read");
	await runtime.fixtures.plugin.setting("readEntryProperty", "post");
	await runtime.fixtures.plugin.setting("readDepthProperty", "depth");
	await runtime.fixtures.plugin.setting("readDepthValues", depths);
}

/**
 * Answer one read of the read event: per depth, reads by entry over 30 days
 * and by day over 90.
 */
export async function respondReads(
	runtime: PluginRuntimeTestHost,
	byDepth: Record<string, { entries: Array<[value: string, reads: number]>; days: Array<[day: string, reads: number]> }>,
) {
	for (const [depth, { entries, days }] of Object.entries(byDepth)) {
		await runtime.http.respond(umamiUrl.readValues(depth), umamiJson(entries.map(([value, total]) => ({ value, total }))));
		await runtime.http.respond(
			umamiUrl.readSeries(depth),
			umamiJson(days.map(([day, y]) => ({ x: "post_read", t: `${day}T00:00:00Z`, y }))),
		);
	}
}

/** `event-data/events` rows for page views: no event name, one row per property and value. */
export function umamiEventData(rows: Array<[property: string, value: string, pageviews: number]>): Response {
	return umamiJson(
		rows.map(([propertyName, propertyValue, total]) => ({ eventName: null, propertyName, dataType: 1, propertyValue, total })),
	);
}

export async function setState(runtime: PluginRuntimeTestHost, state: SyncState) {
	await runtime.fixtures.plugin.kv("state", state);
}

export async function seedEntries(runtime: PluginRuntimeTestHost, paths: string[], views = 0) {
	for (const path of paths) {
		await runtime.fixtures.plugin.storage("entries", path, {
			path,
			collection: "posts",
			entryId: `id${path}`,
			translationGroup: `id${path}`,
			locale: "en",
			title: path,
			status: "published",
			views7: views,
			views30: views,
			updatedAt: NOW.toISOString(),
		});
	}
}

export async function seedRollup(runtime: PluginRuntimeTestHost, days: number) {
	for (let i = 0; i < days; i++) {
		const date = addDays(TODAY, -i);
		await runtime.fixtures.plugin.storage("rollup", date, {
			date,
			pageviews: 10,
			visits: 5,
			sampleInterval: 1,
			fetchedAt: NOW.toISOString(),
		});
	}
}

export async function seedDaily(runtime: PluginRuntimeTestHost, paths: string[], dates: string[]) {
	for (const date of dates) {
		for (const path of paths) {
			await runtime.fixtures.plugin.storage("daily", `${date}|${path}`, {
				date,
				path,
				pageviews: 3,
				visits: 2,
				sampleInterval: 1,
				fetchedAt: NOW.toISOString(),
			});
		}
	}
}

export async function routableCollection(runtime: PluginRuntimeTestHost, published: number, drafts = 0) {
	await runtime.fixtures.collection({
		slug: "posts",
		label: "Posts",
		urlPattern: "/blog/{slug}",
		routable: true,
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	const ids: string[] = [];
	for (let i = 0; i < published + drafts; i++) {
		const draft = i >= published;
		const item = await runtime.fixtures.content("posts", {
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: draft ? "draft" : "published",
			...(draft ? {} : { publishedAt: NOW.toISOString() }),
		});
		ids.push(item.id);
	}
	return ids;
}

export function pathsOf(count: number, prefix = "/p-"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}/`);
}

export function daysBack(count: number): string[] {
	return Array.from({ length: count }, (_, i) => addDays(TODAY, -i));
}

export const tick = (runtime: PluginRuntimeTestHost, name = "sync") => () =>
	runtime.transport.invokeHook("cron", { name, scheduledAt: NOW.toISOString() });

/**
 * A chained catch-up run that is already pending. With it in the state a
 * sync starts no chain of its own, so a test can measure the sync as it
 * runs outside one.
 */
export const pendingChain = { next: "catchup-a", at: new Date(NOW.getTime() + 50_000).toISOString() };

/** A site that is fully caught up: index walked by this build, today's older pass done. */
export const synced: SyncState = {
	phase: "overview",
	provider: "demo",
	dayZone: DEFAULT_TIME_ZONE,
	backfilled: true,
	indexComplete: true,
	indexVersion: INDEX_VERSION,
	older: { day: TODAY, complete: true },
	lastSync: NOW.toISOString(),
};
