/**
 * The entry editor's Views panel: this entry's 7- and 30-day views, and
 * its translations'.
 *
 * It puts the numbers where editors work, which the dashboard and the
 * analytics pages cannot. The host loads it only when opened and lets in
 * only people who may edit the entry, so authors see their own entries'
 * numbers without the `plugins:read` the analytics pages need.
 *
 * Storage only, like the per-entry page: two indexed queries, by entry id
 * and by translation group, and the oldest stored day. The 30-day figure
 * is a sum of stored days, so while the store does not reach back 30 days
 * the panel names the day it starts, as the per-entry page does.
 */

import type { PluginContext } from "emdash/plugin";

import { langOf, t, type Lang } from "../i18n.js";
import { dailyStore, entriesStore, oldestDay, BIND_LIMIT } from "../store/access.js";
import { isPublished, type EntryRow } from "../store/rows.js";
import { readsFor, type ReadSnapshot } from "../sync/reads.js";
import type { SyncState } from "../sync/scheduler.js";
import type { Day } from "../sync/window.js";
import { actions, context, empty, link, meter, stats, table, type AnalyticsBlock } from "./blocks.js";
import { CONTENT_PATH, storedSince } from "./content.js";
import { formatCount, formatDay } from "./format.js";
import { statusLine } from "./status.js";

export const PANEL_ID = "views";

export interface PanelInput {
	/** The entry's row at the path it is published under, or its latest row. */
	current: EntryRow | null;
	/** Published translations in the entry's group, the entry included. */
	members: EntryRow[];
	/** The oldest stored day, when the store has any. */
	historySince?: Day;
	state: SyncState;
	now: Date;
	locale?: string;
}

export async function loadPanel(
	ctx: PluginContext,
	entryId: string | null,
	state: SyncState,
	now: Date,
	locale?: string,
): Promise<PanelInput> {
	const entries = entriesStore(ctx);
	const base = { state, now, locale };
	if (!entries || !entryId) return { ...base, current: null, members: [] };

	const mine = (await entries.query({ where: { entryId }, limit: BIND_LIMIT })).items.map((item) => item.data);
	const current = mine.find(isPublished) ?? latest(mine);
	if (!current) return { ...base, current: null, members: [] };

	const [group, historySince] = await Promise.all([
		entries.query({ where: { translationGroup: current.translationGroup }, limit: BIND_LIMIT }),
		oldestDay(dailyStore(ctx)),
	]);
	const members = group.items.map((item) => item.data).filter(isPublished);
	return {
		...base,
		current,
		members: members.length > 0 ? members : [current],
		...(historySince && { historySince }),
	};
}

export function renderPanel(input: PanelInput): AnalyticsBlock[] {
	const { current, members, state, now } = input;
	const lang = langOf(input.locale);
	const more = actions([link(t(lang, "perEntry"), { kind: "plugin-page", path: CONTENT_PATH }, { appearance: "secondary" })]);

	if (!current) {
		return [empty({ title: t(lang, "panelNoPage"), description: t(lang, "panelNoPageDetail") }), more];
	}

	const out: AnalyticsBlock[] = [];
	const translated = members.length > 1;
	// Two cards, not three: the editor sidebar is narrow, a third card is
	// clipped, and the host's drag handle sits on the last one. The
	// translations' total goes in the context line instead.
	const since7 = storedSince(input, 7);
	const since30 = storedSince(input, 30);
	const cardLabel = (days: number, since: Day | null) =>
		since ? t(lang, "pageviewsSince", { date: formatDay(since, lang) }) : t(lang, "pageviewsLastDays", { days });
	out.push(
		stats([
			{ label: cardLabel(7, since7), value: formatCount(current.views7, lang) },
			{ label: cardLabel(30, since30), value: formatCount(current.views30, lang) },
		]),
	);

	out.push(...readMeters(state.reads, current, lang));

	if (translated) {
		out.push(
			table({
				blockId: "analytics:panel:languages",
				pageActionId: "analytics:panel:languages:page",
				columns: [
					{ key: "language", label: t(lang, "colLanguage"), format: "badge" },
					{ key: "path", label: t(lang, "colPath"), format: "code" },
					{ key: "views7", label: columnLabel(lang, "col7Days", since7), format: "number" },
					{ key: "views30", label: columnLabel(lang, "col30Days", since30), format: "number" },
				],
				rows: [...members]
					.sort((a, b) => b.views30 - a.views30 || a.locale.localeCompare(b.locale))
					.map((row) => ({ language: row.locale, path: row.path, views7: row.views7, views30: row.views30 })),
			}),
		);
	}

	const notes = [
		...(translated
			? [
					since30
						? t(lang, "panelAllLanguagesSince", { count: formatCount(sum(members), lang), date: formatDay(since30, lang) })
						: t(lang, "panelAllLanguages", { count: formatCount(sum(members), lang) }),
				]
			: []),
		current.status === "published" ? t(lang, "panelCountedAt", { path: current.path }) : t(lang, "panelNotPublished"),
		statusLine(state, now, lang, {}),
	].filter(Boolean);
	out.push(context(notes.join(" · ")));
	out.push(more);
	return out;
}

/**
 * One meter per depth: the entry's reads to that depth against its page
 * views over the same 30 days. The bar fills as readers get further, so a
 * short fill on the last depth is a post people leave early. Nothing while
 * read-through is off, or when the snapshot has no reads for the entry.
 */
function readMeters(reads: ReadSnapshot | undefined, entry: EntryRow, lang: Lang): AnalyticsBlock[] {
	const counts = readsFor(reads, entry.path);
	if (!reads || !counts) return [];
	const views = Math.max(entry.views30, ...counts);
	return reads.depths.map((depth, i) =>
		meter({
			label: t(lang, "panelReadTo", { depth }),
			value: counts[i] ?? 0,
			max: Math.max(views, 1),
			customValue: t(lang, "panelReadOf", {
				reads: formatCount(counts[i] ?? 0, lang),
				views: formatCount(entry.views30, lang),
			}),
		}),
	);
}

/** A window column's heading, or "Since Oct 2, 2026" while the stored history is shorter. */
function columnLabel(lang: Lang, key: "col7Days" | "col30Days", since: Day | null): string {
	return since ? t(lang, "colSince", { date: formatDay(since, lang) }) : t(lang, key);
}

function sum(rows: EntryRow[]): number {
	return rows.reduce((total, row) => total + row.views30, 0);
}

/** The most recently written row: where the entry was last published. */
function latest(rows: EntryRow[]): EntryRow | undefined {
	return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
