import { validateBlocks } from "@emdash-cms/blocks/server";
import { describe, expect, it } from "vitest";

import { engagementByDay, engagementOver } from "../src/store/engagement.js";
import type { RollupRow } from "../src/store/rows.js";
import type { ReadSnapshot } from "../src/sync/reads.js";
import { addDays } from "../src/sync/window.js";
import { engagementSection, engagementStats, readsChart } from "../src/ui/engagement.js";
import { formatDay, formatDuration } from "../src/ui/format.js";
import { renderWidget } from "../src/ui/widget.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const TODAY = "2026-09-30";

/**
 * Days shaped like the owner's 30 days: 980 visits, 755 bounces, 82 s on
 * average and 2.07 page views per visit, spread evenly; the 30 days
 * before them at 87.5 %, 25 s and 1.21.
 */
function owner(): RollupRow[] {
	const rows: RollupRow[] = [];
	for (let i = 0; i < 60; i++) {
		const recent = i < 30;
		const visits = recent ? 980 / 30 : 960 / 30;
		rows.push({
			date: addDays(TODAY, -i),
			visits,
			pageviews: visits * (recent ? 2.07 : 1.21),
			bounces: visits * (recent ? 755 / 980 : 0.875),
			totaltime: visits * (recent ? 82 : 25),
			sampleInterval: 1,
			fetchedAt: NOW.toISOString(),
		});
	}
	return rows;
}

const text = (blocks: unknown) => JSON.stringify(blocks);

type ChartConfig = { y_axis_name?: string; series: Array<{ name: string; data: Array<[number, number]> }> };

/** Every chart in the blocks, columns included, by block id. */
function chartsIn(blocks: unknown): Map<string, ChartConfig> {
	const found = new Map<string, ChartConfig>();
	const walk = (node: unknown) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record.type === "chart" && typeof record.block_id === "string") found.set(record.block_id, record.config as ChartConfig);
		Object.values(record).forEach(walk);
	};
	walk(blocks);
	return found;
}

describe("engagement from stored days", () => {
	it("adds up bounces, visit time and page views over visits", () => {
		const e = engagementOver(owner().slice(0, 30))!;
		expect(e.bounceRate).toBeCloseTo(755 / 980, 6);
		expect(e.averageVisit).toBeCloseTo(82, 6);
		expect(e.pagesPerVisit).toBeCloseTo(2.07, 6);
		expect(e.since).toBe(addDays(TODAY, -29));
	});

	it("leaves out days stored without engagement, rather than reading them as zero", () => {
		// Rows from before 0.1.2 have no bounces. Counted as zero bounces they
		// would pull the rate towards a perfect score.
		const rows = owner().slice(0, 30).map((row, i) => (i >= 10 ? { ...row, bounces: undefined, totaltime: undefined } : row));
		const e = engagementOver(rows)!;
		expect(e.bounceRate).toBeCloseTo(755 / 980, 6);
		expect(e.days).toBe(10);
		expect(e.since).toBe(addDays(TODAY, -9));
		expect(engagementOver(rows.slice(10))).toBeNull();
	});
});

describe("the engagement figures", () => {
	it("show the owner's 30 days against the 30 before, with the bounce rate in points", () => {
		const blocks = engagementStats(owner(), 30, TODAY, "en")!.blocks;
		const items = (blocks[0] as unknown as { items: Array<{ label: string; value: string; description: string; trend?: string }> }).items;
		expect(items.map((i) => [i.label, i.value, i.description])).toEqual([
			["Bounce rate, last 30 days", "77%", "-10.5 percentage points vs previous period"],
			["Average visit, last 30 days", "1 min 22 s", "+228% vs previous period"],
			["Page views per visit, last 30 days", "2.07", "+71% vs previous period"],
		]);
		// A rising bounce rate is bad news; an arrow up would say otherwise.
		expect(items[0]!.trend).toBeUndefined();
		expect(items[1]!.trend).toBe("up");
	});

	it("compare nothing when stored engagement does not reach the period before", () => {
		const rows = owner().map((row, i) => (i >= 30 ? { ...row, bounces: undefined, totaltime: undefined } : row));
		const items = (engagementStats(rows, 30, TODAY, "en")!.blocks[0] as unknown as { items: Array<{ description: string }> }).items;
		expect(items.every((i) => /no earlier period/.test(i.description))).toBe(true);
	});

	it("say from which day they count when the range starts before the stored engagement", () => {
		const rows = owner().map((row, i) => (i >= 12 ? { ...row, bounces: undefined, totaltime: undefined } : row));
		const section = engagementSection(rows, 30, TODAY, "en");
		expect(validateBlocks(section).valid).toBe(true);
		expect(text(section)).toContain(`from ${formatDay(addDays(TODAY, -11), "en")}, the first day stored with them`);
	});

	it("are absent, not zero, when no day carries engagement", () => {
		const rows = owner().map((row) => ({ ...row, bounces: undefined, totaltime: undefined }));
		expect(engagementSection(rows, 30, TODAY, "en")).toEqual([]);
	});

	it("follow the reader's language", () => {
		const items = (engagementStats(owner(), 30, TODAY, "de")!.blocks[0] as unknown as { items: Array<{ value: string; description: string }> }).items;
		expect(items[0]!.value).toMatch(/^77\s%$/u);
		expect(items[0]!.description).toBe("-10,5 Prozentpunkte ggü. vorigem Zeitraum");
		expect(items[1]!.value).toBe("1 Min. 22 s");
		expect(items[2]!.value).toBe("2,07");
	});
});

