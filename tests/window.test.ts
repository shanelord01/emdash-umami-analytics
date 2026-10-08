import { describe, expect, it } from "vitest";

import {
	addDays,
	backfillWindow,
	dayEndMs,
	dayStartMs,
	daysBetween,
	DEFAULT_TIME_ZONE,
	enumerateDays,
	isDay,
	isExact,
	isFrozen,
	isProvisional,
	localDay,
	resolveTimeZone,
	stateZone,
	syncWindow,
	UNSAMPLED_WINDOW_DAYS,
} from "../src/sync/window.js";

const at = (iso: string) => new Date(iso);

const SYDNEY = "Australia/Sydney";

describe("local days", () => {
	it("puts a page view on the site's day, not the UTC one", () => {
		// 8:15 am in Sydney on 27 September is still the 26th in UTC. Keyed
		// in UTC it was charted a day early, as everything before about
		// 10 am Sydney time was.
		expect(localDay(at("2026-09-26T22:15:00.000Z"), SYDNEY)).toBe("2026-09-27");
		expect(localDay(at("2026-09-26T22:15:00.000Z"), "UTC")).toBe("2026-09-26");
		expect(localDay(at("2026-09-26T13:59:59.999Z"), SYDNEY)).toBe("2026-09-26");
		expect(localDay(at("2026-09-26T14:00:00.000Z"), SYDNEY)).toBe("2026-09-27");
	});

	it("reads the zone's day, not the runtime's", () => {
		// 00:30 in Berlin on the 21st is the 20th in UTC and the 21st in
		// Berlin, whatever zone the test runs in.
		expect(localDay(at("2026-09-21T00:30:00+02:00"), "Europe/Berlin")).toBe("2026-09-21");
		expect(localDay(at("2026-09-21T00:30:00+02:00"), "UTC")).toBe("2026-09-20");
	});

	it("starts and ends a Sydney day at local midnight", () => {
		expect(dayStartMs("2026-09-27", SYDNEY)).toBe(Date.parse("2026-09-26T14:00:00.000Z"));
		expect(dayEndMs("2026-09-27", SYDNEY)).toBe(Date.parse("2026-09-27T13:59:59.999Z"));
		expect(dayStartMs("2026-09-27", "UTC")).toBe(Date.parse("2026-09-27T00:00:00.000Z"));
	});

	it("gives 3 October its 24 hours at +10:00", () => {
		expect(dayStartMs("2026-10-03", SYDNEY)).toBe(Date.parse("2026-10-02T14:00:00.000Z"));
		expect(dayEndMs("2026-10-03", SYDNEY)).toBe(Date.parse("2026-10-03T13:59:59.999Z"));
	});

	it("gives the day the clocks go forward 23 hours", () => {
		// Sydney moves to daylight time at 2 am on Sunday 4 October 2026:
		// the day starts at +10:00 and ends at +11:00.
		expect(dayStartMs("2026-10-04", SYDNEY)).toBe(Date.parse("2026-10-03T14:00:00.000Z"));
		expect(dayEndMs("2026-10-04", SYDNEY)).toBe(Date.parse("2026-10-04T12:59:59.999Z"));
		expect(dayEndMs("2026-10-04", SYDNEY) + 1 - dayStartMs("2026-10-04", SYDNEY)).toBe(23 * 3_600_000);
		// The day after is a whole day again, at the new offset.
		expect(dayStartMs("2026-10-05", SYDNEY)).toBe(Date.parse("2026-10-04T13:00:00.000Z"));
		expect(dayEndMs("2026-10-05", SYDNEY) + 1 - dayStartMs("2026-10-05", SYDNEY)).toBe(24 * 3_600_000);
		// And a view on either side of the change lands on its own day.
		expect(localDay(at("2026-10-03T13:59:59.999Z"), SYDNEY)).toBe("2026-10-03");
		expect(localDay(at("2026-10-04T12:59:59.999Z"), SYDNEY)).toBe("2026-10-04");
		expect(localDay(at("2026-10-04T13:00:00.000Z"), SYDNEY)).toBe("2026-10-05");
	});

	it("gives the day the clocks go back 25 hours", () => {
		expect(dayStartMs("2027-04-04", SYDNEY)).toBe(Date.parse("2027-04-03T13:00:00.000Z"));
		expect(dayEndMs("2027-04-04", SYDNEY) + 1 - dayStartMs("2027-04-04", SYDNEY)).toBe(25 * 3_600_000);
	});

	it("starts a day whose midnight the clocks skip at its first instant", () => {
		// Chile goes from 23:59:59 straight to 01:00 on 6 September 2026.
		expect(dayStartMs("2026-09-06", "America/Santiago")).toBe(Date.parse("2026-09-06T04:00:00.000Z"));
		expect(dayEndMs("2026-09-05", "America/Santiago")).toBe(Date.parse("2026-09-06T03:59:59.999Z"));
	});

	it("lays the days of a window end to end across a clock change", () => {
		// No gap and no overlap: each day starts the millisecond after the
		// one before it ends.
		const days = enumerateDays("2026-10-02", "2026-10-06");
		expect(days).toEqual(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
		for (const [i, day] of days.slice(1).entries()) {
			expect(dayStartMs(day, SYDNEY)).toBe(dayEndMs(days[i]!, SYDNEY) + 1);
		}
	});

	it("keeps a window on local days across the change", () => {
		// 00:30 on 5 October in Sydney, which is still the 4th in UTC.
		const w = syncWindow(at("2026-10-04T13:30:00.000Z"), 2, UNSAMPLED_WINDOW_DAYS, SYDNEY);
		expect(w).toEqual({ since: "2026-10-03", until: "2026-10-05", clamped: false });
	});
});

describe("the time zone setting", () => {
	it("keeps a zone Intl knows, as Intl spells it", () => {
		// The helper in src/time/zone.ts is copied from emdash-to-buffer-plus,
		// whose own tests cover it further. These pin what this plugin needs.
		expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
		expect(resolveTimeZone(" UTC ")).toBe("UTC");
		expect(resolveTimeZone("australia/sydney")).toBe("Australia/Sydney");
	});

	it("falls back to the default for a name that is no zone", () => {
		expect(DEFAULT_TIME_ZONE).toBe("Australia/Sydney");
		expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_TIME_ZONE);
		expect(resolveTimeZone("")).toBe(DEFAULT_TIME_ZONE);
		expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
		expect(resolveTimeZone(10)).toBe(DEFAULT_TIME_ZONE);
	});

	it("reads the stored zone from the state, and the default before there is one", () => {
		expect(stateZone({ dayZone: "Europe/Berlin" })).toBe("Europe/Berlin");
		expect(stateZone({})).toBe(DEFAULT_TIME_ZONE);
	});
});

