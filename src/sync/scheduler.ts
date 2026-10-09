/**
 * The sync job.
 *
 * Three constraints decide the shape of this file, and none of them is
 * obvious from the outside:
 *
 * 1. **Ten subrequests per sandboxed invocation.** Every `ctx` call
 *    crosses the bridge as one, `log` included, and the eleventh aborts
 *    the invocation. Each phase below is annotated with its call count,
 *    `tests/budget.test.ts` counts them, and no tick logs: a failure is
 *    recorded in the sync state, where the widget shows it.
 * 2. **No retry, no backoff.** A recurring cron failure is logged and
 *    `next_run_at` simply advances. So every tick derives its work from
 *    stored state and never assumes the previous one ran.
 * 3. **The sampling cliff.** A window whose `date_geq` reaches more than
 *    seven days back returns tenfold-quantized numbers for every day in
 *    it. `syncWindow` clamps; the adapter refuses; `decideWrite` refuses
 *    to downgrade. Three layers, because getting this wrong corrupts the
 *    store silently.
 *
 * The tick alternates between an overview phase and a paths phase rather
 * than doing both, which is what keeps either side inside the budget.
 * Work that needs no provider (walking the content, summing stored days)
 * borrows paths slots rather than adding calls to one.
 *
 * A provider that answers one day per request (`batchPaths: "wide-pull"`)
 * cannot fill the paths phase's window in one fetch. Its paths tick asks
 * for today and reads the other days from the store, and a history pass
 * (`./history.ts`) borrows paths slots to read closed days, one per step:
 * three slots of every four while it has earlier days to catch up on,
 * every other slot at most afterwards.
 */

import type { PluginContext } from "emdash/plugin";

import { failure, type Problem } from "../i18n.js";
import { bootstrapIndex, INDEX_PAGE_SIZE, INDEX_VERSION, type IndexCursor } from "../index/bootstrap.js";
import { createDemoProvider } from "../providers/demo.js";
import { createUmamiProvider } from "../providers/umami.js";
import type { DateRange, Overview, Provider, ProviderId } from "../providers/types.js";
import { chunk, dailyStore, entriesStore, rollupStore, BIND_LIMIT, ID_BATCH } from "../store/access.js";
import { dailyId, decideWrite, engagementOf, isPublished, type DailyRow, type EntryRow, type RollupRow } from "../store/rows.js";
import { recentViewsOf, withRecent } from "../store/views.js";
import { missingSettingsMessage, readSettings, type AnalyticsSettings } from "../settings.js";
import { historyBackfilling, historyDue, runHistoryStep, type HistoryPass } from "./history.js";
import { readRanges, readsDue, readsMissing, type ReadSnapshot } from "./reads.js";
import { olderDue, olderSettled, runOlderStep, type OlderPass } from "./older.js";
import {
	addDays,
	backfillWindow,
	DEFAULT_TIME_ZONE,
	enumerateDays,
	localDay,
	syncWindow,
	UNSAMPLED_WINDOW_DAYS,
	type Day,
} from "./window.js";

export const SYNC_TASK = "sync";
export const RECONCILE_TASK = "reconcile";
/** The one-shot tick a Refresh asks for. */
export const REFRESH_TASK = "refresh";
export const STATE_KEY = "state";
/** When the dashboard first found the sync scheduled and never run (see `noteWaiting`). */
export const WAITING_KEY = "waitingSince";

/**
 * The paths phase asks for the whole unsampled window rather than a
 * two-day overlap, because that makes `views7` exactly the sum of what
 * the request returned — no extra storage reads, no accumulator to get
 * wrong. It costs more ids to compare, which is what bounds the chunk.
 */
const PATHS_WINDOW_DAYS = UNSAMPLED_WINDOW_DAYS;

/** Days the widget's cards and page table count, today included. */
export const WIDGET_DAYS = 7;

/**
 * Days before today each overview re-reads. Late beacons would need two;
 * the top-path snapshot has to span the widget's week, because the
 * widget's table shows it under the weekly cards. Days that already froze
 * are skipped on write, so the wider read writes no more rows.
 */
const OVERVIEW_DAYS_BACK = WIDGET_DAYS - 1;

/** How many days of history the widget's chart shows. */
export const CHART_DAYS = 30;

