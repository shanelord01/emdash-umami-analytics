import { describe, expect, it } from "vitest";

import { createDemoProvider } from "../src/providers/demo.js";
import { addDays, enumerateDays } from "../src/sync/window.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const TODAY = "2026-09-23";
const ENTRY_PATHS = ["/", "/about/", "/blog/first-post/", "/blog/second-post/", "/contact/"];

function demo(paths: string[] = ENTRY_PATHS) {
	return createDemoProvider({ listPaths: async () => paths, now: () => NOW, trailingSlash: "always" });
}

async function overviewOf(range: { since: string; until: string }, paths?: string[]) {
	const res = await demo(paths).overview(range);
	if (!res.ok) throw new Error(res.error);
	return res.value;
}

describe("the demo provider", () => {
	it("returns the same numbers for a closed day on every tick", async () => {
		// Read-compare-write only skips rows whose numbers did not change. A
		// generator that drifted between ticks would rewrite every stored row
		// every 15 minutes, which is the D1 write budget the design protects.
		const range = { since: addDays(TODAY, -10), until: addDays(TODAY, -1) };
		const first = await overviewOf(range);
		const second = await overviewOf(range);
		expect(second.series).toEqual(first.series);
		expect(second.topPaths).toEqual(first.topPaths);
	});

	it("agrees with itself between the overview and the per-path numbers", async () => {
		// The content report joins per-path rows to entries while the widget
		// shows the overview's top pages; if the two disagreed, the demo
		// would show two different numbers for one page.
		const range = { since: addDays(TODAY, -6), until: TODAY };
		const overview = await overviewOf(range);
		const res = await demo().paths(ENTRY_PATHS, range);
		if (!res.ok) throw new Error(res.error);

		for (const top of overview.topPaths.filter((p) => ENTRY_PATHS.includes(p.path))) {
			const rows = res.value.filter((r) => r.path === top.path);
			expect(rows.reduce((n, r) => n + r.pageviews, 0)).toBe(top.pageviews);
			expect(rows.reduce((n, r) => n + r.visits, 0)).toBe(top.visits);
		}
	});

	it("adds its daily series up to its totals", async () => {
		const overview = await overviewOf({ since: addDays(TODAY, -29), until: TODAY });
		expect(overview.series).toHaveLength(30);
		expect(overview.series.reduce((n, d) => n + d.pageviews, 0)).toBe(overview.totals.pageviews);
		expect(overview.series.reduce((n, d) => n + d.visits, 0)).toBe(overview.totals.visits);
	});

	it("has quieter weekends than weekdays, like a business site", async () => {
		const overview = await overviewOf({ since: "2026-08-03", until: "2026-08-30" });
		const byWeekday = (days: number[]) =>
			overview.series.filter((d) => days.includes(new Date(`${d.date}T00:00:00Z`).getUTCDay()));
		const mean = (rows: Array<{ pageviews: number }>) => rows.reduce((n, r) => n + r.pageviews, 0) / rows.length;
		expect(mean(byWeekday([0, 6]))).toBeLessThan(mean(byWeekday([2, 3, 4])));
	});

	it("marks today as sampled and provisional, and closed days as exact", async () => {
		// Imitates a sampling provider, so the demo exercises the labels
		// and the write guards that exist for one.
		const overview = await overviewOf({ since: addDays(TODAY, -3), until: TODAY });
		const today = overview.series.find((d) => d.date === TODAY)!;
		const closed = overview.series.filter((d) => d.date !== TODAY);
		expect(today.sampleInterval).toBeGreaterThan(1);
		for (const day of closed) expect(day.sampleInterval).toBe(1);

		// Half the day has passed at NOW, so today is well below a closed day.
		const yesterday = overview.series.find((d) => d.date === addDays(TODAY, -1))!;
		expect(today.pageviews).toBeLessThan(yesterday.pageviews);
	});

	it("puts some traffic on paths that are no entry, as real sites have", async () => {
		const overview = await overviewOf({ since: addDays(TODAY, -6), until: TODAY });
		expect(overview.topPaths.some((p) => !ENTRY_PATHS.includes(p.path))).toBe(true);
		expect(overview.topPaths[0]!.path).toBe("/");
	});

	it("still produces numbers before any content is indexed", async () => {
		const overview = await overviewOf({ since: addDays(TODAY, -6), until: TODAY }, []);
		expect(overview.totals.pageviews).toBeGreaterThan(0);
	});

	it("answers for a 90-day window, which the first sync backfills", async () => {
		const range = { since: addDays(TODAY, -90), until: TODAY };
		const overview = await overviewOf(range);
		expect(overview.series.map((d) => d.date)).toEqual(enumerateDays(range.since, range.until));
	});

	it("reports nothing for a path it was never told about", async () => {
		const res = await demo().paths(["/not-an-entry/"], { since: addDays(TODAY, -6), until: TODAY });
		expect(res).toEqual({ ok: true, value: [] });
	});

	it("labels direct traffic and gives countries as ISO codes", async () => {
		const overview = await overviewOf({ since: addDays(TODAY, -6), until: TODAY });
		expect(overview.referrers.map((r) => r.label)).toContain("(direct)");
		for (const c of overview.countries) expect(c.label).toMatch(/^[A-Z]{2}$/);
	});
});
