/**
 * The provider seam.
 *
 * Small on purpose, and about *cost* rather than endpoints: the scheduler
 * reads cadence, batching strategy and caps from `capabilities` and never
 * learns which vendor it is talking to. Nothing provider-shaped reaches
 * storage or a Block Kit block.
 *
 * There is no registry and no loader. With one adapter today and a second
 * planned, a `switch` on the configured provider id is the right amount of
 * abstraction; anything more is scaffolding for a future that may not
 * arrive in that shape.
 */

import type { Problem } from "../i18n.js";
import type { Day } from "../sync/window.js";

export type ProviderId = "cloudflare" | "demo" | "umami";

export type Metric = "pageviews" | "visits" | "uniques";
export type Breakdown = "referrers" | "countries" | "devices";

export interface ProviderCapabilities {
	/**
	 * How the provider answers "numbers for these specific paths".
	 *
	 * `filter`: one request takes a list of paths and a range of days and
	 * returns a row per day and path. `wide-pull`: one request returns every
	 * path for one day, so a range costs a request per day and the scheduler
	 * asks for today only, reads the rest of the window from the store and
	 * pulls closed days one at a time through `day()` and `dayTotals()`. Its
	 * `overview()` carries daily totals for the last day of the range and the
	 * day before, whatever the range, for the same reason.
	 */
	batchPaths: "filter" | "wide-pull" | "none";
	/**
	 * Most paths worth putting in one batched request.
	 *
	 * For Cloudflare this is *not* an API limit — `requestPath_in` was
	 * accepted at 10 000 entries in a 209 KB body on 2026-09-20. The real
	 * ceiling is the response: the per-path query groups by date *and*
	 * path, and `maxPageSize` is 10 000 groups, so paths x days must stay
	 * under that. Below it the binding constraints are ours, not the
	 * vendor's — the D1 write budget and Workers CPU.
	 */
	maxPathsPerQuery: number;
	/** True when reading the API bills against the same quota as traffic. */
	meteredReads: boolean;
	/** Cron expression the scheduler uses unless the operator overrides it. */
	defaultInterval: string;
	/** Metrics this provider genuinely has. Cloudflare has no uniques. */
	metrics: ReadonlyArray<Metric>;
	breakdowns: ReadonlyArray<Breakdown>;
	/**
	 * How far back a query's start may reach and still return exact counts.
	 *
	 * Cloudflare serves unsampled beacon data for seven days and a ~10 %
	 * aggregate beyond that, and picks one source per query from the oldest
	 * day requested. A window that reaches one day too far returns
	 * tenfold-quantized numbers for *every* day in it. See
	 * `UNSAMPLED_WINDOW_DAYS`.
	 */
	exactWindowDays: number;
	/** True when the provider reports how heavily a response was sampled. */
	reportsSampling: boolean;
}

/** One day of site-wide numbers. */
export interface DailyRow {
	date: Day;
	pageviews: number;
	visits: number;
	uniques?: number;
	/** 1 means every beacon was counted; above 1 the numbers are estimates. */
	sampleInterval: number;
}

/** One path's numbers over the queried range. */
export interface PathRow {
	path: string;
	pageviews: number;
	visits: number;
	sampleInterval: number;
}

/** One day of one path's numbers — what the per-entry summaries are built from. */
export interface PathDayRow extends PathRow {
	date: Day;
}

export interface LabelledRow {
	label: string;
	visits: number;
	pageviews: number;
}

export interface Overview {
	/** Site totals for the range. */
	totals: { pageviews: number; visits: number; sampleInterval: number };
	/** One row per day that reported data. A missing day is missing, not zero. */
	series: DailyRow[];
	topPaths: PathRow[];
	referrers: LabelledRow[];
	countries: LabelledRow[];
	/**
	 * True when the response hit its `limit` and was silently truncated.
	 * Cloudflare caps returned groups without saying so.
	 */
	truncated: boolean;
}

export interface Site {
	/** The site's id at the provider: a Cloudflare site tag, an Umami website ID. */
	siteTag: string;
	/** What the provider calls the site, when it has a name for it. */
	name?: string;
	/** Absent when discovered through analytics rather than site management. */
	siteToken?: string;
	hosts: string[];
	/** Page views seen in the discovery window, when discovery reports them. */
	pageviews?: number;
}

export interface Retention {
	/** Oldest day the provider will answer for. */
	notOlderThanDays: number;
	/** Widest span a single query may cover. */
	maxDurationDays: number;
	/** Most groups one query may return. */
	maxPageSize: number;
}

export interface DateRange {
	since: Day;
	until: Day;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; problem?: Problem };

/**
 * A provider adapter.
 *
 * Every method returns a `Result` rather than throwing: these run inside a
 * cron tick that gets no retry and no backoff, so a failure has to be a
 * value the scheduler can record and move past.
 */
export interface Provider {
	readonly id: ProviderId;
	readonly capabilities: ProviderCapabilities;

	/** A real query, so the error text can be specific about what is wrong. */
	validate(): Promise<Result<true>>;

	/** Sites this credential can actually see. */
	discoverSites(range: DateRange): Promise<Result<Site[]>>;

	retention(): Promise<Result<Retention>>;

	overview(range: DateRange): Promise<Result<Overview>>;

	/** Per-day numbers for specific paths, batched into one request. */
	paths(paths: string[], range: DateRange): Promise<Result<PathDayRow[]>>;

	/** The provider's own dashboard for this site, when it has one to link to. */
	dashboardUrl?(): string | null;

	/**
	 * Every path's numbers for one day, in one request. A `wide-pull`
	 * provider has it.
	 */
	day?(day: Day): Promise<Result<PathDayRow[]>>;

	/**
	 * Site totals for one day, in one request, or null for a day without
	 * page views. A `wide-pull` provider has it.
	 */
	dayTotals?(day: Day): Promise<Result<DailyRow | null>>;

	/**
	 * Requests this instance has sent. Present when one method may send
	 * several, so a caller counting bridge calls knows what a failed call
	 * already spent.
	 */
	requests?(): number;
}

/** The injected transport. `ctx.http.fetch` satisfies it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