export interface SyncState {
	phase: "overview" | "paths";
	/** Keyset cursor into `entries`, so a pass resumes where it stopped. */
	cursor?: string;
	/** Where the catch-up walk over pre-existing content continues. */
	index?: IndexCursor;
	lastSync?: string;
	lastError?: string;
	/** The same failure as a catalogue key, so each reader sees it in their language. */
	lastProblem?: Problem;
	lastErrorAt?: string;
	/**
	 * The phase that failed. Only a success of that phase clears the error:
	 * a Refresh runs an overview out of turn, and clearing a paths failure
	 * there would hide it until the next paths tick fails again.
	 */
	lastErrorPhase?: SyncState["phase"];
	/** Snapshot for the widget, so rendering never queries the provider. */
	topPaths?: Array<{ path: string; pageviews: number; visits: number }>;
	referrers?: Array<{ label: string; visits: number }>;
	countries?: Array<{ label: string; visits: number }>;
	/** First day of the window the referrer, country and top-path snapshot covers. */
	snapshotSince?: Day;
	/** True when the last overview's numbers were estimated from a sample. */
	estimated?: boolean;
	sitesHint?: string;
	/**
	 * True once the catch-up walk over pre-existing content has finished.
	 * Until then the alternate phase indexes instead of fetching, because
	 * asking the provider about paths nobody has indexed returns nothing.
	 * It stays true while a later walk repairs the index.
	 */
	indexComplete?: boolean;
	/** Rows the index walks added themselves. Entries the content hooks stored first are not counted here. */
	indexed?: number;
	/**
	 * Published entries stored in the index, as the last complete walk or
	 * paths pass counted them. Unlike `indexed`, it counts rows whatever
	 * stored them, which is what "nothing matched" has to be decided on.
	 * Undefined on a state from before 0.1.3 until the next count.
	 */
	matched?: number;
	/** Published entries the running index walk has found stored so far. */
	walkMatched?: number;
	/** Published entries the running paths pass has read so far. */
	passMatched?: number;
	/** The `INDEX_VERSION` of the last walk that completed. An older one gets repaired. */
	indexVersion?: number;
	/**
	 * Collection labels by slug, as the index walk last listed them. Kept
	 * here so the analytics page can name collections without spending a
	 * bridge call on the schema.
	 */
	collectionLabels?: Record<string, string>;
	/** Set by the content page's Rebuild button: walk the content again. */
	rebuild?: boolean;
	/** Today's pass summing the older part of `views30`. */
	older?: OlderPass;
	/** Which closed days a wide-pull provider has been read for. */
	history?: HistoryPass;
	/** History steps taken in a row, counted while `lastWork` says the last slot was one. */
	historyRun?: number;
	/** Read-through, as the last read of the read event left it. */
	reads?: ReadSnapshot;
	/** The chained run scheduled last while catching up: its task and when it is due. */
	chain?: { next: string; at: string };
	/**
	 * What the last non-overview slot did. A repair walk or the older pass
	 * takes every other slot, never two in a row, so view counts keep
	 * updating while they run. So does the history pass, except while it
	 * is catching up (`HISTORY_BACKFILL_RUN`).
	 */
	lastWork?: "index" | "older" | "history" | "reads" | "paths";
	/** The provider whose numbers are in storage. */
	provider?: ProviderId;
	/** True once the first overview has pulled the provider's exact window. */
	backfilled?: boolean;
	/** Keyset cursor into `entries` while a provider switch resets views. */
	wipeCursor?: string;
	/**
	 * The IANA zone the stored days are keyed in. Version 0.1.2 and earlier
	 * keyed them in UTC and wrote no zone, so a state that records a
	 * provider and no zone holds UTC days. A stored zone that differs from
	 * the Time zone setting clears the stored numbers (see `runWipe`), and
	 * the history pass reads them again.
	 */
	dayZone?: string;
}

/** Referrer and country rows kept from each overview, for the analytics page. */
const SNAPSHOT_ROWS = 10;

/**
 * Bridge calls a provider-switch wipe may spend on its batches: ten, less
 * the state read, the settings read and the state write, and one less again
 * when it schedules a chained run. A batch is a query and a delete or
 * reset, so the loop only starts one with two left.
 */
const WIPE_CALLS = 7;

/** Prune batches per reconcile run: a settings read, then a query and a delete per batch. */
const PRUNE_BATCHES = 4;

/**
 * Bridge calls the older pass may spend on storage: ten, less the state
 * read, the settings read and the state write.
 */
const OLDER_CALLS = 7;

/**
 * Bridge calls a history step may spend on the provider and on storage:
 * ten, less the state read, the settings read and the state write.
 */
const HISTORY_CALLS = 7;

/** The most paths a paths tick reads: three reads of 98 ids over the eight days of the window. */
const MAX_PATHS_PER_TICK = 36;
const PATHS_PER_READ = 12;

/**
 * History steps in a row while the pass still has earlier days to read,
 * before the paths tick gets the slot again.
 *
 * Every slot would finish soonest, but the paths tick is the only thing
 * that writes an entry's view counts: without a turn, the per-entry page
 * of a new install would stay at zero until the whole backfill was done,
 * and the days the pass reads would not reach those counts either. Three
 * to one reads 90 days in about two and a half days at the default
 * interval, against just under two for every slot, and gives the paths
 * tick 36 entries every two hours meanwhile.
 */
const HISTORY_BACKFILL_RUN = 3;

export interface SyncOutcome {
	phase: SyncState["phase"];
	ok: boolean;
	error?: string;
	/** Rows actually written, as opposed to compared and skipped. */
	written: number;
	skipped: number;
	paths?: number;
	problem?: Problem;
}

/**
 * Schedule both tasks, idempotently.
 *
 * Called from `plugin:activate`, from the content hooks and from the
 * widget's first `page_load` — because `plugin:activate` is dispatched
 * only by the admin Enable endpoint, and a plugin registered through
 * `plugins: []` in the site config never gets one. That is the npm
 * channel, which is the channel most installs use. `CronAccess.schedule`
 * upserts on (plugin, task), so calling it repeatedly is free of
 * consequence.
 */
export async function ensureScheduled(ctx: PluginContext, interval: string): Promise<void> {
	if (!ctx.cron) return;
	try {
		await ctx.cron.schedule(SYNC_TASK, { schedule: interval });
		await ctx.cron.schedule(RECONCILE_TASK, { schedule: "10 3 * * *" });
	} catch (error) {
		ctx.log.warn("analytics: could not schedule sync", { error: String(error) });
	}
}

/**
 * Ask for a tick now instead of running one inside the admin request.
 *
 * A route has the same ten-call budget as a tick and still has to render
 * afterwards, so it cannot afford a sync phase. The one-shot runs on the
 * next scheduler pass: at once on Node, with the next Cron Trigger on
 * Workers. It has its own name because scheduling a one-shot under
 * `sync` would turn the recurring task into one that runs once.
 *
 * Returns false when the host runs no scheduler.
 */
export async function requestRefresh(ctx: PluginContext, now: Date): Promise<boolean> {
	if (!ctx.cron) return false;
	await ctx.cron.schedule(REFRESH_TASK, { schedule: now.toISOString() });
	return true;
}

