/**
 * The setup check: a view of the analytics page that runs every check the
 * numbers depend on and names the fix for each one that fails.
 *
 * The generated settings form stays the only place to enter values; this
 * view only reads. It exists because most setup mistakes do not fail, they
 * produce zeroes: a site tag that is really the beacon token, a hostname
 * filter that excludes the host Cloudflare reports, a site without a
 * stored URL, a Worker without a Cron Trigger. None of those raises an
 * error the sync could record.
 *
 * Calls: the state, the settings, the task list, the waiting mark until the
 * first sync, and one discovery request to Cloudflare, which answers
 * access, site tag, the site list and the hostnames at once.
 *
 * Umami runs the same checks under its own names. Its discovery is one
 * request as well, and a second only when the first is refused, to tell a
 * wrong key from a website the key's user may not view.
 */

import type { PluginContext } from "emdash/plugin";

import { langOf, problemText, t, type Lang, type MessageKey, type Problem } from "../i18n.js";
import { normalizeHost } from "../index/paths.js";
import type { ProviderId, Result, Site } from "../providers/types.js";
import { readSettings, type AnalyticsSettings } from "../settings.js";
import { buildProvider, readState, REFRESH_TASK, SYNC_TASK, WAITING_KEY, type SyncState } from "../sync/scheduler.js";
import { addDays, utcDay, UNSAMPLED_WINDOW_DAYS } from "../sync/window.js";
import { actions, banner, button, code, context, header, table, type AnalyticsBlock } from "./blocks.js";
import { formatAge, formatCount } from "./format.js";
import { RANGE_ACTION, SETUP_ACTION } from "./page.js";

/**
 * Discovery reads the exact window only. Over 30 days Cloudflare answers
 * from a sample, and a host with little traffic drops out of it.
 */
const DISCOVERY_DAYS = UNSAMPLED_WINDOW_DAYS;

/** How late a requested one-shot sync may run before the scheduler counts as stopped. */
const ONESHOT_GRACE_MS = 10 * 60_000;

const SITES_SHOWN = 10;

export type CheckId =
	| "source"
	| "credentials"
	| "access"
	| "siteTag"
	| "hosts"
	| "siteUrl"
	| "index"
	| "scheduler"
	| "lastSync";

export type CheckStatus = "ok" | "problem" | "waiting" | "skipped";

export interface Check {
	id: CheckId;
	status: CheckStatus;
	detail: string;
}

export interface TaskFacts {
	name: string;
	schedule: string;
	nextRunAt: string;
	lastRunAt: string | null;
}

export interface SetupFacts {
	provider: AnalyticsSettings["provider"];
	/** Settings keys the data source still needs. */
	missing: string[];
	siteTag: string;
	/** The hostnames the plugin counts; empty means every host the site reports. */
	hosts: string[];
	siteUrl: string;
	/** Null when nothing was asked: demo data, or credentials missing. */
	discovery: Result<Site[]> | null;
	/** Null when the host runs no scheduler at all. */
	tasks: TaskFacts[] | null;
	/** When the dashboard first found the sync waiting; read only while nothing has synced. */
	waitingSince?: string;
	state: SyncState;
	now: Date;
}

export async function loadSetup(ctx: PluginContext, now: Date): Promise<SetupFacts> {
	const state = await readState(ctx);
	const settings = await readSettings(ctx);
	const values = settings.ok ? settings.settings : settings.partial;
	const tasks = ctx.cron ? await ctx.cron.list() : null;
	const waitingSince = state.lastSync ? null : await ctx.kv.get<string>(WAITING_KEY);

	let discovery: Result<Site[]> | null = null;
	if (settings.ok && settings.settings.provider !== "demo") {
		const provider = buildProvider(ctx, settings.settings);
		const today = utcDay(now);
		discovery = provider
			? await provider.discoverSites({ since: addDays(today, -(DISCOVERY_DAYS - 1)), until: today })
			: null;
	}

	return {
		provider: values.provider ?? "cloudflare",
		missing: settings.ok ? [] : settings.missing,
		siteTag: values.siteTag ?? "",
		hosts: values.hosts ?? [],
		siteUrl: ctx.site.url,
		discovery,
		...(waitingSince && { waitingSince }),
		tasks:
			tasks?.map((task) => ({
				name: task.name,
				schedule: task.schedule,
				nextRunAt: task.nextRunAt,
				lastRunAt: task.lastRunAt,
			})) ?? null,
		state,
		now,
	};
}

