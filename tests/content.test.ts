import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { describe, expect, it } from "vitest";

import type { EntryRow } from "../src/store/rows.js";
import {
	combine,
	CONTENT_PATH,
	DEFAULT_VIEW,
	parseContentInput,
	renderContent,
	REBUILD_ACTION,
	TABLE_ACTION,
	viewAction,
	type ContentInput,
	type ContentView,
} from "../src/ui/content.js";
import { PAGE_PATH } from "../src/ui/page.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");

const row = (path: string, over: Partial<EntryRow> = {}): EntryRow => ({
	path,
	collection: "posts",
	entryId: `id${path}`,
	translationGroup: `id${path}`,
	locale: "en",
	title: path,
	status: "published",
	views7: 0,
	views30: 0,
	updatedAt: NOW.toISOString(),
	...over,
});

function input(over: Partial<ContentInput> = {}): ContentInput {
	return {
		view: DEFAULT_VIEW,
		state: { phase: "overview", provider: "umami", indexComplete: true, indexVersion: 2, lastSync: NOW.toISOString() },
		collections: [
			{ slug: "pages", label: "Pages" },
			{ slug: "posts", label: "Posts" },
		],
		rows: [
			{ title: "Hello", collection: "posts", locale: "en", path: "/blog/hello/", views7: 5, views30: 20, allLanguages: 32 },
			{ title: "", collection: "pages", locale: "en", path: "/quiet/", views7: 0, views30: 0, allLanguages: 0 },
		],
		multilingual: false,
		now: NOW,
		locale: "en",
		...over,
	};
}