/**
 * Remember when the dashboard first found the sync scheduled and not yet
 * run. The task list cannot tell: every dashboard visit re-schedules the
 * task, which moves its next run, so a scheduler that never runs is
 * measured from here. A key of its own, because a first tick may write the
 * state between this read and this write.
 */
export async function noteWaiting(ctx: PluginContext, state: SyncState, now: Date): Promise<void> {
	if (state.lastSync) return;
	if (await ctx.kv.get<string>(WAITING_KEY)) return;
	await ctx.kv.set(WAITING_KEY, now.toISOString());
}

export async function readState(ctx: PluginContext): Promise<SyncState> {
	const state = await ctx.kv.get<SyncState>(STATE_KEY);
	return state ?? { phase: "overview" };
}

export function buildProvider(ctx: PluginContext, settings: AnalyticsSettings): Provider | null {
	if (settings.provider === "demo") {
		return createDemoProvider({
			listPaths: async () => {
				const page = await entriesStore(ctx)?.query({ orderBy: { path: "asc" }, limit: BIND_LIMIT });
				return (page?.items ?? []).filter((item) => item.data.status !== "deleted").map((item) => item.data.path);
			},
			trailingSlash: ctx.site.trailingSlash,
			timeZone: settings.timeZone,
		});
	}
	if (!ctx.http) return null;
	const http = ctx.http;
	return createUmamiProvider({
		apiKey: settings.apiToken,
		websiteId: settings.siteTag,
		apiUrl: settings.umamiApiUrl,
		hosts: settings.hosts,
		trailingSlash: ctx.site.trailingSlash,
		timeZone: settings.timeZone,
		fetch: (url, init) => http.fetch(url, init),
	});
}

/**
 * One tick.
 *
 * Overview phase: kv.get, settings.list, fetch, rollup.getMany,
 * rollup.putMany, kv.set — six bridge calls.
 *
 * Paths phase: kv.get, settings.list, entries.query, fetch, up to three
 * daily.getMany, daily.putMany, entries.putMany, kv.set — ten at most.
 *
 * A wide-pull provider spends the same ten differently. Its overview
 * makes five fetches, which with the five calls around them is ten. Its
 * paths phase makes one fetch for today and always reads three
 * daily.getMany, which is ten as well.
 *
 * The paths slot also carries the background work: the first index walk
 * takes it outright, and a repair walk, a step of the daily older pass or
 * a step of a wide-pull provider's history pass takes every other one.
 * While the history pass is catching up on earlier days it also takes
 * the two slots after its own, so three of every four.
 *
 * `overview` runs the overview phase whatever the alternation says: a
 * Refresh is asked for to update the totals, which only that phase reads.
 *
 * `catchUp` names the chained one-shot task that started this run (see
 * `CATCH_UP_TASKS`). While the plugin is catching up, a run in a paths
 * slot keeps one call back and spends it scheduling the next run a little
 * under a minute later, instead of leaving the work to the next sync.
 */
export async function runSync(
	ctx: PluginContext,
	now: Date = new Date(),
	options: { overview?: boolean; catchUp?: string } = {},
): Promise<SyncOutcome> {
	let state = await readState(ctx);
	const result = await readSettings(ctx);

	// Numbers from one provider must never be read as another's: demo data
	// left behind after switching to Umami would look like real traffic. So
	// a switch clears storage before anything else happens, including before
	// a missing credential stops the tick.
	//
	// Every phase that stores a provider's numbers records the provider with
	// them, so a state without one holds nothing to clear.
	const target = result.ok ? result.settings.provider : (result.partial.provider ?? "umami");
	const stored = state.provider;
	// Days keyed in another zone are cleared the same way: a day key means
	// one calendar day, and a UTC day stored beside a Sydney one would be
	// counted against the wrong date. That is every store 0.1.2 left
	// behind, which records no zone, and a store whose Time zone setting
	// has changed since.
	const zone = result.ok ? result.settings.timeZone : (result.partial.timeZone ?? DEFAULT_TIME_ZONE);
	if (stored && (stored !== target || state.dayZone !== zone)) {
		return await runWipe(ctx, state, target, zone, now, options.catchUp);
	}
	// Nothing stored yet: the days this run stores are keyed in the zone.
	if (state.dayZone !== zone) state = { ...state, dayZone: zone };

	if (!result.ok) {
		const problem: Problem = { key: "notConfigured", params: { missing: result.missing.join(",") } };
		return await fail(ctx, state, state.phase, missingSettingsMessage(result.missing), now, problem);
	}

	const settings = result.settings;
	// Turned off, read-through leaves nothing behind for a page to show.
	if (!settings.reads && state.reads) state = { ...state, reads: undefined };
	const provider = buildProvider(ctx, settings);
	if (!provider) {
		const { error, problem } = failure("noNetwork");
		return await fail(ctx, state, state.phase, error, now, problem);
	}

	// A website ID is optional in the form. Without one there is nothing to
	// query, but the operator gets a usable hint instead of silence. Demo
	// data has no sites to choose between.
	if (!settings.siteTag && settings.provider !== "demo") {
		return await suggestSite(ctx, provider, state, now, settings.timeZone);
	}

	// A chained run always takes a paths slot: the recurring sync, which
	// finds the phase set back to "overview" by every paths slot, keeps the
	// overview at its own interval.
	const chain = chainFor(state, settings, provider, now, options, Boolean(ctx.cron));
	if (chain) state = { ...state, chain: { next: chain.next, at: chain.at } };
	const reserve = chain ? 1 : 0;

	if (options.overview || (!chain && state.phase !== "paths")) {
		return await runOverviewPhase(ctx, provider, state, now, settings.timeZone);
	}

	const outcome = await runSlot(ctx, provider, settings, state, now, reserve);
	const after = lastWritten.get(ctx);
	if (chain && ctx.cron && outcome.ok && after && catchingUp(after, settings, provider, now)) {
		await ctx.cron.schedule(chain.next, { schedule: chain.at });
	}
	return outcome;
}