/** Every check, in the order a fix has to happen. */
export function checkSetup(facts: SetupFacts, locale: string | undefined): Check[] {
	const lang = langOf(locale);
	const words = wordsOf(facts.provider);
	const checks: Check[] = [{ id: "source", status: "ok", detail: t(lang, words?.source ?? "sourceDemo") }];

	if (words) checks.push(...providerChecks(facts, words, lang));

	checks.push(
		siteUrlCheck(facts, lang),
		indexCheck(facts, lang),
		schedulerCheck(facts, lang),
		lastSyncCheck(facts, lang),
	);
	return checks;
}

/**
 * The sentences of the provider checks, which name the provider's own
 * terms: a token, an account and a site tag on Cloudflare, a key and a
 * website ID on Umami. The checks themselves are the same.
 */
interface SourceWords {
	source: MessageKey;
	/** The settings key of the secret, whose saving can fail without an encryption key. */
	secret: string;
	encryptionHint: MessageKey;
	needsCredentials: MessageKey;
	accessOk: MessageKey;
	needsAccess: MessageKey;
	/** No site chosen, and discovery has sites to choose from. */
	siteMissing: MessageKey;
	/** No site chosen, and discovery found none. */
	siteMissingNoSites: MessageKey;
	/** A site is chosen, and discovery found other sites only. */
	siteNotFound: MessageKey;
	/** A site is chosen, and discovery found none at all. */
	siteNotFoundNoSites: MessageKey;
	needsSite: MessageKey;
	hostsEvery: MessageKey;
	hostsNone: MessageKey;
	labels: Partial<Record<CheckId, MessageKey>>;
	sitesTitle: MessageKey;
	colSite: MessageKey;
	sitesNote: MessageKey;
}

const CLOUDFLARE_WORDS: SourceWords = {
	source: "sourceCloudflare",
	secret: "cfApiToken",
	encryptionHint: "encryptionKeyHint",
	needsCredentials: "needsCredentials",
	accessOk: "accessOk",
	needsAccess: "needsAccess",
	siteMissing: "siteTagMissing",
	siteMissingNoSites: "accountNoTraffic",
	siteNotFound: "siteTagNotFound",
	siteNotFoundNoSites: "accountNoTraffic",
	needsSite: "needsSiteTag",
	hostsEvery: "hostsEvery",
	hostsNone: "hostsNone",
	labels: {},
	sitesTitle: "sitesTitle",
	colSite: "colSiteTag",
	sitesNote: "sitesNote",
};

const UMAMI_WORDS: SourceWords = {
	source: "sourceUmami",
	secret: "umamiApiKey",
	encryptionHint: "encryptionKeyHintUmami",
	needsCredentials: "needsCredentialsUmami",
	accessOk: "accessOkUmami",
	needsAccess: "needsAccessUmami",
	siteMissing: "websiteIdMissing",
	siteMissingNoSites: "websiteIdMissingNoList",
	siteNotFound: "websiteNoTraffic",
	siteNotFoundNoSites: "websiteNoTraffic",
	needsSite: "needsWebsiteId",
	hostsEvery: "hostsEveryUmami",
	hostsNone: "hostsNoneUmami",
	labels: { credentials: "checkCredentialsUmami", access: "checkAccessUmami", siteTag: "checkWebsiteId" },
	sitesTitle: "websitesTitle",
	colSite: "colWebsiteId",
	sitesNote: "websitesNote",
};

/** Null for demo data, which has no provider to check. */
function wordsOf(provider: ProviderId): SourceWords | null {
	if (provider === "demo") return null;
	return provider === "umami" ? UMAMI_WORDS : CLOUDFLARE_WORDS;
}