describe("day arithmetic", () => {
	it("crosses month, year and leap-day boundaries", () => {
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
	});

	it("survives the European DST switch", () => {
		// 2026-10-25 is the CET/CEST changeover. A local-midnight
		// implementation drifts by an hour here and lands on the wrong day.
		expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
		expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
		expect(daysBetween("2026-10-24", "2026-10-27")).toBe(3);
	});

	it("counts backwards as negative", () => {
		expect(daysBetween("2026-09-20", "2026-09-13")).toBe(-7);
	});

	it("rejects things that are not days", () => {
		expect(isDay("2026-09-20")).toBe(true);
		expect(isDay("2026-9-20")).toBe(false);
		expect(isDay("2026-09-20T00:00:00Z")).toBe(false);
		expect(isDay(20260920)).toBe(false);
		expect(() => addDays("not-a-day", 1)).toThrow(RangeError);
	});

	it("enumerates inclusively and returns nothing for an inverted range", () => {
		expect(enumerateDays("2026-09-18", "2026-09-20")).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
		expect(enumerateDays("2026-09-20", "2026-09-20")).toEqual(["2026-09-20"]);
		expect(enumerateDays("2026-09-20", "2026-09-18")).toEqual([]);
	});
});

describe("syncWindow", () => {
	const now = at("2026-09-20T10:00:00.000Z");

	it("asks for the requested overlap when it is safe", () => {
		expect(syncWindow(now, 2)).toEqual({ since: "2026-09-18", until: "2026-09-20", clamped: false });
	});

	it("never lets date_geq cross the sampling cliff", () => {
		// The whole point. A 30-day window would return tenfold-quantized
		// numbers for every day in it, today included, so it is refused.
		const w = syncWindow(now, 30);
		expect(w.since).toBe("2026-09-13");
		expect(w.until).toBe("2026-09-20");
		expect(w.clamped).toBe(true);
		expect(daysBetween(w.since, w.until)).toBe(UNSAMPLED_WINDOW_DAYS);
	});

	it("reports honestly whether it clamped", () => {
		expect(syncWindow(now, UNSAMPLED_WINDOW_DAYS).clamped).toBe(false);
		expect(syncWindow(now, UNSAMPLED_WINDOW_DAYS + 1).clamped).toBe(true);
	});

	it("treats a zero or negative overlap as today only", () => {
		expect(syncWindow(now, 0)).toEqual({ since: "2026-09-20", until: "2026-09-20", clamped: false });
		expect(syncWindow(now, -5).since).toBe("2026-09-20");
	});

	it("backfills exactly to the cliff and no further", () => {
		const w = backfillWindow(now);
		expect(w.since).toBe("2026-09-13");
		expect(w.clamped).toBe(false);
	});
});

describe("freezing", () => {
	const today = "2026-09-20";

	it("treats today as provisional", () => {
		// Today reported sampleInterval 2.1-2.3 even in a one-day window,
		// so it is an estimate until the day closes.
		expect(isProvisional("2026-09-20", today)).toBe(true);
		expect(isProvisional("2026-09-19", today)).toBe(false);
	});

	it("never freezes today, whatever the sample interval says", () => {
		expect(isFrozen("2026-09-20", today, 1)).toBe(false);
	});

	it("keeps recent closed days writable so late beacons still land", () => {
		expect(isFrozen("2026-09-19", today, 1, 2)).toBe(false);
		expect(isFrozen("2026-09-18", today, 1, 2)).toBe(true);
	});

	it("refuses to freeze a row that was stored from a sampled response", () => {
		// Freezing an estimate would make it permanent and unfixable.
		expect(isFrozen("2026-09-15", today, 10, 2)).toBe(false);
		expect(isFrozen("2026-09-15", today, 1.35, 2)).toBe(false);
		expect(isFrozen("2026-09-15", today, 1, 2)).toBe(true);
	});

	it("calls only sampleInterval 1 exact", () => {
		expect(isExact(1)).toBe(true);
		expect(isExact(1.0000001)).toBe(false);
		expect(isExact(2.33)).toBe(false);
		expect(isExact(10)).toBe(false);
	});
});