/** One paths slot: the index walk, the background passes, or the paths tick. */
async function runSlot(
	ctx: PluginContext,
	provider: Provider,
	settings: AnalyticsSettings,
	state: SyncState,
	now: Date,
	reserve: number,
): Promise<SyncOutcome> {
	// Catching up on content that predates the plugin comes first: the
	// paths phase can only ask about paths the index already knows.
	if (!state.indexComplete) return await runIndexPhase(ctx, state, now, reserve);

	const today = localDay(now, settings.timeZone);
	const background = ["index", "older", "history", "reads"] as Array<SyncState["lastWork"]>;
	if (!background.includes(state.lastWork)) {
		if (indexOutdated(state)) return await runIndexPhase(ctx, state, now, reserve);
		if (olderDue(state.older, today)) return await runOlderPhase(ctx, state, now, today, reserve);
		if (provider.readThrough && settings.reads && readsDue(state.reads, settings.reads, now, today)) {
			return await runReadsPhase(ctx, provider, settings, state, now);
		}
		if (isWidePull(provider) && historyDue(state.history, today, historyFloor(settings, now))) {
			return await runHistoryPhase(ctx, provider, settings, state, now, reserve);
		}
	} else if (
		isWidePull(provider) &&
		state.lastWork === "history" &&
		(state.historyRun ?? 1) < HISTORY_BACKFILL_RUN &&
		historyBackfilling(state.history, historyFloor(settings, now))
	) {
		// Still catching up on earlier days: the pass keeps the slot. The
		// index walk and the older pass wait for the slot after a paths tick,
		// where they come first as always.
		return await runHistoryPhase(ctx, provider, settings, state, now, reserve);
	}

	return await runPathsPhase(ctx, provider, settings, state, now, reserve);
}

/**
 * The chained one-shot tasks. A one-shot is deleted once its run returns,
 * and scheduling a task again updates its row in place, so a run that
 * scheduled its own name would see the next run deleted with it. Two
 * names taking turns avoid that. They are not Refresh's name, because a
 * Refresh runs the overview, and a chained run must not.
 */
export const CATCH_UP_TASKS = ["catchup-a", "catchup-b"] as const;

/**
 * How long after a chained run the next one is due. A little under a
 * minute, so that on Workers, where one-shots run with the Cron Trigger,
 * a run started by one every-minute trigger is due by the next.
 */
export const CATCH_UP_DELAY_MS = 50_000;

/**
 * How long a scheduled chained run counts as pending. A run that never
 * happened, after a failure or a lost trigger, stops blocking a new chain
 * once this has passed.
 */
const CATCH_UP_PENDING_MS = 5 * 60_000;

/**
 * Is there work a run a minute from now would do sooner than the sync?
 *
 * Derived from the stored state alone: the first index walk, a repair
 * walk, the history pass short of the retention limit, and read-through
 * never read under the current settings. The routine work a caught-up
 * site has (today's numbers, the day that just closed, the daily older
 * pass, refreshing read-through) waits for the sync.
 */
export function catchingUp(state: SyncState, settings: AnalyticsSettings, provider: Provider, now: Date): boolean {
	if (!state.indexComplete || indexOutdated(state)) return true;
	if (isWidePull(provider) && historyBackfilling(state.history, historyFloor(settings, now))) return true;
	if (provider.readThrough && settings.reads && readsMissing(state.reads, settings.reads)) return true;
	return false;
}

/**
 * Whether this run continues or starts a chain, and the task and time it
 * would schedule. A chained run always continues one. A sync in a paths
 * slot starts one only when no chained run is pending, so a chain is never
 * doubled: the state remembers the run it scheduled last.
 */
function chainFor(
	state: SyncState,
	settings: AnalyticsSettings,
	provider: Provider,
	now: Date,
	options: { overview?: boolean; catchUp?: string },
	cron: boolean,
): { next: string; at: string } | null {
	if (options.overview || !cron) return null;
	if (!catchingUp(state, settings, provider, now)) return null;
	const at = new Date(now.getTime() + CATCH_UP_DELAY_MS).toISOString();
	if (options.catchUp) {
		const next = options.catchUp === CATCH_UP_TASKS[0] ? CATCH_UP_TASKS[1] : CATCH_UP_TASKS[0];
		return { next, at };
	}
	if (state.phase !== "paths") return null;
	const pending = state.chain && now.getTime() < Date.parse(state.chain.at) + CATCH_UP_PENDING_MS;
	if (pending) return null;
	return { next: state.chain?.next ?? CATCH_UP_TASKS[0], at };
}

/** Does the provider answer one day per request, so that closed days arrive through the history pass? */
function isWidePull(provider: Provider): boolean {
	return provider.capabilities.batchPaths === "wide-pull";
}

/** The oldest day worth reading: the first one `reconcile` would keep. */
function historyFloor(settings: AnalyticsSettings, now: Date): Day {
	return addDays(localDay(now, settings.timeZone), -settings.retentionDays);
}

/** Does the stored index come from an older walk, or has a rebuild been asked for? */
export function indexOutdated(state: SyncState): boolean {
	return Boolean(state.rebuild) || (state.indexVersion ?? 1) < INDEX_VERSION;
}

/**
 * Ask for the content to be walked again. The walk runs in the sync's
 * alternate slots, taking turns with the paths tick, and repairs rows in
 * place without touching their view counts.
 */
/**
 * Keep the stored collection labels current. The index walk records them
 * as it goes, but a site whose walk finished before labels were stored,
 * or that renamed a collection since, would otherwise keep showing slugs.
 * The per-entry page lists the collections anyway and calls this; it
 * writes only when a label changed.
 */
