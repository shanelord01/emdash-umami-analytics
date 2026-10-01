import { describe, expect, it } from "vitest";

import type { FetchLike } from "../src/providers/types.js";
import {
	createUmamiProvider,
	MAX_DAY_PATHS,
	MAX_TEAMS_READ,
	UMAMI_CLOUD_API,
	umamiDashboardUrl,
} from "../src/providers/umami.js";

const WEBSITE = "11111111-2222-4333-8444-555555555555";
const RANGE = { since: "2026-09-14", until: "2026-09-20" };

interface Call {
	url: URL;
	headers: Record<string, string>;
	method: string;
}

type Reply = { body: unknown; status?: number; type?: string };

/**
 * Captures what the adapter sent and answers each request by what it asked
 * for: the endpoint, and for `metrics/expanded` the column it groups by.
 */
function recorder(answer: (call: Call) => Reply) {
	const calls: Call[] = [];
	const fetch: FetchLike = async (url, init) => {
		const call: Call = {
			url: new URL(url),
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			method: init?.method ?? "GET",
		};
		calls.push(call);
		const reply = answer(call);
		return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
			status: reply.status ?? 200,
			headers: { "Content-Type": reply.type ?? "application/json" },
		});
	};
	return { calls, fetch };
}

/** The last path segment, and for a metrics request its `type`. */
function kind(call: Call): string {
	const endpoint = call.url.pathname.split("/").pop()!;
	return endpoint === "expanded" ? `metrics:${call.url.searchParams.get("type")}` : endpoint;
}

function dayOf(call: Call): string {
	return new Date(Number(call.url.searchParams.get("startAt"))).toISOString().slice(0, 10);
}

const row = (name: string, pageviews: number, visits: number, visitors = visits) => ({
	name,
	pageviews,
	visitors,
	visits,
	bounces: 0,
	totaltime: 0,
});

const stats = (pageviews: number, visits: number, visitors: number) => ({
	pageviews,
	visitors,
	visits,
	bounces: 0,
	totaltime: 0,
	comparison: { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 },
});

/** A website that answers every endpoint with nothing. */
const quiet = (call: Call): Reply => ({ body: kind(call) === "stats" ? stats(0, 0, 0) : [] });

function provider(fetch: FetchLike, over: Partial<Parameters<typeof createUmamiProvider>[0]> = {}) {
	return createUmamiProvider({
		apiKey: "umami_secret",
		websiteId: WEBSITE,
		hosts: ["example.com", "www.example.com"],
		fetch,
		...over,
	});
}