describe("the engagement charts", () => {
	it("plot the bounce rate in percent and the visit time in seconds, one chart each, a point per day", () => {
		const section = engagementSection(owner(), 7, TODAY, "en");
		expect(validateBlocks(section).valid).toBe(true);
		const charts = chartsIn(section);
		const bounce = charts.get("analytics:chart:bounce-rate")!;
		const time = charts.get("analytics:chart:visit-time")!;
		expect(bounce.series.map((s) => s.data.length)).toEqual([7]);
		expect(bounce.series[0]!.data[0]).toEqual([Date.parse(`${addDays(TODAY, -6)}T00:00:00.000Z`), 77]);
		expect(time.series[0]!.data[0]![1]).toBe(82);
		expect(bounce.y_axis_name).toBe("%");
		expect(time.y_axis_name).toBe("Seconds");
	});

	it("leave a day without engagement out of the line", () => {
		const rows = owner().map((row, i) => (i === 2 ? { ...row, bounces: undefined } : row));
		expect(engagementByDay(rows.slice(0, 7))).toHaveLength(6);
	});
});

describe("the widget", () => {
	it("shows the week's engagement beside visits and page views, from the rows it already reads", () => {
		const blocks = renderWidget({
			state: { phase: "overview", lastSync: NOW.toISOString() },
			rollups: owner().slice(0, 14),
			entriesByPath: new Map(),
			now: NOW,
			locale: "en",
		});
		expect(validateBlocks(blocks).valid).toBe(true);
		expect(text(blocks)).toMatch(/Bounce rate, last 7 days/);
		expect(text(blocks)).toMatch(/Average visit, last 7 days/);
	});
});

describe("the reads chart", () => {
	const snapshot: ReadSnapshot = {
		at: NOW.toISOString(),
		event: "post_read",
		entryProperty: "post",
		depthProperty: "depth",
		depths: ["half", "end"],
		since: addDays(TODAY, -29),
		byEntry: { "a-post": [51, 43] },
		daily: [
			{ date: addDays(TODAY, -40), counts: [9, 9] },
			{ date: addDays(TODAY, -5), counts: [20, 15] },
			{ date: addDays(TODAY, -1), counts: [31, 28] },
		],
		partial: false,
	};

	it("draws reads by day as bars, one series per depth in the settings' order, inside the range", () => {
		const blocks = readsChart(snapshot, 30, TODAY, NOW, "en");
		expect(validateBlocks(blocks).valid).toBe(true);
		const chart = blocks.find((b) => (b as { block_id?: string }).block_id === "analytics:chart:reads") as unknown as {
			config: { style: string; series: Array<{ name: string; data: Array<[number, number]> }> };
		};
		expect(chart.config.style).toBe("bar");
		expect(chart.config.series.map((s) => [s.name, s.data.map((p) => p[1])])).toEqual([
			["half", [20, 31]],
			["end", [15, 28]],
		]);
		expect(text(blocks)).toMatch(/post_read events by depth/);
	});

	it("draws nothing without a snapshot or without a read in the range", () => {
		expect(readsChart(undefined, 30, TODAY, NOW, "en")).toEqual([]);
		expect(readsChart({ ...snapshot, daily: [snapshot.daily[0]!] }, 30, TODAY, NOW, "en")).toEqual([]);
	});
});

describe("durations", () => {
	it("read as seconds under a minute and as minutes and seconds above", () => {
		expect(formatDuration(25, "en")).toBe("25 s");
		expect(formatDuration(82.4, "en")).toBe("1 min 22 s");
	});
});