export async function rememberCollectionLabels(
	ctx: PluginContext,
	state: SyncState,
	labels: Record<string, string>,
): Promise<void> {
	const stored = state.collectionLabels ?? {};
	const same =
		Object.keys(labels).length === Object.keys(stored).length &&
		Object.entries(labels).every(([slug, label]) => stored[slug] === label);
	if (same || Object.keys(labels).length === 0) return;
	await writeState(ctx, { ...(await readState(ctx)), collectionLabels: labels });
}

export async function requestRebuild(ctx: PluginContext): Promise<SyncState> {
	const state = await readState(ctx);
	const next = { ...state, rebuild: true, index: undefined };
	await writeState(ctx, next);
	return next;
}

async function runOverviewPhase(
	ctx: PluginContext,
	provider: Provider,
	state: SyncState,
	now: Date,
	zone: string,
): Promise<SyncOutcome> {
	// The first overview reaches back as far as the provider stays exact, so
	// a fresh install starts with that much history (demo: ninety days). A
	// wide-pull provider's overview carries two days of
	// totals whatever the range, so it has nothing to gain from a wider
	// first window: its history arrives through the history pass.
	const exactDays = provider.capabilities.exactWindowDays;
	const backfill = !state.backfilled && !isWidePull(provider);
	const range = backfill ? backfillWindow(now, exactDays, zone) : syncWindow(now, OVERVIEW_DAYS_BACK, exactDays, zone);
	const res = await provider.overview(range);
	if (!res.ok) return await fail(ctx, state, "overview", res.error, now, res.problem);

	const today = localDay(now, zone);
	const { written, skipped } = await writeRollup(ctx, res.value, today, now);

	await writeState(ctx, {
		...state,
		phase: "paths",
		provider: provider.id,
		backfilled: true,
		lastSync: now.toISOString(),
		...clearedErrors(state, "overview"),
		// The widget shows the top paths under its weekly cards, so a
		// backfill's paths, which cover its whole window (demo: ninety days),
		// are not kept: the next overview reads the week. Referrers and
		// countries are shown with the day they start (`snapshotSince`).
		topPaths: backfill
			? undefined
			: res.value.topPaths.slice(0, 5).map((p) => ({
					path: p.path,
					pageviews: p.pageviews,
					visits: p.visits,
				})),
		referrers: res.value.referrers.slice(0, SNAPSHOT_ROWS).map((r) => ({ label: r.label, visits: r.visits })),
		countries: res.value.countries.slice(0, SNAPSHOT_ROWS).map((c) => ({ label: c.label, visits: c.visits })),
		snapshotSince: range.since,
		estimated: res.value.totals.sampleInterval > 1,
	});

	return { phase: "overview", ok: true, written, skipped };
}

/**
 * One small page of the catch-up walk.
 *
 * Calls: kv.get, settings.list, schema.listCollections, content.list, one
 * getPublicUrl per entry (three), entries.getMany, entries.putMany, kv.set
 * — ten. The cursor is saved with the state, after the page's rows.
 */
async function runIndexPhase(ctx: PluginContext, state: SyncState, now: Date, reserve = 0): Promise<SyncOutcome> {
	let result;
	try {
		// Each entry on the page costs a URL lookup, so a call held back for a
		// chained run comes off the page.
		result = await bootstrapIndex(ctx, state.index, now, INDEX_PAGE_SIZE - reserve);
	} catch (error) {
		// Recorded as done, so a repair walk that keeps failing still leaves
		// every other slot to the paths tick.
		const indexing = failure("indexingFailed", { detail: String(error) });
		return await fail(ctx, { ...state, lastWork: "index" }, "paths", indexing.error, now, indexing.problem);
	}

	const finished = result.complete;
	// A walk that starts from the beginning counts from zero.
	const walkMatched = (state.index ? (state.walkMatched ?? 0) : 0) + result.matched;
	await writeState(ctx, {
		...state,
		phase: "overview",
		lastWork: "index",
		lastSync: now.toISOString(),
		...clearedErrors(state, "paths"),
		index: result.next,
		indexComplete: Boolean(state.indexComplete) || finished,
		indexed: (state.indexed ?? 0) + result.indexed,
		walkMatched: finished ? undefined : walkMatched,
		...(finished && { matched: walkMatched }),
		...(Object.keys(result.labels).length > 0 && { collectionLabels: result.labels }),
		...(finished && { indexVersion: INDEX_VERSION, rebuild: undefined }),
	});

	return { phase: "paths", ok: true, written: result.indexed + result.repaired, skipped: result.skipped };
}

/**
 * One step of the pass that sums the older part of `views30`.
 *
 * Calls: kv.get, settings.list, then at most seven on storage (daily
 * pages, entries.getMany, entries.putMany), kv.set.
 */
async function runOlderPhase(
	ctx: PluginContext,
	state: SyncState,
	now: Date,
	today: Day,
	reserve = 0,
): Promise<SyncOutcome> {
	let result;
	try {
		result = await runOlderStep(ctx, state.older, today, OLDER_CALLS - reserve);
	} catch (error) {
		const summing = failure("summingFailed", { detail: String(error) });
		return await fail(ctx, { ...state, lastWork: "older" }, "paths", summing.error, now, summing.problem);
	}

	await writeState(ctx, {
		...state,
		phase: "overview",
		lastWork: "older",
		lastSync: now.toISOString(),
		...clearedErrors(state, "paths"),
		older: result.pass,
	});

	return { phase: "paths", ok: true, written: result.written, skipped: 0 };
}