describe("every request", () => {
	it("is a GET with the key as a bearer token, to Umami Cloud unless told otherwise", async () => {
		const { calls, fetch } = recorder(quiet);
		await provider(fetch).overview(RANGE);
		expect(calls).toHaveLength(5);
		for (const call of calls) {
			expect(call.method).toBe("GET");
			expect(call.headers.authorization).toBe("Bearer umami_secret");
			expect(call.url.href.startsWith(`${UMAMI_CLOUD_API}/websites/${WEBSITE}/`)).toBe(true);
		}
	});

	it("goes to a self-hosted Umami's API when its URL is set", async () => {
		const { calls, fetch } = recorder(quiet);
		await provider(fetch, { apiUrl: " https://stats.example.com/api/ " }).dayTotals?.("2026-09-20");
		expect(calls[0]!.url.origin).toBe("https://stats.example.com");
		expect(calls[0]!.url.pathname).toBe(`/api/websites/${WEBSITE}/stats`);
	});

	it("refuses an API URL that is no web address, without sending anything", async () => {
		const { calls, fetch } = recorder(quiet);
		const res = await provider(fetch, { apiUrl: "stats.example.com/api" }).dayTotals?.("2026-09-20");
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiBadUrl" } });
		expect(calls).toHaveLength(0);
	});

	it("covers whole UTC days, from the first millisecond to the last", async () => {
		const { calls, fetch } = recorder(quiet);
		await provider(fetch).overview(RANGE);
		const ranged = calls.find((call) => kind(call) === "metrics:path")!;
		expect(ranged.url.searchParams.get("startAt")).toBe(String(Date.parse("2026-09-14T00:00:00.000Z")));
		expect(ranged.url.searchParams.get("endAt")).toBe(String(Date.parse("2026-09-20T23:59:59.999Z")));
	});

	it("keeps admin page views out, the totals included", async () => {
		// The totals have no path to drop rows by afterwards, so the filter
		// has to be on the request, and on every request alike.
		const { calls, fetch } = recorder(quiet);
		await provider(fetch).overview(RANGE);
		for (const call of calls) expect(call.url.searchParams.get("path")).toBe("nre.^/_emdash(/|$)");
	});

	it("filters on the configured hostnames, as an explicit list", async () => {
		// Without the `eq.` prefix Umami reads a leading `t.` as its "true"
		// operator, so the hostname t.co would filter on nothing sensible.
		const { calls, fetch } = recorder(quiet);
		await provider(fetch, { hosts: ["t.co", "WWW.T.CO."] }).overview(RANGE);
		for (const call of calls) expect(call.url.searchParams.get("hostname")).toBe("eq.t.co,www.t.co");
	});

	it("sends no hostname filter when no hosts are configured", async () => {
		const { calls, fetch } = recorder(quiet);
		await provider(fetch, { hosts: [] }).overview(RANGE);
		for (const call of calls) expect(call.url.searchParams.has("hostname")).toBe(false);
	});
});

