/**
 * Formatting for the admin UI. Pure.
 *
 * The locale is the catalogue language from `langOf()`, not the raw admin
 * locale: text comes from the plugin's own catalogue, and numbers, dates
 * and relative times use the same language so they never mix with it. A
 * German editor sees "1.234" and "vor 3 Minuten".
 */

import { langOf, t } from "../i18n.js";

/** Digits grouped the way the reader's locale groups them. */
export function formatCount(value: number, locale?: string): string {
	if (!Number.isFinite(value)) return "0";
	try {
		return new Intl.NumberFormat(locale ?? "en").format(value);
	} catch {
		return String(Math.trunc(value));
	}
}

/**
 * "3 minutes ago", in the reader's language.
 *
 * Returns `null` for a missing timestamp rather than a placeholder, so the
 * caller decides what absent looks like.
 */
export function formatAge(iso: string | undefined, now: Date, locale?: string): string | null {
	if (!iso) return null;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return null;

	const seconds = Math.round((then - now.getTime()) / 1000);
	const [value, unit] = pickUnit(seconds);

	try {
		return new Intl.RelativeTimeFormat(locale ?? "en", { numeric: "auto" }).format(value, unit);
	} catch {
		const abs = Math.abs(value);
		return value <= 0 ? `${abs} ${unit}${abs === 1 ? "" : "s"} ago` : `in ${abs} ${unit}${abs === 1 ? "" : "s"}`;
	}
}

function pickUnit(seconds: number): [number, Intl.RelativeTimeFormatUnit] {
	const abs = Math.abs(seconds);
	if (abs < 60) return [seconds, "second"];
	if (abs < 3600) return [Math.round(seconds / 60), "minute"];
	if (abs < 86_400) return [Math.round(seconds / 3600), "hour"];
	return [Math.round(seconds / 86_400), "day"];
}

export type Trend = "up" | "down" | "neutral";

/**
 * Which way the arrow points.
 *
 * `null` when there is no comparable previous period — on a fresh install
 * there genuinely is no history, and a "neutral" arrow would claim
 * "unchanged", which is a different and false statement.
 */
export function trendOf(current: number, previous: number | null): Trend | null {
	if (previous === null) return null;
	if (current > previous) return "up";
	if (current < previous) return "down";
	return "neutral";
}

/**
 * The comparison sentence under a stat.
 *
 * Growth from zero has no percentage — the honest phrasing is "up from
 * none", not "+Infinity%".
 */
export function comparisonText(current: number, previous: number | null, locale?: string): string {
	const lang = langOf(locale);
	if (previous === null) return t(lang, "noEarlierPeriod");
	if (previous === 0 && current === 0) return t(lang, "noneEitherPeriod");
	if (previous === 0) return t(lang, "upFromNone");
	const ratio = (current - previous) / previous;
	const change = new Intl.NumberFormat(lang, {
		style: "percent",
		signDisplay: "exceptZero",
		maximumFractionDigits: Math.abs(ratio) < 0.01 ? 1 : 0,
	}).format(ratio);
	return t(lang, "vsPrevious", { change });
}

/** A UTC day, written the reader's way: "18 Sept 2026", "18.09.2026". */
export function formatDay(day: string, locale?: string): string {
	const ms = Date.parse(`${day}T00:00:00.000Z`);
	if (Number.isNaN(ms)) return day;
	try {
		return new Intl.DateTimeFormat(langOf(locale), { dateStyle: "medium", timeZone: "UTC" }).format(ms);
	} catch {
		return day;
	}
}

/**
 * Suffix marking numbers the provider estimated rather than counted.
 *
 * Silence here is what makes an editor compare the widget with the
 * provider's dashboard and trust neither. Umami counts every page view, so
 * only demo data, which imitates a sampling provider, is ever marked.
 */
export function qualifier(
	opts: { estimated?: boolean; provisional?: boolean; provider?: string },
	locale?: string,
): string {
	const lang = langOf(locale);
	const notes: string[] = [];
	if (opts.estimated) notes.push(t(lang, "estimatedSampled"));
	if (opts.provisional) notes.push(t(lang, "todayCounting"));
	return notes.join(" · ");
}

/** A rate between 0 and 1 as a whole percentage: "77 %" in German, "77%" in English. */
export function formatPercent(rate: number, locale?: string): string {
	try {
		return new Intl.NumberFormat(langOf(locale), { style: "percent", maximumFractionDigits: 0 }).format(rate);
	} catch {
		return `${Math.round(rate * 100)}%`;
	}
}

/** Seconds as the reader says them: "45 s", "1 min 23 s". */
export function formatDuration(seconds: number, locale?: string): string {
	const lang = langOf(locale);
	const whole = Math.max(0, Math.round(seconds));
	if (whole < 60) return t(lang, "durationSeconds", { seconds: whole });
	return t(lang, "durationMinutes", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

/** A ratio to two decimals in the reader's notation: "2.07", "2,07". */
export function formatRatio(value: number, locale?: string): string {
	try {
		return new Intl.NumberFormat(langOf(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
	} catch {
		return value.toFixed(2);
	}
}

/**
 * The comparison sentence for a rate. A change in a percentage is given in
 * points: from 87.5 % to 77 % is 10.5 points down, which a relative change
 * of 12 % would hide.
 */
export function pointsText(current: number, previous: number | null, locale?: string): string {
	const lang = langOf(locale);
	if (previous === null) return t(lang, "noEarlierPeriod");
	const points = (current - previous) * 100;
	const change = new Intl.NumberFormat(lang, { signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(points);
	return t(lang, "pointsVsPrevious", { change });
}