/**
 * Read the read event into a fresh snapshot.
 *
 * Calls: kv.get, settings.list, two requests per depth (six at most, see
 * `MAX_READ_DEPTHS`), kv.set. It runs when the snapshot is due, at most
 * every six hours and once each local day, in a slot after a paths tick:
 * one paths slot in twelve at the default interval, and fewer as the
 * interval grows.
 */
async function runReadsPhase(
	ctx: PluginContext,
	provider: Provider,
	settings: AnalyticsSettings,
	state: SyncState,
	now: Date,
): Promise<SyncOutcome> {
	const spec = settings.reads!;
	const today = localDay(now, settings.timeZone);
	const ranges = readRanges(today);
	const res = await provider.readThrough!(spec, ranges);
	if (!res.ok) return await fail(ctx, { ...state, lastWork: "reads" }, "paths", res.error, now, res.problem);

	await writeState(ctx, {
		...state,
		phase: "overview",
		lastWork: "reads",
		lastSync: now.toISOString(),
		...clearedErrors(state, "paths"),
		reads: {
			at: now.toISOString(),
			...spec,
			since: ranges.entries.since,
			byEntry: res.value.byEntry,
			daily: res.value.daily,
			partial: res.value.partial,
		},
	});
	return { phase: "paths", ok: true, written: 0, skipped: 0 };
}

/**
 * One step of a wide-pull provider's history pass.
 *
 * Calls: kv.get, settings.list, then at most seven on the provider and on
 * storage (see `runHistoryStep`), kv.set.
 */
async function runHistoryPhase(
	ctx: PluginContext,
	provider: Provider,
	settings: AnalyticsSettings,
	state: SyncState,
	now: Date,
	reserve = 0,
): Promise<SyncOutcome> {
	// Recorded as done either way, and counted, so a pass that keeps failing
	// still leaves the paths tick its slots.
	const historyRun = state.lastWork === "history" ? (state.historyRun ?? 1) + 1 : 1;
	const failed = { ...state, lastWork: "history" as const, historyRun };
	let result;
	try {
		result = await runHistoryStep(
			ctx,
			provider,
			state.history,
			localDay(now, settings.timeZone),
			historyFloor(settings, now),
			HISTORY_CALLS - reserve,
			now,
		);
	} catch (error) {
		const reading = failure("historyFailed", { detail: String(error) });
		return await fail(ctx, failed, "paths", reading.error, now, reading.problem);
	}
	if (!result.ok) return await fail(ctx, failed, "paths", result.error, now, result.problem);

	await writeState(ctx, {
		...state,
		phase: "overview",
		lastWork: "history",
		historyRun,
		provider: provider.id,
		lastSync: now.toISOString(),
		...clearedErrors(state, "paths"),
		history: result.value.pass,
	});

	return { phase: "paths", ok: true, written: result.value.written, skipped: result.value.skipped };
}

async function runPathsPhase(
	ctx: PluginContext,
	provider: Provider,
	settings: AnalyticsSettings,
	state: SyncState,
	now: Date,
	reserve = 0,
): Promise<SyncOutcome> {
	const entries = entriesStore(ctx);
	const daily = dailyStore(ctx);
	if (!entries || !daily) {
		const { error, problem } = failure("storageUnavailable");
		return await fail(ctx, state, "paths", error, now, problem);
	}

	// A wide-pull provider is asked for today alone, which is one request.
	// The other days of the window are read from the store further down.
	const wide = isWidePull(provider);
	const recent = syncWindow(now, PATHS_WINDOW_DAYS, UNSAMPLED_WINDOW_DAYS, settings.timeZone);
	const range = wide ? { since: recent.until, until: recent.until } : recent;

	// Ordering by `path` rather than insertion order because `path` is a
	// declared index and storage rejects an orderBy on anything else. It
	// also makes the pass deterministic, which matters for a cursor that
	// survives across ticks.
	const page = await entries.query({
		orderBy: { path: "asc" },
		// A call held back for a chained run takes one of the three reads of
		// the window, which is twelve paths of the 36.
		limit: Math.min(settings.chunkSize, MAX_PATHS_PER_TICK - reserve * PATHS_PER_READ),
		...(state.cursor ? { cursor: state.cursor } : {}),
	});

	const live = page.items.map((item) => item.data).filter((row) => row.status !== "deleted");
	const paths = [...new Set(live.map((row) => row.path))];

	// The pass reads every stored entry anyway, so it counts the matched
	// ones on the way at no extra call. A pass that ends publishes its
	// count, and one that starts from the beginning counts from zero.
	const passMatched = (state.cursor ? (state.passMatched ?? 0) : 0) + live.filter(isPublished).length;
	const counted = (cursor: string | undefined): Partial<SyncState> =>
		cursor ? { passMatched } : { matched: passMatched, passMatched: undefined };

	if (paths.length === 0) {
		// Either no entries are indexed yet or the pass is complete; either
		// way the next tick starts a fresh pass from the beginning.
		await writeState(ctx, {
			...state,
			phase: "overview",
			lastWork: "paths",
			cursor: undefined,
			lastSync: now.toISOString(),
			...counted(undefined),
		});
		return { phase: "paths", ok: true, written: 0, skipped: 0, paths: 0 };
	}

	const res = await provider.paths(paths, range);
	if (!res.ok) return await fail(ctx, state, "paths", res.error, now, res.problem);

	const today = recent.until;
	const fetched = new Map<string, DailyRow>();
	for (const row of res.value) {
		fetched.set(dailyId(row.date, row.path), {
			date: row.date,
			path: row.path,
			pageviews: row.pageviews,
			visits: row.visits,
			sampleInterval: row.sampleInterval,
			fetchedAt: now.toISOString(),
		});
	}

	// Read before write. Without this the tick re-writes every row every
	// 15 minutes, which on D1's free plan is roughly 2.2x the daily budget
	// before the site's own writes are counted.
	//
	// For a wide-pull provider the same read also fetches the days it was
	// not asked for, so it covers every path on every day of the window.
	const ids = wide
		? enumerateDays(recent.since, recent.until).flatMap((day) => paths.map((path) => dailyId(day, path)))
		: [...fetched.keys()];
	const existing = new Map<string, DailyRow>();
	for (const slice of chunk(ids)) {
		for (const [id, row] of await daily.getMany(slice)) existing.set(id, row);
	}

	const toWrite: Array<{ id: string; data: DailyRow }> = [];
	let skipped = 0;
	for (const [id, row] of fetched) {
		const decision = decideWrite(existing.get(id), row, today);
		if (decision.action === "write") toWrite.push({ id, data: row });
		else skipped++;
	}
	if (toWrite.length > 0) await daily.putMany(toWrite);

	// views7 and the recent part of views30 are exactly the window just
	// fetched, so they need no second read and cannot drift from the rows
	// written above.
	const perPath = new Map<string, Array<{ date: Day; pageviews: number }>>();
	for (const row of res.value) {
		const rows = perPath.get(row.path) ?? [];
		rows.push(row);
		perPath.set(row.path, rows);
	}
	// A wide-pull provider's window is today from the response and the days
	// before it from the store, where the history pass and earlier ticks
	// left them.
	if (wide) {
		for (const row of existing.values()) {
			if (row.date === today) continue;
			const rows = perPath.get(row.path) ?? [];
			rows.push(row);
			perPath.set(row.path, rows);
		}
	}

	const settled = olderSettled(state.older, today);
	const entryUpdates: Array<{ id: string; data: EntryRow }> = [];
	for (const item of page.items) {
		const next = withRecent(item.data, recentViewsOf(perPath.get(item.data.path) ?? [], today), today, settled);
		if (next) entryUpdates.push({ id: item.id, data: next });
	}
	if (entryUpdates.length > 0) await entries.putMany(entryUpdates);

	await writeState(ctx, {
		...state,
		phase: "overview",
		lastWork: "paths",
		provider: provider.id,
		cursor: page.cursor,
		lastSync: now.toISOString(),
		...clearedErrors(state, "paths"),
		...counted(page.cursor),
	});

	return { phase: "paths", ok: true, written: toWrite.length, skipped, paths: paths.length };
}