function expectValid(blocks: unknown) {
	const result = validateBlockResponse({ blocks }, { pluginPagePaths: [PAGE_PATH, CONTENT_PATH] });
	if (!result.valid) {
		throw new Error(`Block Kit validation failed:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
	}
}

type AnyBlock = Record<string, unknown> & { type: string };

function find(blocks: unknown[], type: string): AnyBlock[] {
	const out: AnyBlock[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			const record = value as AnyBlock;
			if (record.type === type) out.push(record);
			Object.values(record).forEach(walk);
		}
	};
	walk(blocks);
	return out;
}

const texts = (blocks: unknown[]) => find(blocks, "context").map((b) => String(b.text));

describe("the view travels in the action ids", () => {
	const view: ContentView = { collection: "posts", sort: "views7", dir: "asc", mode: "combined", offset: 0 };

	it("round-trips through a view button", () => {
		expect(parseContentInput({ type: "block_action", action_id: viewAction(view) })).toEqual({ view, rebuild: false });
	});

	it("takes a header click's sort and starts from the top", () => {
		const table = find(renderContent(input({ view: { ...view, offset: 50, cursor: "c1" } })), "table")[0]!;
		const parsed = parseContentInput({
			type: "block_action",
			action_id: table.page_action_id,
			value: { sort: { key: "views30", dir: "desc" } },
		});
		expect(parsed.view).toEqual({ ...view, sort: "views30", dir: "desc", offset: 0 });
	});

	it("keeps the sort from the id when Load more sends none", () => {
		const table = find(renderContent(input({ view, nextCursor: "50~abc" })), "table")[0]!;
		expect(table.next_cursor).toBe("50~abc");
		const parsed = parseContentInput({
			type: "block_action",
			action_id: table.page_action_id,
			value: { cursor: table.next_cursor, sort: null },
		});
		expect(parsed.view).toEqual({ ...view, offset: 50, cursor: "abc" });
	});

	it("asks for a rebuild without losing the view", () => {
		const blocks = renderContent(input({ view }));
		const rebuild = find(blocks, "button").find((b) => String(b.action_id).startsWith(REBUILD_ACTION))!;
		expect(parseContentInput({ type: "block_action", action_id: rebuild.action_id })).toEqual({ view, rebuild: true });
	});

	it("falls back to the default view on anything it does not know", () => {
		expect(parseContentInput({ type: "page_load", page: CONTENT_PATH }).view).toEqual(DEFAULT_VIEW);
		expect(parseContentInput({ type: "block_action", action_id: `${TABLE_ACTION}|%zz|nope` }).view).toMatchObject({
			collection: null,
			sort: "views30",
		});
		expect(parseContentInput({ type: "block_action", action_id: `${VIEW_ACTION_ALIAS}|x` }).view).toEqual(DEFAULT_VIEW);
	});
});

const VIEW_ACTION_ALIAS = "analytics:something-else";

describe("renderContent", () => {
	it("renders valid blocks with every entry, the unviewed ones included", () => {
		const blocks = renderContent(input());
		expectValid(blocks);
		const [table] = find(blocks, "table");
		expect((table!.rows as Array<Record<string, unknown>>).map((r) => r.path)).toEqual(["/blog/hello/", "/quiet/"]);
		expect((table!.rows as Array<Record<string, unknown>>)[1]).toMatchObject({ entry: "—", views30: 0 });
	});

	it("shows languages and translation totals only on a multilingual site", () => {
		const keys = (i: ContentInput) =>
			(find(renderContent(i), "table")[0]!.columns as Array<{ key: string }>).map((c) => c.key);
		expect(keys(input())).not.toContain("allLanguages");
		expect(keys(input({ multilingual: true }))).toEqual(expect.arrayContaining(["language", "allLanguages"]));
		const modes = find(renderContent(input({ multilingual: true })), "button").map((b) => b.label);
		expect(modes).toEqual(expect.arrayContaining(["Each language", "Languages combined"]));
	});

	it("hides the collection column once a collection is chosen", () => {
		const columns = find(renderContent(input({ view: { ...DEFAULT_VIEW, collection: "posts" } })), "table")[0]!
			.columns as Array<{ key: string }>;
		expect(columns.map((c) => c.key)).not.toContain("collection");
	});

	it("marks the chosen collection", () => {
		const buttons = find(renderContent(input({ view: { ...DEFAULT_VIEW, collection: "posts" } })), "actions")[0]!
			.elements as Array<{ label: string; style: string }>;
		expect(buttons.map((b) => [b.label, b.style])).toEqual([
			["All", "secondary"],
			["Pages", "secondary"],
			["Posts", "primary"],
		]);
	});

	it("says where 30-day figures start when the store is younger than 30 days", () => {
		expect(texts(renderContent(input({ historySince: "2026-09-16" }))).join(" ")).toContain("Figures count from Sep 16, 2026");
		expect(texts(renderContent(input({ historySince: "2026-08-01" }))).join(" ")).not.toContain("Figures count from");
	});

	it("labels a column by the day its figures start when the store does not reach back its whole window", () => {
		const labels = (since: string) =>
			Object.fromEntries(
				(find(renderContent(input({ historySince: since })), "table")[0]!.columns as Array<{ key: string; label: string }>).map(
					(c) => [c.key, c.label],
				),
			);
		// Today is 24 September: the 30-day window starts on the 26th of August, the 7-day one on the 18th of September.
		expect(labels("2026-09-16")).toMatchObject({ views7: "7 days", views30: "Since Sep 16, 2026" });
		expect(labels("2026-09-20")).toMatchObject({ views7: "Since Sep 20, 2026", views30: "Since Sep 20, 2026" });
		expect(labels("2026-08-26")).toMatchObject({ views7: "7 days", views30: "30 days" });
		// The sort line no longer says "last 30 days" for a shorter history.
		expect(texts(renderContent(input({ historySince: "2026-09-16" })))[0]).toMatch(/^Most viewed first\. /);
	});

	it("gives First page an id apart from the button of the current mode", () => {
		const blocks = renderContent(input({ multilingual: true, view: { ...DEFAULT_VIEW, offset: 50, cursor: "c" } }));
		for (const group of find(blocks, "actions")) {
			const ids = (group.elements as Array<{ action_id?: string }>).map((e) => e.action_id).filter(Boolean);
			expect(new Set(ids).size).toBe(ids.length);
		}
		const first = find(blocks, "button").find((b) => b.label === "First page")!;
		expect(parseContentInput({ type: "block_action", action_id: first.action_id })).toMatchObject({
			view: { offset: 0 },
			rebuild: false,
		});
	});

	it("says which rows a later page shows, and offers the first page", () => {
		const blocks = renderContent(input({ view: { ...DEFAULT_VIEW, offset: 50, cursor: "c" } }));
		expect(texts(blocks).join(" ")).toContain("Entries 51 to 52.");
		expect(find(blocks, "button").map((b) => b.label)).toContain("First page");
	});

	it("explains an empty index instead of showing an empty table", () => {
		const building = renderContent(input({ rows: [], state: { phase: "overview", indexComplete: false } }));
		expectValid(building);
		expect(find(building, "empty")[0]).toMatchObject({ title: "No entries yet" });
		expect(find(building, "empty")[0]!.description).toContain("still being built");

		const noUrls = renderContent(input({ rows: [] }));
		expect(find(noUrls, "empty")[0]!.description).toContain("site URL");
	});

	it("writes publish dates in the reader's language", () => {
		const blocks = renderContent(
			input({
				locale: "de",
				rows: [{ title: "Hallo", collection: "posts", locale: "de", path: "/", views7: 1, views30: 1, publishedAt: "2026-09-18T08:00:00.000Z" }],
			}),
		);
		expect((find(blocks, "table")[0]!.rows as Array<Record<string, unknown>>)[0]!.published).toBe("18.09.2026");
	});

	it("links back to the overview", () => {
		const links = find(renderContent(input()), "link");
		expect(links.map((l) => l.target)).toContainEqual({ kind: "plugin-page", path: PAGE_PATH });
	});
});

describe("combine", () => {
	const view: ContentView = { ...DEFAULT_VIEW, mode: "combined" };

	it("adds up translations and sorts by the group total", () => {
		const rows = [
			row("/de/a/", { locale: "de", translationGroup: "a", views30: 30, views7: 3 }),
			row("/en/a/", { locale: "en", translationGroup: "a", views30: 12, views7: 1 }),
			row("/de/b/", { locale: "de", translationGroup: "b", views30: 35, views7: 9 }),
		];
		const out = combine(rows, view, "de");
		expect(out.map((r) => [r.path, r.views30, r.views7])).toEqual([
			["/de/a/", 42, 4],
			["/de/b/", 35, 9],
		]);
		expect(out[0]!.byLanguage).toBe("de 30 · en 12");
	});

	it("names a group after its original, whatever the site locale says", () => {
		// As on eisbachcode.de: German originals, English translations, and a
		// site locale that does not read "de".
		const rows = [
			row("/en/", { locale: "en", entryId: "t", translationGroup: "o", title: "Home", views30: 50 }),
			row("/", { locale: "de", entryId: "o", translationGroup: "o", title: "Startseite", views30: 1 }),
		];
		expect(combine(rows, view, "en")[0]).toMatchObject({ title: "Startseite", path: "/" });
	});

	it("falls back to the site-locale version, then the most viewed, when the original is not among the rows", () => {
		const rows = [
			row("/en/a/", { locale: "en", entryId: "x", translationGroup: "a", title: "Hello", views30: 50 }),
			row("/de/a/", { locale: "de", entryId: "y", translationGroup: "a", title: "Hallo", views30: 1 }),
		];
		expect(combine(rows, view, "de")[0]).toMatchObject({ title: "Hallo" });
		expect(combine(rows, view, "fr")[0]).toMatchObject({ title: "Hello" });
	});

	it("sorts ascending when asked, so groups nobody reads come first", () => {
		const rows = [row("/a/", { views30: 5 }), row("/b/", { views30: 0 })];
		expect(combine(rows, { ...view, dir: "asc" }, "en").map((r) => r.path)).toEqual(["/b/", "/a/"]);
	});
});