function providerChecks(facts: SetupFacts, words: SourceWords, lang: Lang): Check[] {
	if (facts.missing.length > 0) {
		const problem: Problem = { key: "notConfigured", params: { missing: facts.missing.join(",") } };
		const detail = [problemText(lang, problem)];
		if (facts.missing.includes(words.secret)) detail.push(t(lang, words.encryptionHint));
		return [
			{ id: "credentials", status: "problem", detail: detail.join(" ") },
			skipped("access", lang, words.needsCredentials),
			skipped("siteTag", lang, words.needsCredentials),
			skipped("hosts", lang, words.needsCredentials),
		];
	}

	const credentials: Check = { id: "credentials", status: "ok", detail: t(lang, "credentialsSaved") };
	const discovery = facts.discovery;
	if (!discovery || !discovery.ok) {
		const detail = discovery && !discovery.ok ? errorText(discovery, lang) : t(lang, words.needsAccess);
		return [
			credentials,
			{ id: "access", status: "problem", detail },
			skipped("siteTag", lang, words.needsAccess),
			skipped("hosts", lang, words.needsAccess),
		];
	}

	const access: Check = { id: "access", status: "ok", detail: t(lang, words.accessOk) };
	const sites = discovery.value;
	const days = DISCOVERY_DAYS;

	if (!facts.siteTag) {
		return [
			credentials,
			access,
			{
				id: "siteTag",
				status: "problem",
				detail: t(lang, sites.length > 0 ? words.siteMissing : words.siteMissingNoSites, { days }),
			},
			skipped("hosts", lang, words.needsSite),
		];
	}

	const site = sites.find((s) => s.siteTag === facts.siteTag);
	if (!site) {
		return [
			credentials,
			access,
			{
				id: "siteTag",
				status: "problem",
				detail: t(lang, sites.length > 0 ? words.siteNotFound : words.siteNotFoundNoSites, { days }),
			},
			skipped("hosts", lang, words.needsSite),
		];
	}

	const siteTag: Check = {
		id: "siteTag",
		status: "ok",
		detail: t(lang, "siteTagFound", { tag: site.siteTag, count: formatCount(site.pageviews ?? 0, lang), days }),
	};
	return [credentials, access, siteTag, hostsCheck(facts, site, words, lang)];
}

function hostsCheck(facts: SetupFacts, site: Site, words: SourceWords, lang: Lang): Check {
	const reported = site.hosts.map(normalizeHost);
	const list = (hosts: string[]) => hosts.join(", ");
	if (facts.hosts.length === 0) {
		return { id: "hosts", status: "ok", detail: t(lang, words.hostsEvery, { hosts: list(reported) }) };
	}

	const filter = new Set(facts.hosts.map(normalizeHost));
	const counted = reported.filter((host) => filter.has(host));
	const excluded = reported.filter((host) => !filter.has(host));
	if (counted.length === 0) {
		return {
			id: "hosts",
			status: "problem",
			detail: t(lang, words.hostsNone, { reported: list(reported), counted: list([...filter]) }),
		};
	}
	if (excluded.length > 0) {
		return {
			id: "hosts",
			status: "ok",
			detail: t(lang, "hostsPartly", { counted: list(counted), excluded: list(excluded) }),
		};
	}
	return { id: "hosts", status: "ok", detail: t(lang, "hostsCounted", { hosts: list(counted) }) };
}

function siteUrlCheck(facts: SetupFacts, lang: Lang): Check {
	if (!facts.siteUrl) return { id: "siteUrl", status: "problem", detail: t(lang, "siteUrlMissing") };
	return { id: "siteUrl", status: "ok", detail: facts.siteUrl };
}

function indexCheck(facts: SetupFacts, lang: Lang): Check {
	const { state } = facts;
	if (!state.indexComplete) return { id: "index", status: "waiting", detail: t(lang, "noEntriesIndexing") };
	const count = state.indexed ?? 0;
	if (count > 0) return { id: "index", status: "ok", detail: t(lang, "indexMatched", { count: count }) };
	if (!facts.siteUrl) return skipped("index", lang, "needsSiteUrl");
	return { id: "index", status: "problem", detail: t(lang, "noEntriesNoUrls") };
}