/**
 * `reconcile` prunes. It does not re-read anything from the provider.
 *
 * The plan originally had it re-pull the full retention window to correct
 * drift. Measured against the live API, that would overwrite exact rows
 * with numbers quantized to multiples of ten and silently drop every day
 * too quiet to survive a 10 % sample. After seven days this store is the
 * only place the real numbers still exist, so the daily job's one duty is
 * to stop it growing without bound.
 */
export async function runReconcile(
	ctx: PluginContext,
	retentionDays: number,
	now: Date = new Date(),
	zone: string = DEFAULT_TIME_ZONE,
): Promise<{ deleted: number; more: boolean }> {
	const daily = dailyStore(ctx);
	if (!daily) return { deleted: 0, more: false };

	const cutoff = addDays(localDay(now, zone), -retentionDays);

	let deleted = 0;
	let more = true;
	for (let i = 0; more && i < PRUNE_BATCHES; i++) {
		// There is no delete-by-where, so pruning is query-then-delete in a
		// bounded loop rather than one statement. A page of `ID_BATCH` rows
		// is what one deleteMany can take.
		const page = await daily.query({ where: { date: { lt: cutoff } }, limit: ID_BATCH });
		if (page.items.length > 0) deleted += await daily.deleteMany(page.items.map((item) => item.id));
		more = page.hasMore;
	}

	return { deleted, more };
}

/**
 * No website ID configured: name the websites this key can actually see,
 * so the operator has an ID to copy instead of silence.
 */
async function suggestSite(
	ctx: PluginContext,
	provider: Provider,
	state: SyncState,
	now: Date,
	zone: string,
): Promise<SyncOutcome> {
	const today = localDay(now, zone);
	const range: DateRange = { since: addDays(today, -30), until: today };
	const res = await provider.discoverSites(range);

	const found = res.ok
		? res.value.length > 0
			? failure("noWebsiteIdSites", {
					sites: res.value
						.slice(0, 5)
						.map((s) => `${s.siteTag}${s.hosts[0] ? ` (${s.hosts[0]})` : ""}`)
						.join(", "),
				})
			: failure("noWebsiteIdNoList")
		: res;

	await writeState(ctx, {
		...state,
		lastError: found.error,
		lastProblem: found.problem,
		lastErrorAt: now.toISOString(),
		lastErrorPhase: undefined,
		sitesHint: found.error,
	});
	return { phase: state.phase, ok: false, error: found.error, problem: found.problem, written: 0, skipped: 0 };
}

async function writeRollup(ctx: PluginContext, overview: Overview, today: Day, now: Date) {
	const rollup = rollupStore(ctx);
	if (!rollup) return { written: 0, skipped: 0 };

	const incoming = new Map<string, RollupRow>();
	for (const row of overview.series) {
		incoming.set(row.date, {
			date: row.date,
			pageviews: row.pageviews,
			visits: row.visits,
			...engagementOf(row),
			sampleInterval: row.sampleInterval,
			fetchedAt: now.toISOString(),
		});
	}
	if (incoming.size === 0) return { written: 0, skipped: 0 };

	const existing = new Map<string, RollupRow>();
	for (const slice of chunk([...incoming.keys()])) {
		for (const [id, row] of await rollup.getMany(slice)) existing.set(id, row);
	}

	const toWrite: Array<{ id: string; data: RollupRow }> = [];
	let skipped = 0;
	for (const [id, row] of incoming) {
		const decision = decideWrite(existing.get(id), row, today);
		if (decision.action === "write") toWrite.push({ id, data: row });
		else skipped++;
	}
	if (toWrite.length > 0) await rollup.putMany(toWrite);
	return { written: toWrite.length, skipped };
}

