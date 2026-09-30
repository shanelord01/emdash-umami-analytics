import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { langOf, t } from "../src/i18n.js";
import type { RollupRow } from "../src/store/rows.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { renderPage, type PageInput } from "../src/ui/page.js";
import { renderWidget, type WidgetInput } from "../src/ui/widget.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");

function days(count: number, pageviews: number): RollupRow[] {
	return Array.from({ length: count }, (_, i) => ({
		date: new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10),
		pageviews,
		visits: pageviews,
		sampleInterval: 1,
		fetchedAt: NOW.toISOString(),
	}));
}

function widget(locale: string | undefined, state: SyncState = { phase: "overview", lastSync: NOW.toISOString() }) {
	const input: WidgetInput = { state, rollups: days(14, 1234), entriesByPath: new Map(), now: NOW, locale };
	return JSON.stringify(renderWidget(input));
}

function page(locale: string | undefined) {
	const input: PageInput = {
		state: {
			phase: "overview",
			provider: "umami",
			lastSync: NOW.toISOString(),
			countries: [{ label: "DE", visits: 3 }],
			snapshotSince: "2026-09-18",
		},
		range: 7,
		rollups: days(14, 1234),
		topEntries: { rows: [], partial: false },
		entriesByPath: new Map(),
		dashboardUrl: "https://cloud.umami.is/websites/site-1",
		now: NOW,
		locale,
	};
	return JSON.stringify(renderPage(input));
}

describe("which catalogue a locale reads", () => {
	it("reads German for every German admin locale and English for the rest", () => {
		expect(["de", "de-DE", "de-AT", "de_CH"].map(langOf)).toEqual(["de", "de", "de", "de"]);
		expect(["en", "en-GB", "ar", "fr", undefined].map(langOf)).toEqual(["en", "en", "en", "en", "en"]);
	});

	it("picks the singular and plural forms per language", () => {
		expect(t("de", "rangeDays", { count: 1 })).toBe("1 Tag");
		expect(t("de", "rangeDays", { count: 7 })).toBe("7 Tage");
		expect(t("en", "rangeDays", { count: 1 })).toBe("1 day");
	});
});

describe("the widget and the page in German", () => {
	it("labels, numbers and the comparison follow the admin locale", () => {
		const de = widget("de");
		expect(de).toContain("Besuche, letzte 7 Tage");
		expect(de).toContain("8.638");
		expect(de).toContain("Aktualisieren");
		expect(de).not.toContain("Visits, last");

		const en = widget("en");
		expect(en).toContain("Visits, last 7 days");
		expect(en).toContain("8,638");
	});

	it("falls back to English for an admin locale without a catalogue", () => {
		expect(widget("ar")).toContain("Visits, last 7 days");
		expect(widget(undefined)).toContain("Visits, last 7 days");
	});

	it("shows a stored sync failure in the reader's language, not the one it was written in", () => {
		// Failures are written by cron ticks, which have no locale at all.
		const state: SyncState = {
			phase: "overview",
			lastSync: NOW.toISOString(),
			lastError: "Umami returned HTTP 502",
			lastProblem: { key: "umamiHttp", params: { status: 502 } },
			lastErrorAt: NOW.toISOString(),
		};
		expect(widget("de", state)).toContain("Umami hat HTTP 502 zurückgegeben");
		expect(widget("en", state)).toContain("Umami returned HTTP 502");
	});

	it("shows an unrecognized failure verbatim in every language", () => {
		const state: SyncState = {
			phase: "overview",
			lastSync: NOW.toISOString(),
			lastError: "Inverted range: something new",
			lastErrorAt: NOW.toISOString(),
		};
		expect(widget("de", state)).toContain("Inverted range: something new");
	});

	it("names ranges, countries and dates in German on the page", () => {
		const de = page("de");
		expect(de).toContain("7 Tage");
		expect(de).toContain("Meistbesuchte Einträge");
		expect(de).toContain("Deutschland");
		expect(de).toContain("In Umami öffnen");
		expect(de).toContain("18.09.2026");
	});
});

describe("through the sandbox", () => {
	let host: PluginRuntimeTestHost | undefined;

	afterEach(async () => {
		await host?.dispose();
		host = undefined;
	});

	it("answers a German admin in German, the refresh toast included", async () => {
		host = await createPluginRuntimeTestHost({
			site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
		});
		const response = await host.admin.act("widget:traffic", "analytics:refresh", { locale: "de" });
		expect(response.toast?.type).toBe("error");
		expect(String(response.toast?.message)).toMatch(/noch nicht eingerichtet/);
		expect(JSON.stringify(response.blocks)).toMatch(/Aktualisieren/);
	});
});
