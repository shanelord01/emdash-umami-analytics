/**
 * The Umami adapter: Umami Cloud and self-hosted Umami, through the same
 * REST API.
 *
 * Three things shape it, each read out of the Umami source at v3.4.0:
 *
 * - **No request groups by day and path.** `metrics/expanded` groups by
 *   one column over one time range, so a day's paths cost one request and
 *   a range of days costs one per day. That is what `wide-pull` tells the
 *   scheduler.
 * - **Daily visits only come from `stats`.** The `pageviews` series has a
 *   `sessions` line, but it counts distinct sessions, which Umami calls
 *   visitors. `stats` for a single day is the one place a day's visits are
 *   reported, so a day's totals cost one request as well.
 * - **Nothing is sampled.** Every count is exact at any age, so
 *   `sampleInterval` is always 1 and a closed day can be read, or read
 *   again, whenever there is a request to spare.
 *
 * Every request carries the same two filters: the admin's own pages are
 * left out, and the hostname list is applied. A filter that differed
 * between the totals and the path rows would produce a table that does not
 * add up to its header.
 *
 * The parser is tolerant: a changed response shape reads as an error in
 * the sync state, never as an exception inside a cron tick.
 */

import { failure } from "../i18n.js";
import { isInternalPath, normalizeHost, normalizePath, type TrailingSlash } from "../index/paths.js";
import { addDays, daysBetween, enumerateDays, utcDay, type Day } from "../sync/window.js";
import type {
	DailyRow,
	DateRange,
	FetchLike,
	LabelledRow,
	Overview,
	PathDayRow,
	PathRow,
	Provider,
	ProviderCapabilities,
	Result,
	Retention,
	Site,
} from "./types.js";

/** Umami Cloud's API. A self-hosted Umami serves the same routes under `/api`. */
export const UMAMI_CLOUD_API = "https://api.umami.is/v1";

/** Where Umami Cloud serves its dashboard. */
const UMAMI_CLOUD_APP = "https://cloud.umami.is";

/**
 * Most paths read for one day. `metrics/expanded` stops at 500 rows unless
 * told otherwise and cannot be paged safely, because its order has ties;
 * a day with more paths than this is reported instead of cut short.
 */
export const MAX_DAY_PATHS = 10_000;

/**
 * Umami does not sample, so a query is exact however far back it starts.
 * This is the longest history the plugin keeps (`MAX_RETENTION_DAYS`).
 */
const EXACT_DAYS = 400;

/** Paths read to rank the top pages. Umami orders by visitors, the table by page views. */
const TOP_PATHS_READ = 100;
const TOP_PATHS_LIMIT = 20;
const REFERRERS_LIMIT = 20;
const COUNTRIES_LIMIT = 50;
const HOSTNAMES_LIMIT = 50;
const WEBSITES_LIMIT = 100;

/**
 * Teams whose websites one discovery reads. The setup check is the
 * tightest caller: four bridge calls of its own leave six requests, which
 * are the user's own list, the team list and four teams. A user in more
 * teams than this can still type the website ID in.
 */
export const MAX_TEAMS_READ = 4;

/**
 * The admin's pages, as a "does not match" filter on the path. The prefix
 * is always written: without one Umami reads a leading `t.` or `c.` in the
 * value itself as an operator.
 */
const INTERNAL_PATHS = "nre.^/_emdash(/|$)";

const MS_PER_DAY = 86_400_000;

export const UMAMI_CAPABILITIES: ProviderCapabilities = {
	batchPaths: "wide-pull",
	maxPathsPerQuery: MAX_DAY_PATHS,
	meteredReads: false,
	defaultInterval: "*/15 * * * *",
	metrics: ["pageviews", "visits", "uniques"],
	breakdowns: ["referrers", "countries"],
	exactWindowDays: EXACT_DAYS,
	reportsSampling: false,
};

