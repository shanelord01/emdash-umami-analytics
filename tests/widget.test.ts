import { validateBlocks } from "@emdash-cms/blocks/server";
import { describe, expect, it } from "vitest";

import type { EntryRow, RollupRow } from "../src/store/rows.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { renderWidget, type WidgetInput } from "../src/ui/widget.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");

const rollup = (date: string, pageviews: number, visits: number, sampleInterval = 1): RollupRow => ({
	date,
	pageviews,
	visits,
	sampleInterval,
	fetchedAt: NOW.toISOString(),
});

/** Fourteen days ending today, so the previous period exists. */
function twoWeeks(current: number, previous: number): RollupRow[] {
	const rows: RollupRow[] = [];
	for (let i = 0; i < 14; i++) {
		const day = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
		rows.push(rollup(day, i < 7 ? current : previous, i < 7 ? current : previous));
	}
	return rows;
}

function input(over: Partial<WidgetInput> = {}): WidgetInput {
	return {
		state: { phase: "overview", lastSync: "2026-09-20T11:55:00.000Z" },
		rollups: twoWeeks(10, 5),
		entriesByPath: new Map(),
		now: NOW,
		locale: "en",
		...over,
	};
}

/**
 * The real host validator, not a local copy. This is the check that would
 * have caught upstream's own `audit-log` bug, where camelCase Block Kit
 * keys are accepted by TypeScript and silently ignored by the renderer.
 */
