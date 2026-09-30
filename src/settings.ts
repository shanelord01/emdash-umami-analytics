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
import type { ProviderId } from "./providers/types.js";

export interface AnalyticsSettings {
	provider: ProviderId;
	/** The provider's credential: a Cloudflare API token, an Umami API key. */
	apiToken: string;
	accountId: string;
	/** The site's id at the provider: a Cloudflare site tag, an Umami website ID. */
	siteTag: string;
	/** Where a self-hosted Umami serves its API. Empty means Umami Cloud. */
	umamiApiUrl: string;
	hosts: string[];
	syncInterval: string;
	retentionDays: number;
	chunkSize: number;
}

export const DEFAULT_SYNC_INTERVAL = "*/15 * * * *";
export const RECONCILE_SCHEDULE = "10 3 * * *";

/** Cloudflare answers for 184 days; asking for more is a guaranteed gap. */
const MAX_RETENTION_DAYS = 184;

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

	const provider = providerOf(raw.get("provider"));
	const umami = provider === "umami";
	const apiToken = str(raw.get(umami ? "umamiApiKey" : "cfApiToken"));
	const accountId = str(raw.get("cfAccountId"));
	const siteTag = str(raw.get(umami ? "umamiWebsiteId" : "cfSiteTag"));
	const umamiApiUrl = str(raw.get("umamiApiUrl"));

	const hosts = parseHosts(raw.get("hosts"), ctx.site.url);
	const syncInterval = str(raw.get("syncInterval")) || DEFAULT_SYNC_INTERVAL;
	const retentionDays = clampNumber(raw.get("retentionDays"), 7, MAX_RETENTION_DAYS, 90);
	const chunkSize = clampNumber(raw.get("chunkSize"), 10, MAX_CHUNK_SIZE, MAX_CHUNK_SIZE);

	const partial = { provider, apiToken, accountId, siteTag, umamiApiUrl, hosts, syncInterval, retentionDays, chunkSize };
	if (provider === "demo") return { ok: true, settings: partial };

	// Umami needs a key and nothing else: the website ID is optional in the
	// same way as the site tag below.
	if (umami) {
		return apiToken ? { ok: true, settings: partial } : { ok: false, missing: ["umamiApiKey"], partial };
	}

	// The site tag is deliberately not required: the settings form says it
	// can be left empty, and the sync then lists the sites that have
	// traffic. A token and an account are the irreducible minimum.
	const missing: string[] = [];
	if (!apiToken) missing.push("cfApiToken");
	if (!accountId) missing.push("cfAccountId");
	if (missing.length > 0) return { ok: false, missing, partial };

	return { ok: true, settings: partial };
}

/**
 * Which hostnames count as this site.
 *
 * Empty means "derive from the site URL", because one Cloudflare site tag
 * routinely covers more than the canonical host — a tag for `example.com`
 * typically also matches `www.example.com` and a `pages.dev` preview domain, and
 * counting preview deploys as production traffic is exactly the sort of
 * quiet wrongness that makes people distrust the numbers.
 */
function parseHosts(raw: unknown, siteUrl: string): string[] {
	if (typeof raw === "string" && raw.trim()) {
		return [...new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean))];
	}
	return siteHosts(siteUrl);
}

function providerOf(value: unknown): ProviderId {
	return value === "demo" || value === "umami" ? value : "cloudflare";
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
		cfApiToken: "an API token with Account → Account Analytics → Read",
		cfAccountId: "the Cloudflare account ID",
		umamiApiKey: "an Umami API key",
	};
	const parts = missing.map((key) => labels[key] ?? key);
	return `Analytics is not configured yet: add ${listPhrase(parts)} in the plugin's settings.`;
}

function listPhrase(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