function schedulerCheck(facts: SetupFacts, lang: Lang): Check {
	if (!facts.tasks) return { id: "scheduler", status: "problem", detail: t(lang, "syncUnschedulable") };

	const sync = facts.tasks.find((task) => task.name === SYNC_TASK);
	if (!sync) return { id: "scheduler", status: "problem", detail: t(lang, "schedulerNotScheduled") };

	const minutes = intervalMinutes(sync.schedule);
	const interval = intervalText(minutes, lang);
	const late = (iso: string | null | undefined, graceMs: number) =>
		iso !== null && iso !== undefined && facts.now.getTime() - Date.parse(iso) > graceMs;
	const age = (iso: string) => formatAge(iso, facts.now, lang) ?? iso;

	const refresh = facts.tasks.find((task) => task.name === REFRESH_TASK);
	if (refresh && late(refresh.nextRunAt, ONESHOT_GRACE_MS)) {
		return {
			id: "scheduler",
			status: "problem",
			detail: t(lang, "schedulerRefreshStuck", { age: age(refresh.nextRunAt) }),
		};
	}

	const graceMs = 2 * minutes * 60_000;
	if (sync.lastRunAt) {
		if (late(sync.lastRunAt, graceMs)) {
			return {
				id: "scheduler",
				status: "problem",
				detail: t(lang, "schedulerStale", { age: age(sync.lastRunAt), interval }),
			};
		}
		return { id: "scheduler", status: "ok", detail: t(lang, "schedulerOk", { age: age(sync.lastRunAt), interval }) };
	}

	const { waitingSince } = facts;
	if (!facts.state.lastSync && waitingSince && late(waitingSince, graceMs)) {
		return {
			id: "scheduler",
			status: "problem",
			detail: t(lang, "schedulerNeverRan", { age: age(waitingSince), interval }),
		};
	}
	return { id: "scheduler", status: "waiting", detail: t(lang, "schedulerWaiting", { interval }) };
}

function lastSyncCheck(facts: SetupFacts, lang: Lang): Check {
	const { state, now } = facts;
	if (state.lastError) {
		const error = state.lastProblem ? problemText(lang, state.lastProblem) : state.lastError;
		const at = formatAge(state.lastErrorAt, now, lang);
		return {
			id: "lastSync",
			status: "problem",
			detail: at ? t(lang, "lastAttemptFailedAge", { age: at, error }) : t(lang, "lastAttemptFailed", { error }),
		};
	}
	const age = formatAge(state.lastSync, now, lang);
	if (!age) return { id: "lastSync", status: "waiting", detail: t(lang, "notSynced") };
	return { id: "lastSync", status: "ok", detail: t(lang, "synced", { age }) };
}

function skipped(id: CheckId, lang: Lang, reason: MessageKey): Check {
	return { id, status: "skipped", detail: t(lang, reason) };
}

function errorText(result: { error: string; problem?: Problem }, lang: Lang): string {
	return result.problem ? problemText(lang, result.problem) : result.error;
}

/**
 * Minutes between two runs of a sync interval. The settings offer four
 * fixed schedules; anything else falls back to the default's fifteen.
 */
export function intervalMinutes(schedule: string): number {
	const everyMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
	if (everyMinutes) return Number(everyMinutes[1]);
	if (/^0 \* \* \* \*$/.test(schedule)) return 60;
	const everyHours = /^0 \*\/(\d+) \* \* \*$/.exec(schedule);
	if (everyHours) return Number(everyHours[1]) * 60;
	return 15;
}

function intervalText(minutes: number, lang: Lang): string {
	return minutes % 60 === 0 ? t(lang, "hours", { count: minutes / 60 }) : t(lang, "minutes", { count: minutes });
}

const CHECK_LABELS: Record<CheckId, MessageKey> = {
	source: "checkSource",
	credentials: "checkCredentials",
	access: "checkAccess",
	siteTag: "checkSiteTag",
	hosts: "checkHosts",
	siteUrl: "checkSiteUrl",
	index: "checkIndex",
	scheduler: "checkScheduler",
	lastSync: "checkLastSync",
};

