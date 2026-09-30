import { describe, expect, it } from "vitest";

import type { FetchLike } from "../src/providers/types.js";
import {
	createUmamiProvider,
	MAX_DAY_PATHS,
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
	it("is a GET with the key as a bearer token, to Umami Cloud", async () => {
		const { calls, fetch } = recorder(quiet);
		await provider(fetch).overview(RANGE);
		expect(calls).toHaveLength(5);
		for (const call of calls) {
			expect(call.method).toBe("GET");
			expect(call.headers.authorization).toBe("Bearer umami_secret");
			expect(call.url.href.startsWith(`${UMAMI_CLOUD_API}/websites/${WEBSITE}/`)).toBe(true);
		}
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
			{ date: "2026-09-19", pageviews: 70, visits: 30, uniques: 21, sampleInterval: 1 },
			{ date: "2026-09-20", pageviews: 40, visits: 12, uniques: 9, sampleInterval: 1 },
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
	it("maps visits to visits and visitors to uniques", async () => {
		const { fetch } = recorder(() => ({ body: stats(31, 14, 11) }));
		expect(await provider(fetch).dayTotals?.("2026-09-18")).toEqual({
			ok: true,
			value: { date: "2026-09-18", pageviews: 31, visits: 14, uniques: 11, sampleInterval: 1 },
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

	it("lists the websites the key's user can list when no website ID is set", async () => {
		const { calls, fetch } = recorder(() => ({ body: websites }));
		const res = await provider(fetch, { websiteId: "" }).discoverSites(DISCOVERY);
		expect(res).toEqual({
			ok: true,
			value: [
				{ siteTag: "site-a", name: "Blog", hosts: ["example.com"] },
				{ siteTag: "site-b", name: "Shop", hosts: ["shop.example"] },
			],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url.pathname).toBe("/v1/websites");
		// Team websites are only in the list when asked for.
		expect(calls[0]!.url.searchParams.has("includeTeams")).toBe(true);
	});

	it("says the key is wrong when the list itself is refused", async () => {
		const { fetch } = recorder(() => ({ body: { error: { code: "unauthorized" } }, status: 401 }));
		const res = await provider(fetch, { websiteId: "" }).discoverSites(DISCOVERY);
		expect(res).toMatchObject({ ok: false, problem: { key: "umamiBadKey" } });
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
	it("opens the website on Umami Cloud, and gives no link without a website", () => {
		expect(umamiDashboardUrl(WEBSITE)).toBe(`https://cloud.umami.is/websites/${WEBSITE}`);
		expect(umamiDashboardUrl("")).toBeNull();
	});
});
