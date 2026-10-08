/**
 * Generated numbers, for trying the plugin without a provider account and
 * for building the UI against data that looks like a real site.
 *
 * It goes through the same sync, storage and join as a real provider, so
 * what it shows is what the pipeline does, not a mock-up of it. Numbers
 * are a pure function of (day, path): a closed day reads the same on every
 * tick, which read-compare-write depends on to skip unchanged rows.
 *
 * It mirrors Cloudflare where that changes what the UI shows: today is
 * provisional and sampled, closed days are exact, referrers use the same
 * direct-traffic label, countries are ISO-2 codes.
 */

import { normalizePath, type TrailingSlash } from "../index/paths.js";
import { addDays, dayStartMs, daysBetween, DEFAULT_TIME_ZONE, enumerateDays, localDay, type Day } from "../sync/window.js";
import type {
	DailyRow,
	DateRange,
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

/**
 * The label for visits that arrived without a referrer. A blank row in the
 * referrers table would look like a bug.
 */
export const DIRECT_REFERRER = "(direct)";

export const DEMO_CAPABILITIES: ProviderCapabilities = {
	batchPaths: "filter",
	maxPathsPerQuery: 100,
	meteredReads: false,
	defaultInterval: "*/15 * * * *",
	metrics: ["pageviews", "visits"],
	breakdowns: ["referrers", "countries"],
	// There is no sampling cliff to respect, so the first sync backfills a
	// quarter of history and the pages have something to chart.
	exactWindowDays: 90,
	reportsSampling: true,
};

export interface DemoConfig {
	/** Paths to attribute traffic to: the indexed entries, in practice. */
	listPaths: () => Promise<string[]>;
	trailingSlash?: TrailingSlash;
	/** The IANA zone whose days today and its elapsed share are counted in. */
	timeZone?: string;
	now?: () => Date;
}

export function createDemoProvider(config: DemoConfig): Provider {
	return new DemoProvider(config);
}

const TOP_PATHS_LIMIT = 20;

/** Page views on an average weekday at the anchor date. */
const BASE_DAILY_VIEWS = 140;
const GROWTH_ANCHOR: Day = "2026-01-01";
const GROWTH_PER_DAY = 0.0015;
/** Sunday first, as `getUTCDay()` counts. */
const WEEKDAY_FACTOR = [0.55, 1.05, 1.1, 1.08, 1.02, 0.92, 0.6];
/** Share of traffic that lands on paths which are no entry. */
const UNINDEXED_SHARE = 0.12;
const UNINDEXED_PATHS = ["/campaign/autumn", "/old-url"];
const TODAY_SAMPLE_INTERVAL = 2;

const REFERRER_SHARES: Array<[string, number]> = [
	[DIRECT_REFERRER, 0.46],
	["google.com", 0.28],
	["github.com", 0.07],
	["linkedin.com", 0.06],
	["duckduckgo.com", 0.04],
	["bing.com", 0.03],
	["news.ycombinator.com", 0.03],
	["t.co", 0.03],
];

const COUNTRY_SHARES: Array<[string, number]> = [
	["DE", 0.52],
	["AT", 0.11],
	["CH", 0.09],
	["US", 0.08],
	["NL", 0.04],
	["GB", 0.04],
	["FR", 0.03],
	["PL", 0.03],
	["IT", 0.03],
	["ES", 0.03],
];

interface Weighted {
	path: string;
	weight: number;
}

class DemoProvider implements Provider {
	readonly id = "demo" as const;
	readonly capabilities = DEMO_CAPABILITIES;

	#config: DemoConfig;
	#weights: Promise<Weighted[]> | undefined;

	constructor(config: DemoConfig) {
		this.#config = config;
	}

	async validate(): Promise<Result<true>> {
		return { ok: true, value: true };
	}

	async discoverSites(): Promise<Result<Site[]>> {
		return { ok: true, value: [{ siteTag: "demo", hosts: [] }] };
	}

	async retention(): Promise<Result<Retention>> {
		return { ok: true, value: { notOlderThanDays: 184, maxDurationDays: 184, maxPageSize: 10_000 } };
	}

	async overview(range: DateRange): Promise<Result<Overview>> {
		const days = enumerateDays(range.since, range.until);
		if (days.length === 0) return { ok: false, error: "The requested range is empty or inverted." };

		const weights = await this.#pathWeights();
		const today = this.#today();

		const series: DailyRow[] = [];
		const byPath = new Map<string, PathRow>();
		for (const day of days) {
			const sampleInterval = day === today ? TODAY_SAMPLE_INTERVAL : 1;
			let pageviews = 0;
			let visits = 0;
			for (const { path, weight } of weights) {
				const n = this.#numbers(day, path, weight);
				pageviews += n.pageviews;
				visits += n.visits;
				const acc = byPath.get(path) ?? { path, pageviews: 0, visits: 0, sampleInterval: 1 };
				acc.pageviews += n.pageviews;
				acc.visits += n.visits;
				acc.sampleInterval = Math.max(acc.sampleInterval, sampleInterval);
				byPath.set(path, acc);
			}
			series.push({ date: day, pageviews, visits, ...engagement(day, visits), sampleInterval });
		}

		const pageviews = series.reduce((n, d) => n + d.pageviews, 0);
		const visits = series.reduce((n, d) => n + d.visits, 0);
		const topPaths = [...byPath.values()]
			.filter((p) => p.pageviews > 0)
			.sort((a, b) => b.pageviews - a.pageviews || a.path.localeCompare(b.path))
			.slice(0, TOP_PATHS_LIMIT);

		return {
			ok: true,
			value: {
				totals: { pageviews, visits, sampleInterval: Math.max(...series.map((d) => d.sampleInterval)) },
				series,
				topPaths,
				referrers: split(REFERRER_SHARES, pageviews, visits),
				countries: split(COUNTRY_SHARES, pageviews, visits),
				truncated: false,
			},
		};
	}

	async paths(paths: string[], range: DateRange): Promise<Result<PathDayRow[]>> {
		const weights = new Map((await this.#pathWeights()).map((w) => [w.path, w.weight]));
		const today = this.#today();
		const out: PathDayRow[] = [];
		for (const raw of paths) {
			const path = normalizePath(raw, this.#config.trailingSlash);
			const weight = weights.get(path);
			if (weight === undefined) continue;
			for (const day of enumerateDays(range.since, range.until)) {
				const n = this.#numbers(day, path, weight);
				if (n.pageviews === 0) continue;
				out.push({ date: day, path, ...n, sampleInterval: day === today ? TODAY_SAMPLE_INTERVAL : 1 });
			}
		}
		return { ok: true, value: out };
	}

	#today(): Day {
		return localDay(this.#now(), this.#zone());
	}

	#zone(): string {
		return this.#config.timeZone ?? DEFAULT_TIME_ZONE;
	}

	#now(): Date {
		return this.#config.now?.() ?? new Date();
	}

	/**
	 * One path's share of the site, fixed for the provider's lifetime.
	 *
	 * The home page leads, the rest fall off like real traffic does (a
	 * power law over a stable, hash-shuffled order), and two paths that are
	 * no entry take a fixed share so the join has something to miss.
	 */
	#pathWeights(): Promise<Weighted[]> {
		this.#weights ??= (async () => {
			const slash = this.#config.trailingSlash;
			const listed = [...new Set((await this.#config.listPaths()).map((p) => normalizePath(p, slash)))];
			const ranked = listed.includes("/") ? ["/"] : [];
			ranked.push(...listed.filter((p) => p !== "/").sort((a, b) => unit(`rank|${a}`) - unit(`rank|${b}`)));
			if (ranked.length === 0) ranked.push("/");

			const raw = ranked.map((path, i) => ({ path, weight: 1 / (i + 1) ** 1.1 }));
			const sum = raw.reduce((n, w) => n + w.weight, 0);
			const indexed = raw.map((w) => ({ path: w.path, weight: (w.weight / sum) * (1 - UNINDEXED_SHARE) }));
			const unindexed = UNINDEXED_PATHS.map((p, i) => ({
				path: normalizePath(p, slash),
				weight: (UNINDEXED_SHARE * (UNINDEXED_PATHS.length - i)) / 3,
			}));
			return [...indexed, ...unindexed];
		})();
		return this.#weights;
	}

	#numbers(day: Day, path: string, weight: number): { pageviews: number; visits: number } {
		const full = dayVolume(day) * weight * (0.7 + 0.6 * unit(`${day}|${path}`));
		const pageviews = Math.round(full * this.#elapsedShare(day));
		const visits = Math.round(pageviews * (0.6 + 0.2 * unit(`visits|${day}|${path}`)));
		return { pageviews, visits };
	}

	/** Today has only had the hours that passed; every other day is whole. */
	#elapsedShare(day: Day): number {
		const now = this.#now();
		const zone = this.#zone();
		if (day !== localDay(now, zone)) return 1;
		const midnight = dayStartMs(day, zone);
		return (now.getTime() - midnight) / (dayStartMs(addDays(day, 1), zone) - midnight);
	}
}

/**
 * Bounces and visit time for a day: about two visits in three leave after
 * one page, and a visit lasts a minute or so, varying by day.
 */
function engagement(day: Day, visits: number): { bounces: number; totaltime: number } {
	return {
		bounces: Math.round(visits * (0.55 + 0.2 * unit(`bounces|${day}`))),
		totaltime: Math.round(visits * (45 + 60 * unit(`time|${day}`))),
	};
}

function dayVolume(day: Day): number {
	const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
	const growth = 1 + GROWTH_PER_DAY * daysBetween(GROWTH_ANCHOR, day);
	const noise = 0.85 + 0.3 * unit(`day|${day}`);
	return BASE_DAILY_VIEWS * WEEKDAY_FACTOR[weekday]! * Math.max(growth, 0.2) * noise;
}

function split(shares: Array<[string, number]>, pageviews: number, visits: number): LabelledRow[] {
	return shares
		.map(([label, share]) => ({ label, pageviews: Math.round(pageviews * share), visits: Math.round(visits * share) }))
		.filter((row) => row.visits > 0 || row.pageviews > 0);
}

/** A stable number in [0, 1) for a key: FNV-1a, then a mulberry32 mix. */
function unit(key: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let t = (h + 0x6d2b79f5) | 0;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}
