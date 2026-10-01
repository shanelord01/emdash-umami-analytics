/**
 * Catching up on content that existed before the plugin did.
 *
 * Forward maintenance through the content hooks only learns about entries
 * that get saved. On any real site most entries were published long ago,
 * so without a catch-up pass the join stays empty and the per-entry
 * numbers — the whole point of this plugin — never appear until somebody
 * edits something.
 *
 * Two things keep this cheap:
 *
 * - **It rides on the sync tick** rather than on `plugin:activate`, which
 *   is dispatched only by the admin Enable endpoint and never fires for a
 *   site that registers the plugin through `plugins: []`.
 * - **It walks a few entries per tick.** `getPublicUrl()` is one bridge
 *   call per entry and a sandboxed invocation gets ten in total, so the
 *   page size is deliberately tiny and the pass spreads over many ticks.
 *
 * The caller keeps the cursor in its sync state and saves it only after
 * this page's rows are written, so a tick that dies repeats its page
 * instead of skipping it. Repeating is harmless: a row is written only
 * when it is new or its entry changed.
 *
 * The same walk repairs the index. A row whose entry has changed in a way
 * the content hooks did not report (or that an older build stored wrongly,
 * such as a translation filed under its own group) is rewritten with the
 * entry's current fields and its view counts kept.
 *
 * Unlike `indexEntry`, this reads the title out of the listing it already
 * has instead of asking for the schema and the entry again. Four calls per
 * entry would be wrong here; one is right.
 */

import type { PluginContext } from "emdash/plugin";

import { entriesStore } from "../store/access.js";
import type { EntryRow } from "../store/rows.js";
import { normalizePath } from "./paths.js";

/**
 * The entry type `ctx.content.list()` hands back.
 *
 * Derived rather than imported: `emdash/plugin` does not export it, and
 * the identically-named `ContentItem` on the package root is the
 * *database row* type (`authorId`, `liveRevisionId`, …), which does not
 * match. Deriving from the context is exact by construction and cannot
 * drift from the runtime shape.
 */
type PluginContentItem = Awaited<
	ReturnType<NonNullable<PluginContext["content"]>["list"]>
>["items"][number];

/**
 * Bumped when a walk starts storing something earlier walks did not, or
 * stored wrongly. A site whose last completed walk has a lower version
 * gets walked again (see `indexOutdated`).
 *
 * 2: the real translation group, `publishedAt`, the collection's title field.
 */
export const INDEX_VERSION = 2;

/**
 * Entries visited per tick.
 *
 * A tick spends seven bridge calls around them — state read, settings
 * read, collection list, content list, the existence check, the write,
 * the state write — and one `getPublicUrl()` per entry. Three is what
 * fits in ten.
 */
export const INDEX_PAGE_SIZE = 3;

/** Where the walk stands: a collection, and the listing cursor inside it. */
export interface IndexCursor {
	collection: string;
	cursor?: string;
}

export interface BootstrapResult {
	/** Where the next tick continues, or undefined once the pass is complete. */
	next: IndexCursor | undefined;
	/** Rows added. */
	indexed: number;
	/** Existing rows rewritten because their entry changed. */
	repaired: number;
	/** Display labels of the routable collections, by slug; empty when none were listed. */
	labels: Record<string, string>;
	skipped: number;
	complete: boolean;
}

/**
 * Index one small page of pre-existing content, starting at `from`.
 *
 * Collections are walked in slug order, so a collection that disappears
 * mid-pass is stepped over rather than wedging the walk.
 */