export interface UmamiConfig {
	apiKey: string;
	websiteId: string;
	/** The API's base URL. Empty means Umami Cloud. */
	apiUrl?: string;
	/** Hosts to filter on. Empty means "do not filter". */
	hosts?: string[];
	trailingSlash?: TrailingSlash;
	fetch: FetchLike;
	now?: () => Date;
}

export function createUmamiProvider(config: UmamiConfig): Provider {
	return new UmamiProvider(config);
}

/**
 * The API base without a trailing slash, or null when the setting is not
 * an http(s) address.
 */
export function umamiApiBase(apiUrl: string | undefined): string | null {
	const value = (apiUrl ?? "").trim() || UMAMI_CLOUD_API;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

/**
 * The website's page in Umami's own dashboard.
 *
 * A self-hosted Umami serves the dashboard beside its API, so the link is
 * the API base without `/api`. A base that does not end that way gives no
 * hint where the dashboard lives, and gets no link.
 */
export function umamiDashboardUrl(websiteId: string, apiUrl?: string): string | null {
	const base = umamiApiBase(apiUrl);
	if (!base || !websiteId) return null;
	const page = `/websites/${encodeURIComponent(websiteId)}`;
	if (base === UMAMI_CLOUD_API) return `${UMAMI_CLOUD_APP}${page}`;
	return base.endsWith("/api") ? `${base.slice(0, -"/api".length)}${page}` : null;
}

/** One row of `metrics/expanded`, whatever it was grouped by. */
interface MetricRow {
	name: string;
	pageviews: number;
	visitors: number;
	visits: number;
}

class UmamiProvider implements Provider {
	readonly id = "umami" as const;
	readonly capabilities = UMAMI_CAPABILITIES;

	#config: UmamiConfig;
	#sent = 0;

	constructor(config: UmamiConfig) {
		this.#config = config;
	}

	get #hosts(): string[] {
		return [...new Set((this.#config.hosts ?? []).map(normalizeHost).filter(Boolean))];
	}

	get #slash(): TrailingSlash {
		return this.#config.trailingSlash ?? "ignore";
	}

	get #website(): string {
		return `/websites/${encodeURIComponent(this.#config.websiteId)}`;
	}

	requests(): number {
		return this.#sent;
	}

	dashboardUrl(): string | null {
		return umamiDashboardUrl(this.#config.websiteId, this.#config.apiUrl);
	}

	async validate(): Promise<Result<true>> {
		// A real read of the configured website: a key that authenticates and
		// cannot view this website fails here, not on a key check.
		const res = await this.dayTotals(utcDay(this.#config.now?.() ?? new Date()));
		return res.ok ? { ok: true, value: true } : res;
	}

	/**
	 * With a website ID set, the hostnames that website reported in the
	 * range and their page views, read without the hostname filter so a
	 * filter that excludes them all can be seen. A website without traffic
	 * in the range gives an empty list.
	 *
	 * Without one, the websites the key's user can list: their own, and
	 * those of the teams they belong to (`#listWebsites`).
	 */
	async discoverSites(range: DateRange): Promise<Result<Site[]>> {
		const websiteId = this.#config.websiteId;
		if (!websiteId) return await this.#listWebsites();

		const res = await this.#metrics("hostname", range, HOSTNAMES_LIMIT, { hosts: false });
		if (res.ok) {
			const hosts = [...new Set(res.value.map((row) => normalizeHost(row.name)).filter(Boolean))];
			const pageviews = res.value.reduce((n, row) => n + row.pageviews, 0);
			return { ok: true, value: pageviews > 0 ? [{ siteTag: websiteId, hosts, pageviews }] : [] };
		}

		// Umami answers 401 both for a key it does not know and for a website
		// the key's user may not view. The list depends on the key alone, so
		// it tells the two apart.
		if (res.problem?.key !== "umamiUnauthorized") return res;
		const list = await this.#websites();
		return list.ok ? failure("umamiNoWebsite", { status: 401 }) : list;
	}

	/** Umami has no retention endpoint and keeps data until it is deleted. These are the plugin's own limits. */
	async retention(): Promise<Result<Retention>> {
		return {
			ok: true,
			value: { notOlderThanDays: EXACT_DAYS, maxDurationDays: EXACT_DAYS, maxPageSize: MAX_DAY_PATHS },
		};
	}

	/**
	 * Top pages, referrers and countries over the whole range, and daily
	 * totals for its last day and the day before: five requests.
	 *
	 * The first goes out alone. A wrong key, an unreachable host or a login
	 * proxy fails every request alike, and failing on one leaves the caller
	 * its budget for a fallback.
	 */
	async overview(range: DateRange): Promise<Result<Overview>> {
		const span = daysBetween(range.since, range.until);
		if (span < 0) return { ok: false, error: `Inverted range: ${range.since} is after ${range.until}` };

		const last = await this.dayTotals(range.until);
		if (!last.ok) return last;

		const [before, pages, refs, geo] = await Promise.all([
			span >= 1 ? this.dayTotals(addDays(range.until, -1)) : null,
			this.#metrics("path", range, TOP_PATHS_READ),
			this.#metrics("referrer", range, REFERRERS_LIMIT),
			this.#metrics("country", range, COUNTRIES_LIMIT),
		]);
		if (before && !before.ok) return before;
		if (!pages.ok) return pages;
		if (!refs.ok) return refs;
		if (!geo.ok) return geo;

		const series = [before?.value, last.value].filter((row): row is DailyRow => Boolean(row));
		return {
			ok: true,
			value: {
				totals: {
					pageviews: series.reduce((n, row) => n + row.pageviews, 0),
					visits: series.reduce((n, row) => n + row.visits, 0),
					sampleInterval: 1,
				},
				series,
				topPaths: this.#foldPaths(pages.value)
					.sort((a, b) => b.pageviews - a.pageviews || a.path.localeCompare(b.path))
					.slice(0, TOP_PATHS_LIMIT),
				// Umami lists referring domains only: a visit without a referrer
				// has no row, so there is no direct-traffic line to label.
				referrers: labelled(refs.value, (name) => name),
				countries: labelled(geo.value, countryCode),
				truncated:
					pages.value.length >= TOP_PATHS_READ ||
					refs.value.length >= REFERRERS_LIMIT ||
					geo.value.length >= COUNTRIES_LIMIT,
			},
		};
	}

	/**
	 * The asked paths' numbers, one request per day of the range. The
	 * request returns every path and the answer is narrowed here, after
	 * normalizing, so either spelling of a path counts towards it.
	 */
	async paths(paths: string[], range: DateRange): Promise<Result<PathDayRow[]>> {
		if (daysBetween(range.since, range.until) < 0) {
			return { ok: false, error: `Inverted range: ${range.since} is after ${range.until}` };
		}
		if (paths.length === 0) return { ok: true, value: [] };

		const asked = new Set(paths.map((path) => normalizePath(path, this.#slash)));
		const out: PathDayRow[] = [];
		for (const day of enumerateDays(range.since, range.until)) {
			const res = await this.day(day);
			if (!res.ok) return res;
			for (const row of res.value) if (asked.has(row.path)) out.push(row);
		}
		return { ok: true, value: out };
	}

	async day(day: Day): Promise<Result<PathDayRow[]>> {
		const res = await this.#metrics("path", { since: day, until: day }, MAX_DAY_PATHS);
		if (!res.ok) return res;
		if (res.value.length >= MAX_DAY_PATHS) return failure("umamiTruncated", { max: MAX_DAY_PATHS });
		return { ok: true, value: this.#foldPaths(res.value).map((row) => ({ ...row, date: day })) };
	}

	async dayTotals(day: Day): Promise<Result<DailyRow | null>> {
		const res = await this.#get(`${this.#website}/stats`, this.#query({ since: day, until: day }));
		if (!res.ok) return res;
		if (!isRecord(res.value)) return failure("umamiUnexpected");

		const pageviews = numberAt(res.value, "pageviews");
		const visits = numberAt(res.value, "visits");
		// A day without page views is missing, not zero, as it is everywhere else.
		if (pageviews === 0 && visits === 0) return { ok: true, value: null };
		return {
			ok: true,
			value: { date: day, pageviews, visits, uniques: numberAt(res.value, "visitors"), sampleInterval: 1 },
		};
	}

	/**
	 * Normalization can map two reported paths onto one, `/about` and
	 * `/about/` for a start, so their numbers are added.
	 */
	#foldPaths(rows: MetricRow[]): PathRow[] {
		const merged = new Map<string, PathRow>();
		for (const row of rows) {
			const path = normalizePath(row.name, this.#slash);
			if (isInternalPath(path)) continue;
			const existing = merged.get(path);
			if (existing) {
				existing.pageviews += row.pageviews;
				existing.visits += row.visits;
			} else {
				merged.set(path, { path, pageviews: row.pageviews, visits: row.visits, sampleInterval: 1 });
			}
		}
		return [...merged.values()];
	}

	/**
	 * The user's own websites and their teams' websites, each website once.
	 *
	 * `/websites` lists what the user owns, and with `includeTeams` what
	 * they own or manage through a team. A plain or view-only team member
	 * may read a team's websites and is left out of that list, so each of
	 * the user's teams is asked for its websites as well, which any member
	 * may do. At most `MAX_TEAMS_READ` teams are read.
	 *
	 * The user's own list goes first and alone: a refused key fails there
	 * and costs one request. After it, a team list or a team that does not
	 * answer is left out and the rest still counts.
	 */
	async #listWebsites(): Promise<Result<Site[]>> {
		const own = await this.#websites();
		if (!own.ok) return own;

		const teams = await this.#get("/me/teams", [["pageSize", String(MAX_TEAMS_READ)]]);
		const teamIds = teams.ok
			? pageRows(teams.value)
					.map((row) => (isRecord(row) && typeof row.id === "string" ? row.id : ""))
					.filter(Boolean)
					.slice(0, MAX_TEAMS_READ)
			: [];
		const perTeam = await Promise.all(
			teamIds.map((id) =>
				this.#get(`/teams/${encodeURIComponent(id)}/websites`, [["pageSize", String(WEBSITES_LIMIT)]]),
			),
		);

		const byId = new Map<string, Site>();
		for (const site of own.value) byId.set(site.siteTag, site);
		for (const res of perTeam) {
			if (!res.ok) continue;
			for (const site of sitesOf(pageRows(res.value))) {
				if (!byId.has(site.siteTag)) byId.set(site.siteTag, site);
			}
		}
		return { ok: true, value: [...byId.values()] };
	}

	/** What `/websites` lists for the key's user. A 401 here can only mean the key. */
	async #websites(): Promise<Result<Site[]>> {
		const res = await this.#get("/websites", [
			["includeTeams", "true"],
			["pageSize", String(WEBSITES_LIMIT)],
		]);
		if (!res.ok) return res.problem?.key === "umamiUnauthorized" ? failure("umamiBadKey") : res;
		if (!isRecord(res.value) && !Array.isArray(res.value)) return failure("umamiUnexpected");
		if (isRecord(res.value) && !Array.isArray(res.value.data)) return failure("umamiUnexpected");
		return { ok: true, value: sitesOf(pageRows(res.value)) };
	}

	async #metrics(
		type: "path" | "referrer" | "country" | "hostname",
		range: DateRange,
		limit: number,
		opts: { hosts?: boolean } = {},
	): Promise<Result<MetricRow[]>> {
		const res = await this.#get(`${this.#website}/metrics/expanded`, [
			...this.#query(range, opts),
			["type", type],
			["limit", String(limit)],
		]);
		if (!res.ok) return res;
		if (!Array.isArray(res.value)) return failure("umamiUnexpected");

		const rows: MetricRow[] = [];
		for (const row of res.value) {
			if (!isRecord(row) || typeof row.name !== "string") continue;
			rows.push({
				name: row.name,
				pageviews: numberAt(row, "pageviews"),
				visitors: numberAt(row, "visitors"),
				visits: numberAt(row, "visits"),
			});
		}
		return { ok: true, value: rows };
	}

	/**
	 * The range and the two filters every read shares. Days are whole UTC
	 * days, from the first millisecond of `since` to the last of `until`,
	 * today included, so the same day always makes the same request.
	 */
	#query(range: DateRange, opts: { hosts?: boolean } = {}): Array<[string, string]> {
		const params: Array<[string, string]> = [
			["startAt", String(dayStart(range.since))],
			["endAt", String(dayStart(range.until) + MS_PER_DAY - 1)],
			["path", INTERNAL_PATHS],
		];
		const hosts = this.#hosts;
		// `eq.` takes a comma-separated list. Named for the reason given at
		// `INTERNAL_PATHS`: the hostname `t.co` would otherwise be an operator.
		if (hosts.length > 0 && opts.hosts !== false) params.push(["hostname", `eq.${hosts.join(",")}`]);
		return params;
	}

	async #get(path: string, params: Array<[string, string]>): Promise<Result<unknown>> {
		const base = umamiApiBase(this.#config.apiUrl);
		if (!base) return failure("umamiBadUrl");

		const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
		this.#sent++;

		let response: Response;
		try {
			response = await this.#config.fetch(`${base}${path}?${query}`, {
				headers: { Authorization: `Bearer ${this.#config.apiKey}`, Accept: "application/json" },
			});
		} catch (error) {
			return failure("umamiUnreachable", { detail: error instanceof Error ? error.message : String(error) });
		}

		if (response.status === 429) return failure("umamiRateLimited");

		// Umami answers in JSON, its errors included. Anything else was
		// written by something in front of it: a login proxy's sign-in page
		// (the host follows its redirect), or the page a wrong URL leads to.
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return response.status >= 500
				? failure("umamiHttp", { status: response.status })
				: failure("umamiProxy", { status: response.status });
		}

		if (response.ok) return { ok: true, value: payload };
		if (response.status === 401) return failure("umamiUnauthorized");
		if (response.status === 403 || response.status === 404) return failure("umamiNoWebsite", { status: response.status });
		if (response.status >= 300 && response.status < 400) return failure("umamiProxy", { status: response.status });
		return failure("umamiHttp", { status: response.status });
	}
}

