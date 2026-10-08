/**
 * Reading the plugin's configuration.
 *
 * Everything comes out of `ctx.settings.list()` in **one** call rather
 * than one `get()` per key. That is not micro-optimisation: a sandboxed
 * plugin on Cloudflare gets ten subrequests per invocation and the bridge
 * counts every `settings.get`, `kv.get` and `storage.*` call against that
 * budget, so seven separate reads would spend most of a tick before the
 * plugin had talked to anybody.
 *
 * `ctx.settings.get()` returns `null` for an unset key — defaults declared
 * in `settingsSchema` are applied by the admin API when the form is saved,
 * not when the value is read — so every default is applied again here.
 */

import { clampNumber } from "./values.js";
import type { PluginContext } from "emdash/plugin";

import { siteHosts } from "./index/paths.js";
import type { ProviderId, ReadSpec } from "./providers/types.js";
import { MAX_READ_DEPTHS } from "./sync/reads.js";
import { resolveTimeZone } from "./sync/window.js";

export interface AnalyticsSettings {
	provider: ProviderId;
	/** The provider's credential: the Umami API key. */
	apiToken: string;
	/** The site's id at the provider: the Umami website ID. */
	siteTag: string;
	/** Where a self-hosted Umami serves its API. Empty means Umami Cloud. */
	umamiApiUrl: string;
	hosts: string[];
	syncInterval: string;
	retentionDays: number;
	chunkSize: number;
	/** Event data properties the analytics page breaks page views down by, in order. */
	breakdownProperties: string[];
	/** The read event and its properties, or null while read-through is off. */
	reads: ReadSpec | null;
	/**
	 * The IANA zone whose calendar days the plugin counts in. EmDash gives
	 * a sandboxed plugin no site time zone (`ctx.site` and `routeCtx.ui`
	 * carry the locale only), so it is a setting of its own.
	 */
	timeZone: string;
}

export const DEFAULT_SYNC_INTERVAL = "*/15 * * * *";
export const RECONCILE_SCHEDULE = "10 3 * * *";

/**
 * The longest history the settings offer: a year and a month.
 *
 * Umami sets no limit of its own, since it is exact at any age. The
 * limits are this plugin's. The history pass reads one day per step, so
 * 400 days take about eleven days to arrive at the default interval. The
 * daily prune deletes at most 392 `daily` rows per run, which keeps up
 * with a store that gains fewer paths than that per day.
 */
export const MAX_RETENTION_DAYS = 400;

/**
 * The most paths one paths tick may ask about, and the default. The tick
 * spends seven bridge calls besides reading the stored daily rows, which
 * leaves three `getMany` calls of 98 ids each: 36 paths over the eight
 * days of the window.
 */
const MAX_CHUNK_SIZE = 36;

export type SettingsResult =
	| { ok: true; settings: AnalyticsSettings }
	| { ok: false; missing: string[]; partial: Partial<AnalyticsSettings> };

export async function readSettings(ctx: PluginContext): Promise<SettingsResult> {
	const raw = new Map<string, unknown>();
	for (const entry of await ctx.settings.list()) raw.set(entry.key, entry.value);

	const provider: ProviderId = raw.get("provider") === "demo" ? "demo" : "umami";
	const apiToken = str(raw.get("umamiApiKey"));
	const siteTag = str(raw.get("umamiWebsiteId"));
	const umamiApiUrl = str(raw.get("umamiApiUrl"));

	const hosts = parseHosts(raw.get("hosts"), ctx.site.url);
	const syncInterval = str(raw.get("syncInterval")) || DEFAULT_SYNC_INTERVAL;
	const retentionDays = clampNumber(raw.get("retentionDays"), 7, MAX_RETENTION_DAYS, 90);
	const chunkSize = clampNumber(raw.get("chunkSize"), 10, MAX_CHUNK_SIZE, MAX_CHUNK_SIZE);

	const breakdownProperties = parseProperties(raw.get("breakdownProperties"));
	const reads = parseReads(raw);
	const timeZone = resolveTimeZone(raw.get("timeZone"));

	const partial = {
		provider,
		apiToken,
		siteTag,
		umamiApiUrl,
		hosts,
		syncInterval,
		retentionDays,
		chunkSize,
		breakdownProperties,
		reads,
		timeZone,
	};
	if (provider === "demo") return { ok: true, settings: partial };

	// The website ID is deliberately not required: the settings form says it
	// can be left empty, and the sync then lists the websites the key can
	// see. A key is the irreducible minimum.
	if (!apiToken) return { ok: false, missing: ["umamiApiKey"], partial };

	return { ok: true, settings: partial };
}

/** The breakdown the settings start with. */
export const DEFAULT_BREAKDOWN_PROPERTIES = ["category"];

/**
 * Most breakdowns the analytics page shows. One request reads them all,
 * so this bounds the page's length, not its bridge calls.
 */
export const MAX_BREAKDOWN_PROPERTIES = 3;

/**
 * The property names, comma-separated in the setting. Unset means the
 * default; a setting cleared to nothing turns breakdowns off.
 */
function parseProperties(raw: unknown): string[] {
	if (typeof raw !== "string") return DEFAULT_BREAKDOWN_PROPERTIES;
	const names = raw
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return [...new Set(names)].slice(0, MAX_BREAKDOWN_PROPERTIES);
}

/**
 * Read-through, on only when the event, both properties and at least one
 * depth are set: anything less could not be counted, so it reads as off.
 */
function parseReads(raw: Map<string, unknown>): ReadSpec | null {
	const event = str(raw.get("readEvent"));
	const entryProperty = str(raw.get("readEntryProperty"));
	const depthProperty = str(raw.get("readDepthProperty"));
	const depths = [
		...new Set(
			str(raw.get("readDepthValues"))
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	].slice(0, MAX_READ_DEPTHS);
	if (!event || !entryProperty || !depthProperty || depths.length === 0) return null;
	return { event, entryProperty, depthProperty, depths };
}

/**
 * Which hostnames count as this site.
 *
 * Empty means "derive from the site URL", because one Umami website
 * records whatever hostname its tracker ran on: the canonical host, its
 * `www` form and any preview deploy that carries the same script. Counting
 * preview deploys as production traffic is the sort of quiet wrongness
 * that makes people distrust the numbers.
 */
function parseHosts(raw: unknown, siteUrl: string): string[] {
	if (typeof raw === "string" && raw.trim()) {
		return [...new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean))];
	}
	return siteHosts(siteUrl);
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * The operator-facing sentence for an incomplete configuration.
 *
 * Every failure mode that would otherwise render a dashboard of zeroes
 * should read as one sentence naming the thing to fix.
 */
export function missingSettingsMessage(missing: string[]): string {
	const labels: Record<string, string> = {
		umamiApiKey: "an Umami API key",
	};
	const parts = missing.map((key) => labels[key] ?? key);
	return `Analytics is not configured yet: add ${listPhrase(parts)} in the plugin's settings.`;
}

function listPhrase(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
