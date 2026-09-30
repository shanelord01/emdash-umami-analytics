/**
 * The beacon, injected at build time.
 *
 * Not a `page:fragments` hook, deliberately. The documented EmDash example
 * for analytics uses that hook and calls `ctx.settings.get()` inside the
 * handler, which is one uncached `SELECT` per render — and the handler can
 * run three times on a content page with an SEO panel, because
 * `resolveSeoPanelPage()` returns a fresh context object and the only memo
 * is a `WeakMap` keyed on that object. A baseline anonymous `GET /` is ten
 * queries; that example adds one to three of them forever, on every
 * anonymous request. Four of the thirteen shipped templates also render no
 * body placements at all, so `body:end` silently does nothing there.
 *
 * `injectScript("head-inline")` costs zero queries, emits verbatim into
 * `<head>`, and is the stage every maintained Astro analytics integration
 * uses. The plugin registers no page hook whatsoever, which is what keeps
 * `pnpm query-counts` flat.
 */

export type BeaconProvider = "umami";

export interface AnalyticsBeaconOptions {
	/** Whose tracker to inject. Umami's is the only one, named so the option does not have to change later. */
	provider?: BeaconProvider;
	/**
	 * The website ID, the `data-website-id` value in Umami's tracking code.
	 * The CMS side of this plugin takes the same value.
	 */
	websiteId?: string;
	/**
	 * Where the tracker script is served. Umami Cloud's unless set; a
	 * self-hosted Umami serves it at `https://your-host/script.js`.
	 */
	scriptUrl?: string;
	/**
	 * Hostnames the tracker may report from (`data-domains`). On any other
	 * host, a preview deploy for one, it stays silent.
	 */
	domains?: string[];
	/**
	 * Gate the beacon behind a consent event.
	 *
	 * With this set the injected code registers a listener and appends the
	 * vendor script only once the event fires (or immediately if the
	 * documented flag says consent was already given). The vendor loader is
	 * never injected behind an ungranted gate — a "cookieless" claim is not
	 * a settled defence under TDDDG §25 in Germany, and this integration
	 * provides the gate rather than an opinion.
	 */
	consent?: {
		/** Event dispatched on `window` once analytics consent is granted. */
		event: string;
		/**
		 * Name of a global boolean or a function on `window` that reports
		 * consent already granted, checked once at load.
		 */
		grantedFlag?: string;
	};
	/**
	 * Inject during `astro dev`. Off by default: a dev server reports under
	 * the same website ID as production and would pollute real numbers with
	 * localhost traffic.
	 */
	includeDev?: boolean;
	/**
	 * Environment variable that must equal `"true"` for the beacon to be
	 * injected. Use it to keep preview deploys out of production numbers:
	 * a preview build carries the same website ID as the real domain.
	 */
	productionFlagEnv?: string;
}

const UMAMI_SCRIPT_SRC = "https://cloud.umami.is/script.js";

/** The admin lives here and its pages have their own `<head>`. */
const ADMIN_PREFIX = "/_emdash";

/**
 * Minimal shape of what Astro hands an integration, declared locally so
 * this file needs no `astro` import at runtime. Astro's own types are
 * structurally compatible.
 */
export interface AstroIntegrationLike {
	name: string;
	hooks: {
		"astro:config:setup": (options: {
			command: "dev" | "build" | "preview" | "sync";
			injectScript: (stage: "head-inline" | "before-hydration" | "page" | "page-ssr", content: string) => void;
			logger: { warn: (message: string) => void; info: (message: string) => void };
		}) => void;
	};
}

export function analyticsBeacon(options: AnalyticsBeaconOptions = {}): AstroIntegrationLike {
	const provider = options.provider ?? "umami";

	return {
		name: "emdash-umami-analytics/astro",
		hooks: {
			"astro:config:setup": ({ command, injectScript, logger }) => {
				if (provider !== "umami") {
					logger.warn(`Unknown analytics provider "${provider}"; no beacon injected.`);
					return;
				}

				// A missing website ID is named out loud rather than no-op'd: a
				// silent no-op here is a site that collects nothing and looks
				// fine, which is the failure mode nobody notices for weeks.
				if (!options.websiteId) {
					logger.warn(
						"analyticsBeacon(): no `websiteId` given, so no beacon was injected. Pass the Umami website ID (the `data-website-id` value in Umami's tracking code).",
					);
					return;
				}

				if (command === "dev" && !options.includeDev) {
					logger.info("analyticsBeacon(): skipping injection under `astro dev`. Pass includeDev: true to override.");
					return;
				}

				if (options.productionFlagEnv) {
					const value = readEnv(options.productionFlagEnv);
					if (value !== "true") {
						logger.info(
							`analyticsBeacon(): ${options.productionFlagEnv} is not "true", so no beacon was injected.`,
						);
						return;
					}
				}

				injectScript("head-inline", buildBeaconScript(options));
			},
		},
	};
}

/**
 * The injected source.
 *
 * Exported so it can be tested as a string: this is the one piece of this
 * plugin that runs in a visitor's browser, and it must never throw there.
 */
export function buildBeaconScript(options: AnalyticsBeaconOptions): string {
	// The tracker script and the attributes it reads its configuration from.
	const src = options.scriptUrl || UMAMI_SCRIPT_SRC;
	const attributes: Array<[string, string]> = [
		["data-website-id", options.websiteId ?? ""],
		...(options.domains?.length ? [["data-domains", options.domains.join(",")] as [string, string]] : []),
	];

	// Every value becomes a JavaScript string literal with `<` escaped:
	// `</script>` inside an inline script would otherwise end the element
	// early.
	const literal = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");
	const adminLiteral = JSON.stringify(ADMIN_PREFIX);

	const inject = `
		var s = document.createElement("script");
		s.defer = true;
		s.src = ${literal(src)};${attributes
			.map(
				([name, value]) => `
		s.setAttribute(${literal(name)}, ${literal(value)});`,
			)
			.join("")}
		(document.head || document.documentElement).appendChild(s);`;

	const gate = options.consent
		? `
		var granted = false;
		try {
			var flag = ${JSON.stringify(options.consent.grantedFlag ?? "")};
			if (flag) {
				var value = window[flag];
				granted = typeof value === "function" ? !!value() : !!value;
			}
		} catch (e) {}
		if (granted) { load(); }
		else { window.addEventListener(${JSON.stringify(options.consent.event)}, load, { once: true }); }`
		: `
		load();`;

	// Everything is wrapped: an exception thrown from an inline head script
	// blocks nothing else on the page, but it does land in the console of
	// every visitor, which is not a thing to ship.
	return `(function () {
	try {
		var p = location.pathname;
		// Editor sessions are not site traffic. The admin is an injected
		// Astro page with its own <head>, so without this every dashboard
		// visit would be counted and /_emdash paths would show up in the
		// top-pages table.
		if (p === ${adminLiteral} || p.indexOf(${adminLiteral} + "/") === 0) return;
		var loaded = false;
		function load() {
			if (loaded) return;
			loaded = true;${inject}
		}${gate}
	} catch (e) {}
})();`;
}

function readEnv(name: string): string | undefined {
	const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
	const fromMeta = meta.env?.[name];
	if (fromMeta !== undefined) return fromMeta;
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return proc?.env?.[name];
}

export default analyticsBeacon;
