/**
 * The setup check: a view of the analytics page that runs every check the
 * numbers depend on and names the fix for each one that fails.
 *
 * The generated settings form stays the only place to enter values; this
 * view only reads. It exists because most setup mistakes do not fail, they
 * produce zeroes: a website without the tracking script, a hostname
 * filter that excludes the host Umami reports, a site without a stored
 * URL, a Worker without a Cron Trigger. None of those raises an error the
 * sync could record.
 *
 * Calls: the state, the settings, the task list, the waiting mark until the
 * first sync, and the discovery. With a website ID set that is one request
 * to Umami, which answers access, the website and its hostnames at once,
 * and a second only when the first is refused, to tell a wrong key from a
 * website the key's user may not view. Without one it lists the user's
 * websites and their teams', which is six requests at most and, with the
 * four calls above, ten.
 */

import type { PluginContext } from "emdash/plugin";

import { langOf, problemText, t, type Lang, type MessageKey, type Problem } from "../i18n.js";
import { normalizeHost } from "../index/paths.js";
import type { Result, Site } from "../providers/types.js";
import { readSettings, type AnalyticsSettings } from "../settings.js";
import { buildProvider, readState, REFRESH_TASK, SYNC_TASK, WAITING_KEY, type SyncState } from "../sync/scheduler.js";
import { addDays, localDay } from "../sync/window.js";
import { actions, banner, button, code, context, header, table, type AnalyticsBlock } from "./blocks.js";
import { formatAge, formatCount } from "./format.js";
import { RANGE_ACTION, SETUP_ACTION } from "./page.js";

/**
 * Discovery reads the last week: the hostnames a website reported lately
 * are the ones the hostname filter has to match.
 */
const DISCOVERY_DAYS = 7;

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
		const today = localDay(now, settings.settings.timeZone);
		discovery = provider
			? await provider.discoverSites({ since: addDays(today, -(DISCOVERY_DAYS - 1)), until: today })
			: null;
	}

	return {
		provider: values.provider ?? "umami",
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
	const umami = facts.provider === "umami";
	const checks: Check[] = [{ id: "source", status: "ok", detail: t(lang, umami ? "sourceUmami" : "sourceDemo") }];

	if (umami) checks.push(...providerChecks(facts, lang));

	checks.push(
		siteUrlCheck(facts, lang),
		indexCheck(facts, lang),
		schedulerCheck(facts, lang),
		lastSyncCheck(facts, lang),
	);
	return checks;
}

function providerChecks(facts: SetupFacts, lang: Lang): Check[] {
	if (facts.missing.length > 0) {
		const problem: Problem = { key: "notConfigured", params: { missing: facts.missing.join(",") } };
		const detail = [problemText(lang, problem)];
		if (facts.missing.includes("umamiApiKey")) detail.push(t(lang, "encryptionKeyHintUmami"));
		return [
			{ id: "credentials", status: "problem", detail: detail.join(" ") },
			skipped("access", lang, "needsCredentialsUmami"),
			skipped("siteTag", lang, "needsCredentialsUmami"),
			skipped("hosts", lang, "needsCredentialsUmami"),
		];
	}

	const credentials: Check = { id: "credentials", status: "ok", detail: t(lang, "credentialsSaved") };
	const discovery = facts.discovery;
	if (!discovery || !discovery.ok) {
		const detail = discovery && !discovery.ok ? errorText(discovery, lang) : t(lang, "needsAccessUmami");
		return [
			credentials,
			{ id: "access", status: "problem", detail },
			skipped("siteTag", lang, "needsAccessUmami"),
			skipped("hosts", lang, "needsAccessUmami"),
		];
	}

	const access: Check = { id: "access", status: "ok", detail: t(lang, "accessOkUmami") };
	const sites = discovery.value;
	const days = DISCOVERY_DAYS;

	if (!facts.siteTag) {
		return [
			credentials,
			access,
			{
				id: "siteTag",
				status: "problem",
				detail: t(lang, sites.length > 0 ? "websiteIdMissing" : "websiteIdMissingNoList", { days }),
			},
			skipped("hosts", lang, "needsWebsiteId"),
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
				detail: t(lang, "websiteNoTraffic", { days }),
			},
			skipped("hosts", lang, "needsWebsiteId"),
		];
	}

	const siteTag: Check = {
		id: "siteTag",
		status: "ok",
		detail: t(lang, "siteTagFound", { tag: site.siteTag, count: formatCount(site.pageviews ?? 0, lang), days }),
	};
	return [credentials, access, siteTag, hostsCheck(facts, site, lang)];
}

function hostsCheck(facts: SetupFacts, site: Site, lang: Lang): Check {
	const reported = site.hosts.map(normalizeHost);
	const list = (hosts: string[]) => hosts.join(", ");
	if (facts.hosts.length === 0) {
		return { id: "hosts", status: "ok", detail: t(lang, "hostsEveryUmami", { hosts: list(reported) }) };
	}

	const filter = new Set(facts.hosts.map(normalizeHost));
	const counted = reported.filter((host) => filter.has(host));
	const excluded = reported.filter((host) => !filter.has(host));
	if (counted.length === 0) {
		return {
			id: "hosts",
			status: "problem",
			detail: t(lang, "hostsNoneUmami", { reported: list(reported), counted: list([...filter]) }),
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
	credentials: "checkCredentialsUmami",
	access: "checkAccessUmami",
	siteTag: "checkWebsiteId",
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
				check: t(lang, CHECK_LABELS[check.id]),
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
		out.push(header(t(lang, "websitesTitle")));
		out.push(
			table({
				blockId: "analytics:setup:sites",
				pageActionId: "analytics:setup:sites:page",
				columns: [
					{ key: "tag", label: t(lang, "colWebsiteId"), format: "code" },
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
		out.push(context(t(lang, "websitesNote", { days: DISCOVERY_DAYS })));
	}

	return out;
}