export async function bootstrapIndex(
	ctx: PluginContext,
	from: IndexCursor | undefined,
	now: Date,
	pageSize: number = INDEX_PAGE_SIZE,
): Promise<BootstrapResult> {
	const done: BootstrapResult = { next: undefined, indexed: 0, repaired: 0, labels: {}, skipped: 0, complete: true };
	const entries = entriesStore(ctx);
	if (!entries || !ctx.content?.getPublicUrl || !ctx.schema) return done;

	// Non-routable and hidden collections are skipped rather than guessed
	// at: an entry with no URL pattern has no page to attribute traffic to.
	const routable = (await ctx.schema.listCollections()).filter((c) => c.routable && !c.hidden);
	const collections = routable.map((c) => c.slug).sort();
	const labels = Object.fromEntries(routable.map((c) => [c.slug, c.label || c.slug]));

	const at = from ? collections.findIndex((slug) => slug >= from.collection) : 0;
	const collection = collections[at];
	if (collection === undefined) return { ...done, labels };
	const titleField = routable.find((c) => c.slug === collection)?.titleField ?? null;

	const cursor = collection === from?.collection ? from.cursor : undefined;
	// Drafts have no public URL, so listing them would spend a
	// `getPublicUrl()` each to learn nothing.
	const page = await ctx.content.list(collection, {
		limit: pageSize,
		where: { status: "published" },
		...(cursor ? { cursor } : {}),
	});

	const rows: Array<{ id: string; data: EntryRow }> = [];
	let skipped = 0;

	for (const item of page.items) {
		const id = idOf(item);
		if (!id) {
			skipped++;
			continue;
		}
		const url = await ctx.content.getPublicUrl(collection, id);
		if (!url) {
			// Non-routable, no slug, or no site URL configured. A normal
			// answer, not a failure.
			skipped++;
			continue;
		}
		const path = normalizePath(url, ctx.site.trailingSlash);
		const publishedAt = publishedAtOf(item);
		rows.push({
			id: path,
			data: {
				path,
				collection,
				entryId: id,
				translationGroup: translationGroupOf(item) ?? id,
				locale: localeOf(item) ?? ctx.site.locale,
				title: titleOf(item, titleField),
				status: "published",
				...(publishedAt && { publishedAt }),
				views7: 0,
				views30: 0,
				updatedAt: now.toISOString(),
			},
		});
	}

	const { writes, added } = rows.length > 0 ? await changedRows(entries, rows) : { writes: [], added: 0 };
	if (writes.length > 0) await entries.putMany(writes);

	const following = collections[at + 1];
	const next = page.cursor
		? { collection, cursor: page.cursor }
		: following !== undefined
			? { collection: following }
			: undefined;

	return {
		next,
		indexed: added,
		repaired: writes.length - added,
		labels,
		skipped: skipped + (rows.length - writes.length),
		complete: next === undefined,
	};
}

/**
 * The rows that need writing: new ones, and existing ones whose entry
 * changed. An existing row keeps its view counts, which describe traffic
 * the walk knows nothing about, and keeps its title: the content hooks
 * rewrite it on every save, so the walk only fills one that is missing.
 */
async function changedRows(
	entries: NonNullable<ReturnType<typeof entriesStore>>,
	rows: Array<{ id: string; data: EntryRow }>,
): Promise<{ writes: Array<{ id: string; data: EntryRow }>; added: number }> {
	const existing = await entries.getMany(rows.map((r) => r.id));
	const writes: Array<{ id: string; data: EntryRow }> = [];
	let added = 0;
	for (const row of rows) {
		const stored = existing.get(row.id);
		if (!stored) {
			writes.push(row);
			added++;
			continue;
		}
		const merged: EntryRow = {
			...stored,
			collection: row.data.collection,
			entryId: row.data.entryId,
			translationGroup: row.data.translationGroup,
			locale: row.data.locale,
			title: stored.title || row.data.title,
			status: row.data.status,
			...((row.data.publishedAt ?? stored.publishedAt) && { publishedAt: row.data.publishedAt ?? stored.publishedAt }),
		};
		if (DESCRIPTIVE.some((key) => merged[key] !== stored[key])) {
			writes.push({ id: row.id, data: { ...merged, updatedAt: row.data.updatedAt } });
		}
	}
	return { writes, added };
}

/** The fields a walk may correct. Everything else on a row is the sync's. */
const DESCRIPTIVE = ["collection", "entryId", "translationGroup", "locale", "title", "status", "publishedAt"] as const;

function idOf(item: PluginContentItem): string | null {
	const record = item as unknown as Record<string, unknown>;
	return typeof record.id === "string" ? record.id : null;
}

/**
 * The entry's display title: the collection's declared title field first,
 * then the usual names.
 */
function titleOf(item: PluginContentItem, titleField: string | null): string {
	const record = item as unknown as Record<string, unknown>;
	const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : null;
	const keys = [titleField, "title", "name", "heading"].filter((k): k is string => Boolean(k));
	for (const key of keys) {
		for (const source of [record, data]) {
			const value = source?.[key];
			if (typeof value === "string" && value) return value;
		}
	}
	return "";
}

function publishedAtOf(item: PluginContentItem): string | undefined {
	const record = item as unknown as Record<string, unknown>;
	const value = record.publishedAt ?? record.published_at;
	return typeof value === "string" && value ? value : undefined;
}

function localeOf(item: PluginContentItem): string | null {
	const record = item as unknown as Record<string, unknown>;
	return typeof record.locale === "string" ? record.locale : null;
}

function translationGroupOf(item: PluginContentItem): string | null {
	const record = item as unknown as Record<string, unknown>;
	return typeof record.translationGroup === "string" && record.translationGroup ? record.translationGroup : null;
}