/**
 * Clear the previous provider's numbers after a switch, in bounded batches.
 * Days keyed in another time zone are cleared the same way (see `runSync`).
 *
 * `rollup` and `daily` are emptied; `entries` keeps its rows, because the
 * path-to-entry index describes the site's content rather than anybody's
 * traffic, and only has its view counts reset. A large store takes several
 * ticks. Until the wipe completes, `state.provider` and `state.dayZone`
 * still name the old provider and zone, so every tick resumes it.
 *
 * Deleting is what lets frozen rows be rebuilt: nothing compares a fresh
 * day against a stored one that is gone. The state that follows has no
 * history pass and no overview, so the history pass reads the days again,
 * newest first, back to the retention limit.
 *
 * With a scheduler, a wipe that does not finish in one run keeps a call
 * back and spends it on the next chained run (`CATCH_UP_TASKS`), so a large
 * store is cleared a minute at a time rather than at the sync interval.
 */
async function runWipe(
	ctx: PluginContext,
	state: SyncState,
	target: ProviderId,
	zone: string,
	now: Date,
	catchUp?: string,
): Promise<SyncOutcome> {
	const chain = ctx.cron ? wipeChain(state, now, catchUp) : null;
	let calls = WIPE_CALLS - (chain ? 1 : 0);
	let finished = true;

	for (const store of [rollupStore(ctx), dailyStore(ctx)]) {
		if (!store) continue;
		let more = true;
		while (more && calls >= 2) {
			const page = await store.query({ limit: ID_BATCH });
			calls--;
			if (page.items.length > 0) {
				await store.deleteMany(page.items.map((item) => item.id));
				calls--;
			}
			more = page.hasMore;
		}
		if (more) {
			finished = false;
			break;
		}
	}

	let cursor = state.wipeCursor;
	const entries = entriesStore(ctx);
	if (entries && finished) {
		let more = true;
		while (more && calls >= 2) {
			const page = await entries.query({ orderBy: { path: "asc" }, limit: ID_BATCH, ...(cursor ? { cursor } : {}) });
			calls--;
			const reset = page.items
				.filter(
					(item) =>
						item.data.views7 !== 0 ||
						item.data.views30 !== 0 ||
						Boolean(item.data.recentViews) ||
						Boolean(item.data.olderViews) ||
						item.data.olderDay !== undefined,
				)
				.map((item) => ({
					id: item.id,
					data: { ...item.data, views7: 0, views30: 0, recentViews: 0, olderViews: 0, olderDay: undefined },
				}));
			if (reset.length > 0) {
				await entries.putMany(reset);
				calls--;
			}
			more = page.hasMore && Boolean(page.cursor);
			cursor = more ? page.cursor : undefined;
		}
		if (more) finished = false;
	}

	if (!finished) {
		await writeState(ctx, { ...state, wipeCursor: cursor, ...(chain && { chain }) });
		if (chain && ctx.cron) await ctx.cron.schedule(chain.next, { schedule: chain.at });
		return { phase: state.phase, ok: true, written: 0, skipped: 0 };
	}

	await writeState(ctx, {
		phase: "overview",
		provider: target,
		dayZone: zone,
		index: state.index,
		indexComplete: state.indexComplete,
		indexed: state.indexed,
		matched: state.matched,
		walkMatched: state.walkMatched,
		indexVersion: state.indexVersion,
		rebuild: state.rebuild,
		collectionLabels: state.collectionLabels,
	});
	return { phase: "overview", ok: true, written: 0, skipped: 0 };
}

/**
 * The chained run a wipe schedules, as `chainFor` decides it for a slot: a
 * chained run always continues, and any other run starts a chain only when
 * none is pending.
 */
function wipeChain(state: SyncState, now: Date, catchUp?: string): { next: string; at: string } | null {
	const at = new Date(now.getTime() + CATCH_UP_DELAY_MS).toISOString();
	if (catchUp) return { next: catchUp === CATCH_UP_TASKS[0] ? CATCH_UP_TASKS[1] : CATCH_UP_TASKS[0], at };
	const pending = state.chain && now.getTime() < Date.parse(state.chain.at) + CATCH_UP_PENDING_MS;
	if (pending) return null;
	return { next: state.chain?.next ?? CATCH_UP_TASKS[0], at };
}

async function fail(
	ctx: PluginContext,
	state: SyncState,
	phase: SyncState["phase"],
	error: string,
	now: Date,
	problem?: Problem,
): Promise<SyncOutcome> {
	// Keep the last good numbers. Stale and labelled beats blank.
	await writeState(ctx, {
		...state,
		lastError: error,
		lastProblem: problem,
		lastErrorAt: now.toISOString(),
		lastErrorPhase: phase,
	});
	return { phase, ok: false, error, ...(problem && { problem }), written: 0, skipped: 0 };
}

/** The error fields a successful `phase` resets, or none if another phase failed. */
function clearedErrors(state: SyncState, phase: SyncState["phase"]): Partial<SyncState> {
	if (state.lastErrorPhase && state.lastErrorPhase !== phase) return {};
	return { lastError: undefined, lastProblem: undefined, lastErrorAt: undefined, lastErrorPhase: undefined };
}

/** The state each context wrote last, so a run can tell what it left without reading it back. */
const lastWritten = new WeakMap<PluginContext, SyncState>();

async function writeState(ctx: PluginContext, state: SyncState): Promise<void> {
	await ctx.kv.set(STATE_KEY, state);
	lastWritten.set(ctx, state);
}