const STATUS_LABELS: Record<CheckStatus, MessageKey> = {
	ok: "statusOk",
	problem: "statusProblem",
	waiting: "statusWaiting",
	skipped: "statusSkipped",
};

const CRON_TRIGGER_SNIPPET = `// wrangler.jsonc
"triggers": { "crons": ["* * * * *"] }`;

const SCHEDULED_HANDLER_SNIPPET = `// src/worker.ts
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;`;

/**
 * The check as blocks. `backValue` is the analytics page's range, carried
 * so "Back to analytics" returns to the range the reader left.
 */
export function renderSetup(facts: SetupFacts, backValue: number, locale: string | undefined): AnalyticsBlock[] {
	const lang = langOf(locale);
	const checks = checkSetup(facts, locale);
	const problems = checks.filter((check) => check.status === "problem").length;
	const words = wordsOf(facts.provider) ?? CLOUDFLARE_WORDS;

	const out: AnalyticsBlock[] = [
		actions(
			[
				button(RANGE_ACTION, t(lang, "backToAnalytics"), { style: "secondary", value: backValue }),
				button(SETUP_ACTION, t(lang, "checkAgain"), { style: "secondary", value: backValue }),
			],
			{ blockId: "analytics:setup:controls" },
		),
		header(t(lang, "setupTitle")),
		problems > 0
			? banner({ description: t(lang, "setupProblems", { count: problems }), variant: "error" })
			: banner({ description: t(lang, "setupAllGood") }),
		table({
			blockId: "analytics:setup:checks",
			pageActionId: "analytics:setup:checks:page",
			columns: [
				{ key: "check", label: t(lang, "colCheck"), format: "text" },
				{ key: "status", label: t(lang, "colStatus"), format: "badge" },
				{ key: "detail", label: t(lang, "colDetails"), format: "text" },
			],
			rows: checks.map((check) => ({
				check: t(lang, words.labels[check.id] ?? CHECK_LABELS[check.id]),
				status: t(lang, STATUS_LABELS[check.status]),
				detail: check.detail,
			})),
		}),
	];

	const scheduler = checks.find((check) => check.id === "scheduler");
	if (scheduler?.status === "problem" && facts.tasks) {
		out.push(context(t(lang, "schedulerHowTo")));
		out.push(code(CRON_TRIGGER_SNIPPET, { language: "jsonc" }));
		out.push(code(SCHEDULED_HANDLER_SNIPPET, { language: "ts" }));
	}

	const sites = facts.discovery?.ok ? facts.discovery.value : [];
	const siteTag = checks.find((check) => check.id === "siteTag");
	const hosts = checks.find((check) => check.id === "hosts");
	if (sites.length > 0 && (siteTag?.status === "problem" || hosts?.status === "problem")) {
		// A provider's list names its sites or counts their views, depending
		// on what its discovery can tell. A column nothing fills is left out.
		const named = sites.some((site) => site.name !== undefined);
		const counted = sites.some((site) => site.pageviews !== undefined);
		out.push(header(t(lang, words.sitesTitle)));
		out.push(
			table({
				blockId: "analytics:setup:sites",
				pageActionId: "analytics:setup:sites:page",
				columns: [
					{ key: "tag", label: t(lang, words.colSite), format: "code" },
					...(named ? [{ key: "name", label: t(lang, "colName"), format: "text" as const }] : []),
					{ key: "hosts", label: t(lang, "colHostnames"), format: "text" },
					...(counted ? [{ key: "views", label: t(lang, "colViews"), format: "number" as const }] : []),
				],
				rows: sites.slice(0, SITES_SHOWN).map((site) => ({
					tag: site.siteTag,
					...(named && { name: site.name ?? "" }),
					hosts: site.hosts.join(", "),
					...(counted && { views: site.pageviews ?? 0 }),
				})),
			}),
		);
		out.push(context(t(lang, words.sitesNote, { days: DISCOVERY_DAYS })));
	}

	return out;
}
