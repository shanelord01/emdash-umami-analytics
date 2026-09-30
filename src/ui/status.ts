/**
 * The sentences the widget and the analytics page share: how fresh the
 * numbers are, what is wrong if anything is, and why a store is empty.
 */

import { langOf, problemText, t } from "../i18n.js";
import type { SyncState } from "../sync/scheduler.js";
import { formatAge, qualifier } from "./format.js";

/**
 * One line saying how fresh the numbers are and what is wrong, if
 * anything. Every failure mode that would otherwise render as a dashboard
 * of zeroes should read as a sentence naming the fix.
 */
export function statusLine(
	state: SyncState,
	now: Date,
	locale: string | undefined,
	flags: { estimated?: boolean; provisional?: boolean; unmatched?: boolean },
): string | null {
	const lang = langOf(locale);
	const parts: string[] = [];
	if (state.provider === "demo") parts.push(t(lang, "demoData"));

	const age = formatAge(state.lastSync, now, lang);
	parts.push(age ? t(lang, "synced", { age }) : t(lang, "notSynced"));

	const marks = qualifier({ ...flags, provider: state.provider }, lang);
	if (marks) parts.push(marks);
	if (flags.unmatched && nothingMatched(state)) parts.push(t(lang, "nothingMatched"));

	const error = errorText(state, lang);
	if (error) {
		const errorAge = formatAge(state.lastErrorAt, now, lang);
		parts.push(
			errorAge ? t(lang, "lastAttemptFailedAge", { age: errorAge, error }) : t(lang, "lastAttemptFailed", { error }),
		);
	}

	return parts.length > 0 ? parts.join(" · ") : null;
}

export function emptyReason(state: SyncState, now: Date, locale: string | undefined): string {
	const lang = langOf(locale);
	const error = errorText(state, lang);
	if (error) return error;
	if (!state.lastSync) return t(lang, "firstSyncPending");
	const age = formatAge(state.lastSync, now, lang);
	return t(lang, "syncedNoViewsUmami", { age: age ?? t(lang, "recently") });
}

/** The stored failure in the reader's language; an unrecognized one as it came. */
function errorText(state: SyncState, lang: ReturnType<typeof langOf>): string | undefined {
	if (!state.lastError) return undefined;
	return state.lastProblem ? problemText(lang, state.lastProblem) : state.lastError;
}

/**
 * The index walk finished without matching a single entry. Paths still
 * show, untitled, so without saying so the numbers look plausible while
 * every per-entry figure stays empty.
 */
export function nothingMatched(state: SyncState): boolean {
	return Boolean(state.indexComplete) && (state.indexed ?? 0) === 0;
}
