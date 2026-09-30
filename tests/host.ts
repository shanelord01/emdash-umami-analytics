import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { expect, vi } from "vitest";

import { INDEX_VERSION } from "../src/index/bootstrap.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { addDays, utcDay } from "../src/sync/window.js";

/**
 * Fixtures for tests that run the plugin inside the runtime test host.
 *
 * The host itself is created and disposed by each test file, because
 * disposal belongs in that file's `afterEach`.
 */

export const NOW = new Date();
export const TODAY = utcDay(NOW);

export async function newHost(provider: "demo" | "cloudflare" | "umami" = "demo") {
	if (provider !== "demo") {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	}
	const runtime = await createPluginRuntimeTestHost({
		site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
	});
	if (provider === "cloudflare") {
		const saved = await runtime.actions.plugin.updateSettings({
			cfApiToken: "cfat_test",
			cfAccountId: "acct-1",
			cfSiteTag: "tag-1",
		});
		expect(saved).toMatchObject({ success: true });
	} else if (provider === "umami") {
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

function umamiRange(since: string, until: string): string {
	const start = Date.parse(`${since}T00:00:00.000Z`);
	const end = Date.parse(`${until}T23:59:59.999Z`);
	return `startAt=${start}&endAt=${end}`;
}

/**
 * The exact URLs the Umami adapter requests for the fixture site, written
 * out here rather than taken from the adapter: the test host answers a URL
 * only when it matches to the character, so a request that changes shape
 * finds no response and fails the tick.
 */
export const umamiUrl = {
	stats: (day: string, base = "https://api.umami.is/v1") =>
		`${base}/websites/${UMAMI_WEBSITE}/stats?${umamiRange(day, day)}&${UMAMI_FILTERS}`,
	metrics: (type: "path" | "referrer" | "country", since: string, until: string, limit: number) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/metrics/expanded?${umamiRange(since, until)}&${UMAMI_FILTERS}&type=${type}&limit=${limit}`,
	dayPaths: (day: string) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/metrics/expanded?${umamiRange(day, day)}&${UMAMI_FILTERS}&type=path&limit=10000`,
	hostnames: (since: string, until: string) =>
		`https://api.umami.is/v1/websites/${UMAMI_WEBSITE}/metrics/expanded?${umamiRange(since, until)}&path=${encodeURIComponent("nre.^/_emdash(/|$)")}&type=hostname&limit=50`,
	websites: () => "https://api.umami.is/v1/websites?includeTeams=1&pageSize=100",
};

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
	opts: { since?: string; today?: [number, number]; yesterday?: [number, number]; paths?: Array<[string, number, number]> } = {},
) {
	const since = opts.since ?? addDays(TODAY, -6);
	await runtime.http.respond(umamiUrl.stats(TODAY), umamiStats(...(opts.today ?? [10, 5])));
	await runtime.http.respond(umamiUrl.stats(addDays(TODAY, -1)), umamiStats(...(opts.yesterday ?? [20, 8])));
	await runtime.http.respond(umamiUrl.metrics("path", since, TODAY, 100), umamiRows(opts.paths ?? [["/", 30, 13]]));
	await runtime.http.respond(umamiUrl.metrics("referrer", since, TODAY, 20), umamiRows([["google.com", 9, 6]]));
	await runtime.http.respond(umamiUrl.metrics("country", since, TODAY, 50), umamiRows([["DE", 25, 11]]));
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

export function graphql(body: unknown): Response {
	return new Response(JSON.stringify({ data: { viewer: { accounts: [body] } } }), {
		headers: { "Content-Type": "application/json" },
	});
}

export const tick = (runtime: PluginRuntimeTestHost, name = "sync") => () =>
	runtime.transport.invokeHook("cron", { name, scheduledAt: NOW.toISOString() });

/** A site that is fully caught up: index walked by this build, today's older pass done. */
export const synced: SyncState = {
	phase: "overview",
	provider: "demo",
	backfilled: true,
	indexComplete: true,
	indexVersion: INDEX_VERSION,
	older: { day: TODAY, complete: true },
	lastSync: NOW.toISOString(),
};