/** The rows of a page of results, `{ data: [...], count, page, pageSize }`. */
function pageRows(payload: unknown): unknown[] {
	const rows = isRecord(payload) ? payload.data : payload;
	return Array.isArray(rows) ? rows : [];
}

function sitesOf(rows: unknown[]): Site[] {
	const sites: Site[] = [];
	for (const row of rows) {
		if (!isRecord(row) || typeof row.id !== "string" || !row.id) continue;
		const host = typeof row.domain === "string" ? normalizeHost(row.domain) : "";
		sites.push({
			siteTag: row.id,
			...(typeof row.name === "string" && row.name && { name: row.name }),
			hosts: host ? [host] : [],
		});
	}
	return sites;
}

function labelled(rows: MetricRow[], label: (name: string) => string): LabelledRow[] {
	return rows
		.filter((row) => row.name !== "")
		.map((row) => ({ label: label(row.name), visits: row.visits, pageviews: row.pageviews }))
		.sort((a, b) => b.visits - a.visits);
}

/** Umami stores ISO 3166-1 alpha-2 codes, which the page turns into names. */
function countryCode(name: string): string {
	return /^[a-z]{2}$/i.test(name) ? name.toUpperCase() : name;
}

function dayStart(day: Day): number {
	return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * A count as a number. `metrics/expanded` sums page views without a cast,
 * and a PostgreSQL numeric can reach JSON as a string, so digits in a
 * string count too.
 */
function numberAt(value: Record<string, unknown>, key: string): number {
	const raw = value[key];
	const n = typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