describe("the overview", () => {
	const busy = (call: Call): Reply => {
		switch (kind(call)) {
			case "stats":
				return { body: dayOf(call) === "2026-09-20" ? stats(40, 12, 9) : stats(70, 30, 21) };
			case "metrics:path":
				return { body: [row("/about", 5, 4), row("/", 90, 30), row("/about/", 7, 5), row("/_emdash", 3, 1)] };
			case "metrics:referrer":
				return { body: [row("duckduckgo.com", 3, 2), row("google.com", 20, 11)] };
			default:
				return { body: [row("de", 50, 20), row("AT", 9, 6)] };
		}
	};

	it("takes daily totals for the last day and the day before from stats, visits and visitors apart", async () => {
		// The pageviews series has a `sessions` line, but that is visitors.
		// A day's visits are only in its own stats.
		const { calls, fetch } = recorder(busy);
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.series).toEqual([
			{ date: "2026-09-19", pageviews: 70, visits: 30, uniques: 21, bounces: 0, totaltime: 0, sampleInterval: 1 },
			{ date: "2026-09-20", pageviews: 40, visits: 12, uniques: 9, bounces: 0, totaltime: 0, sampleInterval: 1 },
		]);
		expect(res.value.totals).toEqual({ pageviews: 110, visits: 42, sampleInterval: 1 });
		expect(calls.filter((call) => kind(call) === "stats").map(dayOf).sort()).toEqual(["2026-09-19", "2026-09-20"]);
	});

	it("adds up both spellings of a path, drops the admin and ranks by page views", async () => {
		const { fetch } = recorder(busy);
		const res = await provider(fetch, { trailingSlash: "always" }).overview(RANGE);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.topPaths).toEqual([
			{ path: "/", pageviews: 90, visits: 30, sampleInterval: 1 },
			{ path: "/about/", pageviews: 12, visits: 9, sampleInterval: 1 },
		]);
	});

	it("ranks referrers by visits and hands countries on as upper-case codes", async () => {
		const { fetch } = recorder(busy);
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.referrers.map((r) => r.label)).toEqual(["google.com", "duckduckgo.com"]);
		expect(res.value.countries).toEqual([
			{ label: "DE", visits: 20, pageviews: 50 },
			{ label: "AT", visits: 6, pageviews: 9 },
		]);
	});

	it("keeps a day without page views missing rather than zero", async () => {
		const { fetch } = recorder((call) => ({
			body: kind(call) !== "stats" ? [] : dayOf(call) === "2026-09-20" ? stats(4, 2, 2) : stats(0, 0, 0),
		}));
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value.series.map((d) => d.date)).toEqual(["2026-09-20"]);
	});

	it("reads counts that arrive as strings of digits", async () => {
		const { fetch } = recorder((call) => ({
			body: kind(call) === "stats" ? stats(4, 2, 2) : [{ name: "/a", pageviews: "12", visitors: "3", visits: "5" }],
		}));
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value.topPaths[0]).toMatchObject({ pageviews: 12, visits: 5 });
	});

	it("sends one request and stops when that one fails", async () => {
		// The caller's fallback has a budget of its own, and every request a
		// failed overview sent comes out of it.
		const { calls, fetch } = recorder(() => ({ body: { error: { code: "unauthorized" } }, status: 401 }));
		const umami = provider(fetch);
		const res = await umami.overview(RANGE);
		expect(res.ok).toBe(false);
		expect(calls).toHaveLength(1);
		expect(umami.requests?.()).toBe(1);
	});

	it("fails as a whole when a later request fails, and says how many it sent", async () => {
		const { fetch } = recorder((call) =>
			kind(call) === "metrics:country" ? { body: "", status: 429 } : { body: kind(call) === "stats" ? stats(1, 1, 1) : [] },
		);
		const umami = provider(fetch);
		const res = await umami.overview(RANGE);
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiRateLimited" } });
		expect(umami.requests?.()).toBe(5);
	});

	it("rejects an inverted range without asking", async () => {
		const { calls, fetch } = recorder(quiet);
		const res = await provider(fetch).overview({ since: "2026-09-20", until: "2026-09-18" });
		expect(res.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("a day's paths", () => {
	it("asks for one UTC day with a limit far above Umami's default of 500", async () => {
		const { calls, fetch } = recorder(quiet);
		await provider(fetch).day?.("2026-09-18");
		expect(calls).toHaveLength(1);
		expect(dayOf(calls[0]!)).toBe("2026-09-18");
		expect(calls[0]!.url.searchParams.get("endAt")).toBe(String(Date.parse("2026-09-18T23:59:59.999Z")));
		expect(Number(calls[0]!.url.searchParams.get("limit"))).toBe(MAX_DAY_PATHS);
	});

	it("folds the spellings of a path into one dated row", async () => {
		const { fetch } = recorder(() => ({ body: [row("/contact", 2, 2), row("/contact/", 3, 1), row("/_emdash/admin", 9, 9)] }));
		const res = await provider(fetch, { trailingSlash: "always" }).day?.("2026-09-18");
		expect(res).toEqual({
			ok: true,
			value: [{ date: "2026-09-18", path: "/contact/", pageviews: 5, visits: 3, sampleInterval: 1 }],
		});
	});

	it("reports a day with more paths than it reads instead of storing part of it", async () => {
		const rows = Array.from({ length: MAX_DAY_PATHS }, (_, i) => row(`/p${i}`, 1, 1));
		const { fetch } = recorder(() => ({ body: rows }));
		const res = await provider(fetch).day?.("2026-09-18");
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiTruncated" } });
	});

	it("answers for specific paths with one request per day, narrowed after normalizing", async () => {
		const { calls, fetch } = recorder((call) => ({
			body: dayOf(call) === "2026-09-19" ? [row("/a", 2, 1), row("/b/", 5, 4), row("/c", 8, 8)] : [row("/b", 1, 1)],
		}));
		const res = await provider(fetch, { trailingSlash: "always" }).paths(["/a/", "/b/"], {
			since: "2026-09-19",
			until: "2026-09-20",
		});
		expect(calls).toHaveLength(2);
		expect(res).toEqual({
			ok: true,
			value: [
				{ date: "2026-09-19", path: "/a/", pageviews: 2, visits: 1, sampleInterval: 1 },
				{ date: "2026-09-19", path: "/b/", pageviews: 5, visits: 4, sampleInterval: 1 },
				{ date: "2026-09-20", path: "/b/", pageviews: 1, visits: 1, sampleInterval: 1 },
			],
		});
	});

	it("does not call the API for an empty path list", async () => {
		const { calls, fetch } = recorder(quiet);
		expect(await provider(fetch).paths([], RANGE)).toEqual({ ok: true, value: [] });
		expect(calls).toHaveLength(0);
	});
});

describe("a day's totals", () => {
	it("maps visits to visits, visitors to uniques, and keeps bounces and visit time", async () => {
		const { fetch } = recorder(() => ({ body: { ...stats(31, 14, 11), bounces: 9, totaltime: 1162 } }));
		expect(await provider(fetch).dayTotals?.("2026-09-18")).toEqual({
			ok: true,
			value: { date: "2026-09-18", pageviews: 31, visits: 14, uniques: 11, bounces: 9, totaltime: 1162, sampleInterval: 1 },
		});
	});

	it("is null for a day without page views", async () => {
		const { fetch } = recorder(() => ({ body: stats(0, 0, 0) }));
		expect(await provider(fetch).dayTotals?.("2026-09-18")).toEqual({ ok: true, value: null });
	});
});

describe("error mapping", () => {
	const failing = (reply: Reply) => provider(recorder(() => reply).fetch).dayTotals?.("2026-09-20");
	const unauthorized = { error: { message: "Unauthorized", code: "unauthorized", status: 401 } };

	it("says a 401 is the key or the website, because Umami answers both that way", async () => {
		const res = await failing({ body: unauthorized, status: 401 });
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiUnauthorized" } });
		if (res && !res.ok) expect(res.error).toMatch(/API key is wrong or revoked, or its user cannot view this website/);
	});

	it("reads 403 and 404 as a website the key cannot see", async () => {
		for (const status of [403, 404]) {
			const res = await failing({ body: { error: { status } }, status });
			expect(res).toMatchObject({ ok: false, problem: { key: "umamiNoWebsite", params: { status } } });
		}
	});

	it("recognizes a web page where JSON belongs, whatever status it comes with", async () => {
		// Umami's own refusals are JSON. A sign-in page put in front of the
		// API is HTML, whether it arrives as a 200 after a redirect or with
		// a 401 or 403 of its own, and that is what tells the two apart.
		for (const status of [200, 302, 401, 403]) {
			const res = await failing({ body: "<html><title>Sign in</title></html>", status, type: "text/html" });
			expect(res, String(status)).toMatchObject({ ok: false, problem: { key: "umamiProxy", params: { status } } });
		}
	});

	it("names the rate limit on a 429", async () => {
		const res = await failing({ body: "Too many requests", status: 429, type: "text/plain" });
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiRateLimited" } });
	});

	it("reports a gateway's error page as the HTTP error it is", async () => {
		const res = await failing({ body: "<html>Bad gateway</html>", status: 502, type: "text/html" });
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiHttp", params: { status: 502 } } });
	});

	it("turns a transport failure into a value that keeps the reason", async () => {
		const fetch: FetchLike = async () => {
			throw new Error("connection timed out");
		};
		const res = await provider(fetch).dayTotals?.("2026-09-20");
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiUnreachable" } });
		if (res && !res.ok) expect(res.error).toBe("Umami could not be reached: connection timed out");
	});

	it("survives a response in another shape", async () => {
		for (const body of [null, [], "text", 42, { data: [] }]) {
			const { fetch } = recorder(() => ({ body }));
			const umami = provider(fetch);
			// Either a clean error or empty numbers, never a thrown exception.
			expect(typeof (await umami.dayTotals?.("2026-09-20"))?.ok).toBe("boolean");
			expect(typeof (await umami.day?.("2026-09-20"))?.ok).toBe("boolean");
			expect(typeof (await umami.overview(RANGE)).ok).toBe("boolean");
		}
		const { fetch } = recorder(() => ({ body: { rows: [] } }));
		expect(await provider(fetch).day?.("2026-09-20")).toMatchObject({ ok: false, problem: { key: "umamiUnexpected" } });
	});
});

describe("site discovery", () => {
	const DISCOVERY = { since: "2026-09-14", until: "2026-09-20" };
	const websites = {
		data: [
			{ id: "site-a", name: "Blog", domain: "Example.com" },
			{ id: "site-b", name: "Shop", domain: "shop.example" },
			{ name: "no id" },
		],
		count: 2,
		page: 1,
		pageSize: 100,
	};

	const teams = (...ids: string[]) => ({ data: ids.map((id) => ({ id, name: id })), count: ids.length, page: 1, pageSize: 4 });
	const page = (...rows: Array<{ id: string; name?: string; domain?: string }>) => ({
		data: rows,
		count: rows.length,
		page: 1,
		pageSize: 100,
	});
	const refusal: Reply = { body: { error: { message: "Unauthorized", code: "unauthorized", status: 401 } }, status: 401 };

	/** Answers the three list endpoints from a table keyed by path under `/v1`. */
	const listing = (table: Record<string, Reply>) => (call: Call) =>
		table[call.url.pathname.replace("/v1", "")] ?? { body: { error: {} }, status: 500 };

	it("lists the user's own websites and their teams' websites, each once", async () => {
		const { calls, fetch } = recorder(
			listing({
				"/websites": { body: websites },
				"/me/teams": { body: teams("team-1", "team-2") },
				"/teams/team-1/websites": { body: page({ id: "site-a", name: "Blog" }, { id: "site-c", name: "Docs", domain: "docs.example" }) },
				"/teams/team-2/websites": { body: page({ id: "site-d", name: "Wiki" }) },
			}),
		);
		const res = await provider(fetch, { websiteId: "" }).discoverSites(DISCOVERY);
		expect(res).toEqual({
			ok: true,
			value: [
				{ siteTag: "site-a", name: "Blog", hosts: ["example.com"] },
				{ siteTag: "site-b", name: "Shop", hosts: ["shop.example"] },
				{ siteTag: "site-c", name: "Docs", hosts: ["docs.example"] },
				{ siteTag: "site-d", name: "Wiki", hosts: [] },
			],
		});
		expect(calls).toHaveLength(4);
		expect(calls[0]!.url.pathname).toBe("/v1/websites");
		// Websites of teams the user owns or manages are only in that list
		// when asked for.
		expect(calls[0]!.url.searchParams.get("includeTeams")).toBe("true");
	});

	it("finds a team's websites for a member whose own list is empty", async () => {
		// Verified on a live 3.4.0: a team member or view-only member gets
		// `data: []` from /websites, with or without includeTeams, and may
		// still read the team's websites.
		const { fetch } = recorder(
			listing({
				"/websites": { body: page() },
				"/me/teams": { body: teams("team-1") },
				"/teams/team-1/websites": { body: page({ id: "site-t", name: "Team blog", domain: "blog.example" }) },
			}),
		);
		expect(await provider(fetch, { websiteId: "" }).discoverSites(DISCOVERY)).toEqual({
			ok: true,
			value: [{ siteTag: "site-t", name: "Team blog", hosts: ["blog.example"] }],
		});
	});

	it("reads four teams at most, so a discovery stays inside the bridge budget", async () => {
		const { calls, fetch } = recorder((call) =>
			call.url.pathname === "/v1/me/teams"
				? { body: teams("t1", "t2", "t3", "t4", "t5", "t6") }
				: { body: page({ id: `site-of${call.url.pathname.replace(/\W+/g, "-")}` }) },
		);
		const res = await provider(fetch, { websiteId: "" }).discoverSites(DISCOVERY);
		expect(calls.map((call) => call.url.pathname)).toEqual([
			"/v1/websites",
			"/v1/me/teams",
			"/v1/teams/t1/websites",
			"/v1/teams/t2/websites",
			"/v1/teams/t3/websites",
			"/v1/teams/t4/websites",
		]);
		expect(calls[1]!.url.searchParams.get("pageSize")).toBe(String(MAX_TEAMS_READ));
		expect(res.ok && res.value).toHaveLength(5);
	});

	it("keeps what it has when the team list, or one team, does not answer", async () => {
		const noTeams = recorder(listing({ "/websites": { body: websites }, "/me/teams": refusal }));
		const own = await provider(noTeams.fetch, { websiteId: "" }).discoverSites(DISCOVERY);
		expect(own.ok && own.value.map((site) => site.siteTag)).toEqual(["site-a", "site-b"]);
		expect(noTeams.calls).toHaveLength(2);

		const oneTeam = recorder(
			listing({
				"/websites": { body: page() },
				"/me/teams": { body: teams("team-1", "team-2") },
				"/teams/team-1/websites": refusal,
				"/teams/team-2/websites": { body: page({ id: "site-d" }) },
			}),
		);
		const rest = await provider(oneTeam.fetch, { websiteId: "" }).discoverSites(DISCOVERY);
		expect(rest.ok && rest.value.map((site) => site.siteTag)).toEqual(["site-d"]);
	});

	it("says the key is wrong when the user's own list is refused, after one request", async () => {
		const { calls, fetch } = recorder(() => refusal);
		const res = await provider(fetch, { websiteId: "" }).discoverSites(DISCOVERY);
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiBadKey" } });
		expect(calls).toHaveLength(1);
	});

	it("reads the configured website's hostnames without the hostname filter", async () => {
		// With the filter on, a filter that excludes every host would hide
		// the very hosts the setup check has to show.
		const { calls, fetch } = recorder(() => ({ body: [row("Example.com", 80, 30), row("preview.pages.dev", 6, 2)] }));
		const res = await provider(fetch).discoverSites(DISCOVERY);
		expect(res).toEqual({
			ok: true,
			value: [{ siteTag: WEBSITE, hosts: ["example.com", "preview.pages.dev"], pageviews: 86 }],
		});
		expect(calls).toHaveLength(1);
		expect(kind(calls[0]!)).toBe("metrics:hostname");
		expect(calls[0]!.url.searchParams.has("hostname")).toBe(false);
	});

	it("finds no site when the website had no traffic in the window", async () => {
		const { fetch } = recorder(() => ({ body: [] }));
		expect(await provider(fetch).discoverSites(DISCOVERY)).toEqual({ ok: true, value: [] });
	});

	it("tells a website the key cannot view from a wrong key, with one more request", async () => {
		const refused = { body: { error: { code: "unauthorized" } }, status: 401 };
		const keyWorks = recorder((call) => (call.url.pathname.endsWith("/websites") ? { body: websites } : refused));
		expect(await provider(keyWorks.fetch).discoverSites(DISCOVERY)).toMatchObject({
			ok: false,
			problem: { key: "umamiNoWebsite" },
		});
		expect(keyWorks.calls).toHaveLength(2);

		const keyWrong = recorder(() => refused);
		expect(await provider(keyWrong.fetch).discoverSites(DISCOVERY)).toMatchObject({
			ok: false,
			problem: { key: "umamiBadKey" },
		});
	});
});

describe("the dashboard link", () => {
	it("opens the website on Umami Cloud, or beside a self-hosted API", () => {
		expect(umamiDashboardUrl(WEBSITE)).toBe(`https://cloud.umami.is/websites/${WEBSITE}`);
		expect(umamiDashboardUrl(WEBSITE, "https://stats.example.com/api")).toBe(
			`https://stats.example.com/websites/${WEBSITE}`,
		);
		expect(umamiDashboardUrl(WEBSITE, "https://example.com/umami/api/")).toBe(
			`https://example.com/umami/websites/${WEBSITE}`,
		);
	});

	it("gives no link without a website, or where the API URL does not say where the dashboard is", () => {
		expect(umamiDashboardUrl("")).toBeNull();
		expect(umamiDashboardUrl(WEBSITE, "https://stats.example.com/v2")).toBeNull();
	});
});

describe("page views by event data", () => {
	const eventRows = [
		{ eventName: null, propertyName: "category", dataType: 1, propertyValue: "fuel-planning", total: 3 },
		{ eventName: null, propertyName: "category", dataType: 1, propertyValue: "our-trips", total: 7 },
		{ eventName: null, propertyName: "tags", dataType: 1, propertyValue: "queensland,towing", total: 4 },
		{ eventName: null, propertyName: "tags", dataType: 1, propertyValue: " towing , outback", total: 2 },
		{ eventName: null, propertyName: "section", dataType: 1, propertyValue: "blog_post", total: 9 },
		// A custom event's data, which must not count as page views.
		{ eventName: "cta_click", propertyName: "category", dataType: 1, propertyValue: "our-trips", total: 50 },
	];
	const withEventData = (call: Call): Reply =>
		call.url.pathname.endsWith("/event-data/events")
			? { body: eventRows }
			: { body: kind(call) === "stats" ? stats(4, 2, 2) : [] };

	it("reads them in place of the day before's totals, so the overview is still five requests", async () => {
		const { calls, fetch } = recorder(withEventData);
		const umami = provider(fetch);
		const res = await umami.overview(RANGE, { properties: ["category"] });

		expect(res.ok).toBe(true);
		expect(calls).toHaveLength(5);
		expect(calls.filter((call) => kind(call) === "stats").map(dayOf)).toEqual(["2026-09-20"]);
		if (res.ok) expect(res.value.series.map((row) => row.date)).toEqual(["2026-09-20"]);
	});

	it("asks for page views only, per property value, keeping the admin out", async () => {
		// `event` alone would filter on an event name, which page views do
		// not have. With `match=any` the path filter carries the query, and
		// `eventType=1` keeps custom events out whatever `match` says.
		const { calls, fetch } = recorder(withEventData);
		await provider(fetch).overview(RANGE, { properties: ["category"] });
		const asked = calls.find((call) => call.url.pathname.endsWith("/event-data/events"))!;
		expect(Object.fromEntries(asked.url.searchParams)).toEqual({
			startAt: String(Date.parse("2026-09-14T00:00:00.000Z")),
			endAt: String(Date.parse("2026-09-20T23:59:59.999Z")),
			event: "eq.emdash-umami-analytics:page-views",
			match: "any",
			path: "nre.^/_emdash(/|$)",
			eventType: "1",
		});
	});

	it("counts page views per value, splits comma-separated values and leaves custom events out", async () => {
		const { fetch } = recorder(withEventData);
		const res = await provider(fetch).overview(RANGE, { properties: ["category", "tags", "byline"] });
		expect(res.ok && res.value.properties).toEqual([
			{
				property: "category",
				values: [
					{ value: "our-trips", pageviews: 7 },
					{ value: "fuel-planning", pageviews: 3 },
				],
			},
			{
				property: "tags",
				values: [
					{ value: "towing", pageviews: 6 },
					{ value: "queensland", pageviews: 4 },
					{ value: "outback", pageviews: 2 },
				],
			},
			// Asked for and never sent: listed, with nothing in it.
			{ property: "byline", values: [] },
		]);
	});

	it("keeps the rest of the overview when the event data cannot be read", async () => {
		const { fetch } = recorder((call) =>
			call.url.pathname.endsWith("/event-data/events")
				? { body: { error: { code: "unauthorized" } }, status: 401 }
				: { body: kind(call) === "stats" ? stats(4, 2, 2) : [] },
		);
		const res = await provider(fetch).overview(RANGE, { properties: ["category"] });
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value.properties).toBeUndefined();
	});

	it("reads no event data unless asked", async () => {
		const { calls, fetch } = recorder(withEventData);
		const res = await provider(fetch).overview(RANGE);
		expect(calls.some((call) => call.url.pathname.endsWith("/event-data/events"))).toBe(false);
		if (res.ok) expect(res.value.properties).toBeUndefined();
	});
});

describe("read-through", () => {
	const spec = { event: "post_read", entryProperty: "post", depthProperty: "depth", depths: ["half", "end"] };
	const ranges = {
		entries: { since: "2026-09-01", until: "2026-09-30" },
		daily: { since: "2026-07-03", until: "2026-09-30" },
	};
	const answer = (call: Call): Reply => {
		const depth = call.url.searchParams.get("epf0")?.split(".").pop();
		if (call.url.pathname.endsWith("/event-data/values")) {
			return { body: depth === "half" ? [{ value: "a-post", total: 30 }, { value: "/blog/b-post", total: 21 }] : [{ value: "a-post", total: 43 }] };
		}
		return {
			body:
				depth === "half"
					? [{ x: "post_read", t: "2026-09-29T00:00:00Z", y: 20 }, { x: "post_read", t: "2026-09-30T00:00:00Z", y: 31 }]
					: [{ x: "post_read", t: "2026-09-30T00:00:00Z", y: 43 }],
		};
	};

	it("asks two documented custom-event routes per depth, narrowed to the depth", async () => {
		const { calls, fetch } = recorder(answer);
		await provider(fetch).readThrough?.(spec, ranges);
		expect(calls).toHaveLength(4);
		const values = calls.filter((call) => call.url.pathname.endsWith("/event-data/values"));
		const series = calls.filter((call) => call.url.pathname.endsWith("/events/series"));
		expect(values.map((call) => call.url.searchParams.get("epf0")).sort()).toEqual(["1.eq.depth.end", "1.eq.depth.half"]);
		expect(Object.fromEntries(values[0]!.url.searchParams)).toMatchObject({
			startAt: String(Date.parse("2026-09-01T00:00:00.000Z")),
			eventName: "post_read",
			propertyName: "post",
			// The site's own filters still apply: reads on a preview host do not count.
			hostname: "eq.example.com,www.example.com",
		});
		expect(Object.fromEntries(series[0]!.url.searchParams)).toMatchObject({
			startAt: String(Date.parse("2026-07-03T00:00:00.000Z")),
			unit: "day",
			timezone: "UTC",
			event: "eq.post_read",
		});
	});

	it("counts reads per entry and per day, in the settings' depth order, normalizing a path", async () => {
		const { fetch } = recorder(answer);
		const res = await provider(fetch, { trailingSlash: "always" }).readThrough?.(spec, ranges);
		expect(res).toEqual({
			ok: true,
			value: {
				byEntry: { "a-post": [30, 43], "/blog/b-post/": [21, 0] },
				daily: [
					{ date: "2026-09-29", counts: [20, 0] },
					{ date: "2026-09-30", counts: [31, 43] },
				],
				partial: false,
			},
		});
	});

	it("says when a per-entry list reached the route's 100 rows, so the rest are missing, not unread", async () => {
		const { fetch } = recorder((call) =>
			call.url.pathname.endsWith("/event-data/values")
				? { body: Array.from({ length: 100 }, (_, i) => ({ value: `p-${i}`, total: 1 })) }
				: { body: [] },
		);
		const res = await provider(fetch).readThrough?.(spec, ranges);
		expect(res?.ok && res.value.partial).toBe(true);
	});

	it("escapes a dot in the depth property, which would split the filter", async () => {
		const { calls, fetch } = recorder(() => ({ body: [] }));
		await provider(fetch).readThrough?.({ ...spec, depthProperty: "read.depth", depths: ["end"] }, ranges);
		expect(calls[0]!.url.searchParams.get("epf0")).toBe("1.eq.read%2Edepth.end");
	});

	it("fails as a whole when one request fails", async () => {
		const { fetch } = recorder((call) =>
			call.url.pathname.endsWith("/events/series") ? { body: "Too many requests", status: 429 } : { body: [] },
		);
		expect(await provider(fetch).readThrough?.(spec, ranges)).toMatchObject({ ok: false, problem: { key: "umamiRateLimited" } });
	});
});