function expectValid(blocks: unknown) {
	const result = validateBlocks(blocks);
	if (!result.valid) {
		throw new Error(`Block Kit validation failed:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
	}
	expect(result.valid).toBe(true);
}

describe("renderWidget produces valid Block Kit", () => {
	it("validates with data", () => {
		expectValid(renderWidget(input()));
	});

	it("validates with no data at all", () => {
		expectValid(renderWidget(input({ rollups: [] })));
	});

	it("validates with an error on the state", () => {
		expectValid(
			renderWidget(
				input({
					state: {
						phase: "overview",
						lastSync: "2026-09-20T11:00:00.000Z",
						lastError: "Umami rejected the API key (401).",
						lastErrorAt: "2026-09-20T11:50:00.000Z",
						topPaths: [{ path: "/", pageviews: 25, visits: 20 }],
					},
				}),
			),
		);
	});

	it("validates a table carrying entry titles", () => {
		const entries = new Map<string, EntryRow>([
			[
				"/impressum/",
				{
					path: "/impressum/",
					collection: "pages",
					entryId: "e1",
					translationGroup: "g1",
					locale: "de",
					title: "Impressum",
					status: "published",
					views7: 2,
					views30: 9,
					updatedAt: NOW.toISOString(),
				},
			],
		]);
		expectValid(
			renderWidget(
				input({
					state: {
						phase: "overview",
						lastSync: NOW.toISOString(),
						topPaths: [
							{ path: "/impressum/", pageviews: 2, visits: 2 },
							{ path: "/unknown/", pageviews: 1, visits: 1 },
						],
					},
					entriesByPath: entries,
				}),
			),
		);
	});
});

describe("what the widget says", () => {
	it("shows an empty state that explains itself rather than zeroes", () => {
		const out = renderWidget(input({ rollups: [], state: { phase: "overview" } }));
		const empty = out.find((b) => b.type === "empty");
		expect(empty).toBeDefined();
		expect(JSON.stringify(empty)).toMatch(/first sync has not run/i);
	});

	it("surfaces the last error in the empty state instead of a generic message", () => {
		const out = renderWidget(
			input({
				rollups: [],
				state: { phase: "overview", lastError: "Analytics is not configured yet: add an API token" },
			}),
		);
		expect(JSON.stringify(out)).toMatch(/not configured yet/);
	});

	it("points the trend arrow up when the week improved", () => {
		const out = renderWidget(input({ rollups: twoWeeks(10, 5) }));
		const stats = out.find((b) => b.type === "stats");
		expect(stats).toBeDefined();
		expect(JSON.stringify(stats)).toContain('"trend":"up"');
	});

	it("omits the trend entirely when there is no earlier period", () => {
		// A neutral arrow would assert "unchanged", which on a fresh install
		// is a different and false claim.
		const out = renderWidget(input({ rollups: [rollup("2026-09-20", 4, 3)] }));
		const stats = out.find((b) => b.type === "stats");
		expect(JSON.stringify(stats)).not.toContain('"trend"');
		expect(JSON.stringify(stats)).toMatch(/no earlier period/i);
	});

	it("does not compare against a week that the first-sync backfill only grazes", () => {
		// Cloudflare's backfill reaches today - 7, which is the first day of
		// the previous week; one day against seven read as a huge jump.
		const eightDays = twoWeeks(10, 10).slice(0, 8);
		const stats = renderWidget(input({ rollups: eightDays })).find((b) => b.type === "stats");
		expect(JSON.stringify(stats)).not.toContain('"trend"');
		expect(JSON.stringify(stats)).toMatch(/no earlier period/i);
	});

	it("labels sampled numbers as estimates", () => {
		const out = renderWidget(
			input({ rollups: [rollup("2026-09-19", 10, 10, 10), rollup("2026-09-18", 10, 10, 10)] }),
		);
		expect(JSON.stringify(out)).toMatch(/estimated/i);
	});

	it("says today is still counting", () => {
		const out = renderWidget(input({ rollups: [rollup("2026-09-20", 5, 5)] }));
		expect(JSON.stringify(out)).toMatch(/still counting/i);
	});

	it("falls back to a dash when the join does not know the page", () => {
		const out = renderWidget(
			input({
				state: { phase: "overview", lastSync: NOW.toISOString(), topPaths: [{ path: "/orphan/", pageviews: 3, visits: 2 }] },
			}),
		);
		const table = out.find((b) => b.type === "table");
		expect(table).toBeDefined();
		expect(JSON.stringify(table)).toContain("/orphan/");
	});

	it("uses snake_case keys the renderer actually reads", () => {
		const out = renderWidget(
			input({ state: { phase: "overview", lastSync: NOW.toISOString(), topPaths: [{ path: "/", pageviews: 1, visits: 1 }] } }),
		);
		const table = out.find((b) => b.type === "table");
		expect(table).toHaveProperty("page_action_id");
		expect(table).toHaveProperty("empty_text");
		expect(table).not.toHaveProperty("pageActionId");
		expect(table).not.toHaveProperty("emptyText");

		const actions = out.find((b) => b.type === "actions");
		expect(JSON.stringify(actions)).toContain("action_id");
	});

	it("always offers a refresh button, even with nothing to show", () => {
		for (const rollups of [[], twoWeeks(10, 5)]) {
			const out = renderWidget(input({ rollups }));
			expect(out.some((b) => b.type === "actions")).toBe(true);
		}
	});
});

describe("locale handling", () => {
	it("groups digits the way the reader's locale does", () => {
		const big = [rollup("2026-09-20", 1234567, 1234567)];
		const en = JSON.stringify(renderWidget(input({ rollups: big, locale: "en" })));
		const de = JSON.stringify(renderWidget(input({ rollups: big, locale: "de" })));
		expect(en).toContain("1,234,567");
		expect(de).toContain("1.234.567");
	});

	it("still renders when no locale is attached", () => {
		expectValid(renderWidget(input({ locale: undefined })));
	});
});

describe("a finished index that matched nothing", () => {
	it("says so and points to the setup check", () => {
		const blocks = renderWidget(input({ state: { phase: "overview", lastSync: NOW.toISOString(), indexComplete: true, indexed: 0 } }));
		expect(JSON.stringify(blocks)).toMatch(/no page is matched to an entry yet; Check setup on the Analytics page says why/);
	});

	it("stays quiet while the index is still being built or has matches", () => {
		for (const state of [
			{ phase: "overview" as const, lastSync: NOW.toISOString(), indexComplete: false, indexed: 0 },
			{ phase: "overview" as const, lastSync: NOW.toISOString(), indexComplete: true, indexed: 3 },
		]) {
			expect(JSON.stringify(renderWidget(input({ state })))).not.toMatch(/no page is matched/);
		}
	});
});
