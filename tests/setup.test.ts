import { validateBlocks } from "@emdash-cms/blocks/server";
import { describe, expect, it } from "vitest";

import { failure } from "../src/i18n.js";
import { checkSetup, intervalMinutes, renderSetup, type CheckId, type SetupFacts } from "../src/ui/setup.js";

/**
 * Every setup failure the check knows, each from the state that produces
 * it, and the sentence it has to answer with. The runtime-host tests in
 * `setup-sync.test.ts` reproduce the same states through the real bridge.
 */

const NOW = new Date("2026-09-25T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

function healthy(): SetupFacts {
	return {
		provider: "umami",
		missing: [],
		siteTag: "site-1",
		hosts: ["example.test", "www.example.test"],
		siteUrl: "https://example.test",
		discovery: { ok: true, value: [{ siteTag: "site-1", hosts: ["example.test"], pageviews: 120 }] },
		tasks: [{ name: "sync", schedule: "*/15 * * * *", nextRunAt: minutesAgo(-10), lastRunAt: minutesAgo(5) }],
		state: { phase: "overview", lastSync: minutesAgo(5), indexComplete: true, indexed: 14 },
		now: NOW,
	};
}

function check(facts: SetupFacts, id: CheckId, locale = "en") {
	const found = checkSetup(facts, locale).find((c) => c.id === id);
	if (!found) throw new Error(`no ${id} check`);
	return found;
}

function problems(facts: SetupFacts): CheckId[] {
	return checkSetup(facts, "en")
		.filter((c) => c.status === "problem")
		.map((c) => c.id);
}

describe("a complete setup", () => {
	it("has no problem and says so", () => {
		const facts = healthy();
		expect(problems(facts)).toEqual([]);
		const blocks = renderSetup(facts, 30, "en");
		expect(validateBlocks(blocks).valid).toBe(true);
		expect(JSON.stringify(blocks)).toMatch(/Everything the numbers depend on is in place/);
	});

	it("names what it counts and what it leaves out", () => {
		const facts = healthy();
		facts.discovery = {
			ok: true,
			value: [{ siteTag: "site-1", hosts: ["example.test", "site-1-preview.workers.dev"], pageviews: 120 }],
		};
		expect(check(facts, "hosts")).toMatchObject({
			status: "ok",
			detail: "Counted: example.test. Not counted: site-1-preview.workers.dev.",
		});
	});
});

describe("each failure, with the sentence that names its fix", () => {
	it("a missing key asks for the key and explains the encryption key", () => {
		const facts = { ...healthy(), missing: ["umamiApiKey"], discovery: null };
		expect(check(facts, "credentials").detail).toMatch(/add an Umami API key in the plugin's settings/);
		expect(check(facts, "credentials").detail).toMatch(/If saving the API key fails/);
		expect(check(facts, "credentials").detail).toMatch(/npx emdash secrets generate/);
		expect(check(facts, "credentials", "de").detail).toMatch(/einen Umami-API-Schlüssel/);
		expect(check(facts, "access")).toMatchObject({ status: "skipped", detail: "Needs the API key." });
		expect(check(facts, "siteTag").status).toBe("skipped");
	});

	it("a key Umami refuses", () => {
		const facts = { ...healthy(), discovery: failure("umamiBadKey") };
		expect(check(facts, "access")).toMatchObject({
			status: "problem",
			detail: expect.stringMatching(/rejected the API key \(401\)/),
		});
		expect(check(facts, "hosts").status).toBe("skipped");
	});

	it("each other refusal reads as one sentence, in the reader's language", () => {
		const access = (key: Parameters<typeof failure>[0], locale = "en") =>
			check({ ...healthy(), discovery: failure(key, { status: 200, detail: "timed out" }) }, "access", locale).detail;
		expect(access("umamiProxy")).toMatch(/answered with a web page instead of JSON \(HTTP 200\)/);
		expect(access("umamiRateLimited")).toMatch(/rate-limited the request \(429\)/);
		expect(access("umamiUnreachable")).toBe("Umami could not be reached: timed out");
		expect(access("umamiProxy", "de")).toMatch(/mit einer Webseite statt mit JSON geantwortet/);
		expect(access("umamiNoWebsite", "de")).toMatch(/keine Website mit dieser ID/);
	});

	it("no website ID, with the websites to copy one from", () => {
		const facts: SetupFacts = {
			...healthy(),
			siteTag: "",
			discovery: { ok: true, value: [{ siteTag: "site-1", name: "Blog", hosts: ["example.test"] }] },
		};
		expect(check(facts, "siteTag")).toMatchObject({
			status: "problem",
			detail: expect.stringMatching(/Copy one from the list below/),
		});
		const text = JSON.stringify(renderSetup(facts, 30, "en"));
		expect(text).toMatch(/Websites this API key can list/);
		expect(text).toMatch(/site-1/);
		expect(text).toMatch(/Blog/);
	});

	it("no website ID and nothing to list says where the ID is", () => {
		const facts = { ...healthy(), siteTag: "", discovery: { ok: true as const, value: [] } };
		expect(check(facts, "siteTag").detail).toMatch(/Copy the ID from the website's settings in Umami/);
	});

	it("a website without traffic, which is what a missing tracking script looks like", () => {
		const facts = { ...healthy(), discovery: { ok: true as const, value: [] } };
		expect(check(facts, "siteTag")).toMatchObject({
			status: "problem",
			detail: "Umami reported no page views for this website in the last 7 days. Check that the tracking script is on the site.",
		});
		expect(check(facts, "hosts")).toMatchObject({ status: "skipped", detail: "Needs a website ID with traffic." });
	});

	it("a hostname filter that excludes every host Umami reports", () => {
		const facts = healthy();
		facts.discovery = { ok: true, value: [{ siteTag: "site-1", hosts: ["www.other.test"], pageviews: 120 }] };
		expect(check(facts, "hosts")).toMatchObject({
			status: "problem",
			detail:
				"Umami reports this website under www.other.test, but the plugin counts only example.test, www.example.test. Change Hostnames to count in the plugin's settings.",
		});
		// The hostnames it does report are listed, to copy from.
		expect(JSON.stringify(renderSetup(facts, 30, "en"))).toMatch(/Websites this API key can list/);
	});

	it("no stored site URL, which leaves the index nothing to match", () => {
		const facts = { ...healthy(), siteUrl: "", state: { ...healthy().state, indexed: 0, matched: 0 } };
		expect(check(facts, "siteUrl")).toMatchObject({
			status: "problem",
			detail: expect.stringMatching(/emdash:site_url/),
		});
		expect(check(facts, "index").status).toBe("skipped");
	});

	it("a finished index that matched nothing although the URL is set", () => {
		const facts = { ...healthy(), state: { ...healthy().state, indexed: 0, matched: 0 } };
		expect(check(facts, "index")).toMatchObject({
			status: "problem",
			detail: expect.stringMatching(/URL Pattern \(under Content Types\), then press Rebuild index/),
		});
	});

	it("counts entries the content hooks matched before the index walk reached them", () => {
		// The walk added none itself (indexed 0): every entry was published after install.
		const facts = { ...healthy(), state: { ...healthy().state, indexed: 0, matched: 9 } };
		expect(check(facts, "index")).toMatchObject({ status: "ok", detail: "9 entries matched to their pages." });
	});

	it("waits for a count on a state from before the matched count was stored", () => {
		const facts = { ...healthy(), state: { ...healthy().state, indexed: 0 } };
		expect(check(facts, "index").status).toBe("waiting");
	});

	it("a host without a scheduler", () => {
		const facts = { ...healthy(), tasks: null };
		expect(check(facts, "scheduler")).toMatchObject({
			status: "problem",
			detail: expect.stringMatching(/runs no scheduled tasks/),
		});
	});

	it("a sync that is not scheduled", () => {
		const facts = { ...healthy(), tasks: [] };
		expect(check(facts, "scheduler").detail).toMatch(/not scheduled yet/);
	});

	it("a sync that stopped running, with the Cron Trigger and handler to add", () => {
		const facts = healthy();
		facts.tasks = [{ name: "sync", schedule: "*/15 * * * *", nextRunAt: minutesAgo(-10), lastRunAt: minutesAgo(45) }];
		expect(check(facts, "scheduler")).toMatchObject({
			status: "problem",
			detail: "Last run 45 minutes ago, but scheduled every 15 minutes: the site's scheduler is not running on time.",
		});
		const text = JSON.stringify(renderSetup(facts, 30, "en"));
		expect(text).toMatch(/createScheduledHandler/);
		expect(text).toMatch(/npx emdash doctor/);
	});

	it("a sync that never ran since the dashboard first scheduled it", () => {
		const facts: SetupFacts = {
			...healthy(),
			tasks: [{ name: "sync", schedule: "*/15 * * * *", nextRunAt: minutesAgo(-10), lastRunAt: null }],
			state: { phase: "overview" },
			waitingSince: minutesAgo(120),
		};
		expect(check(facts, "scheduler")).toMatchObject({
			status: "problem",
			detail: expect.stringMatching(/has never run/),
		});
	});

	it("a requested sync still waiting long after it was due", () => {
		const facts = healthy();
		facts.tasks = [
			...(facts.tasks ?? []),
			{ name: "refresh", schedule: minutesAgo(30), nextRunAt: minutesAgo(30), lastRunAt: null },
		];
		expect(check(facts, "scheduler").detail).toMatch(/requested 30 minutes ago has not run/);
	});

	it("a failing sync, in the reader's language", () => {
		const facts = healthy();
		facts.state = {
			...facts.state,
			lastError: "Umami rate-limited the request (429). The next sync tries again.",
			lastProblem: { key: "umamiRateLimited" },
			lastErrorAt: minutesAgo(3),
		};
		expect(check(facts, "lastSync").detail).toMatch(/^Last attempt failed 3 minutes ago: Umami rate-limited/);
		expect(check(facts, "lastSync", "de").detail).toMatch(/Umami hat die Anfrage gedrosselt/);
	});

	it("counts problems in the banner", () => {
		const facts = { ...healthy(), siteUrl: "", tasks: [] };
		expect(JSON.stringify(renderSetup(facts, 30, "en"))).toMatch(/2 problems stop or distort the numbers/);
	});
});

describe("before anything is known", () => {
	it("waits instead of reporting a fresh install as broken", () => {
		const facts: SetupFacts = {
			...healthy(),
			tasks: [{ name: "sync", schedule: "*/15 * * * *", nextRunAt: minutesAgo(-10), lastRunAt: null }],
			state: { phase: "overview" },
			waitingSince: minutesAgo(5),
		};
		expect(problems(facts)).toEqual([]);
		expect(check(facts, "scheduler").status).toBe("waiting");
		expect(check(facts, "index").status).toBe("waiting");
	});

	it("checks nothing on Umami while demo data is on", () => {
		const facts = { ...healthy(), provider: "demo" as const, discovery: null };
		expect(checkSetup(facts, "en").map((c) => c.id)).not.toContain("access");
		expect(check(facts, "source").detail).toMatch(/Demo data/);
	});
});

describe("the check's own words", () => {
	it("names its rows in the reader's language", () => {
		const labels = (locale: string) => {
			const table = renderSetup(healthy(), 30, locale).find((b) => b.block_id === "analytics:setup:checks") as unknown as {
				rows: Array<{ check: string }>;
			};
			return table.rows.slice(0, 5).map((row) => row.check);
		};
		expect(labels("en")).toEqual(["Data source", "API key", "Umami access", "Website ID", "Hostnames"]);
		expect(labels("de")).toEqual(["Datenquelle", "API-Schlüssel", "Zugriff auf Umami", "Website-ID", "Hostnamen"]);
	});
});

describe("intervalMinutes", () => {
	it("reads the four schedules the settings offer", () => {
		expect(["*/15 * * * *", "*/30 * * * *", "0 * * * *", "0 */6 * * *"].map(intervalMinutes)).toEqual([15, 30, 60, 360]);
	});
});
