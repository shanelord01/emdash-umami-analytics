import { describe, expect, it, vi } from "vitest";

import { analyticsBeacon, buildBeaconScript } from "../src/astro/index.js";

type Setup = Parameters<ReturnType<typeof analyticsBeacon>["hooks"]["astro:config:setup"]>[0];

function run(options: Parameters<typeof analyticsBeacon>[0], command: Setup["command"] = "build") {
	const injectScript = vi.fn();
	const warn = vi.fn();
	const info = vi.fn();
	analyticsBeacon(options).hooks["astro:config:setup"]({
		command,
		injectScript,
		logger: { warn, info },
	});
	return { injectScript, warn, info };
}

describe("when the beacon is injected", () => {
	it("injects at head-inline on a build", () => {
		const { injectScript } = run({ websiteId: "site-1" });
		expect(injectScript).toHaveBeenCalledTimes(1);
		expect(injectScript.mock.calls[0]![0]).toBe("head-inline");
	});

	it("warns and injects nothing without a website ID", () => {
		// A silent no-op here is a site that collects nothing and looks fine.
		const { injectScript, warn } = run({});
		expect(injectScript).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		// And it says where the value is found.
		expect(warn.mock.calls[0]![0]).toMatch(/websiteId/);
		expect(warn.mock.calls[0]![0]).toMatch(/data-website-id/);
	});

	it("skips astro dev by default", () => {
		// A dev server reports under the same website ID as production.
		const { injectScript, info } = run({ websiteId: "site-1" }, "dev");
		expect(injectScript).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalled();
	});

	it("injects in dev when asked explicitly", () => {
		const { injectScript } = run({ websiteId: "site-1", includeDev: true }, "dev");
		expect(injectScript).toHaveBeenCalledTimes(1);
	});

	it("respects a production flag env var", () => {
		const name = "ANALYTICS_TEST_PROD_FLAG";
		delete process.env[name];
		expect(run({ websiteId: "site-1", productionFlagEnv: name }).injectScript).not.toHaveBeenCalled();

		process.env[name] = "false";
		expect(run({ websiteId: "site-1", productionFlagEnv: name }).injectScript).not.toHaveBeenCalled();

		process.env[name] = "true";
		expect(run({ websiteId: "site-1", productionFlagEnv: name }).injectScript).toHaveBeenCalledTimes(1);
		delete process.env[name];
	});

	it("refuses an unknown provider rather than guessing", () => {
		const { injectScript, warn } = run({ provider: "plausible" as "umami", websiteId: "site-1" });
		expect(injectScript).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});
});

describe("the injected script", () => {
	it("is syntactically valid JavaScript", () => {
		// It runs in every visitor's browser; a syntax error is not something
		// a type-checker would have caught.
		const code = buildBeaconScript({ websiteId: "site-1" });
		expect(() => new Function(code)).not.toThrow();
	});

	it("bails out on the admin before creating anything", () => {
		const code = buildBeaconScript({ websiteId: "site-1" });
		expect(code).toContain('"/_emdash"');
		expect(code).toMatch(/indexOf\("\/_emdash" \+ "\/"\) === 0/);
	});

	it("actually skips injection on an admin path when executed", () => {
		expect(runInFakeDom(buildBeaconScript({ websiteId: "site-1" }), "/_emdash/admin/dashboard").appended).toBe(0);
		expect(runInFakeDom(buildBeaconScript({ websiteId: "site-1" }), "/_emdashboard/").appended).toBe(1);
		expect(runInFakeDom(buildBeaconScript({ websiteId: "site-1" }), "/blog/").appended).toBe(1);
	});

	it("loads Umami Cloud's tracker with the website ID and nothing else", () => {
		const dom = runInFakeDom(buildBeaconScript({ websiteId: "abc123" }), "/");
		expect(dom.attributes).toEqual({ "data-website-id": "abc123" });
		expect(dom.src).toBe("https://cloud.umami.is/script.js");
		expect(dom.defer).toBe(true);
	});

	it("loads a self-hosted tracker and limits it to the named hostnames", () => {
		const dom = runInFakeDom(
			buildBeaconScript({
				websiteId: "abc123",
				scriptUrl: "https://stats.example.com/script.js",
				domains: ["example.com", "www.example.com"],
			}),
			"/",
		);
		expect(dom.src).toBe("https://stats.example.com/script.js");
		expect(dom.attributes["data-domains"]).toBe("example.com,www.example.com");
	});

	it("cannot be terminated early by a crafted value", () => {
		// A value containing </script> would otherwise close the inline
		// element and dump the rest of the code into the document as text.
		for (const crafted of [{ websiteId: "a</script><script>alert(1)</script>" }, { websiteId: "a", scriptUrl: "https://x.example/</script>" }]) {
			const code = buildBeaconScript(crafted);
			expect(code).not.toContain("</script>");
			expect(() => new Function(code)).not.toThrow();
		}
	});

	it("waits for the consent event when a gate is configured", () => {
		const code = buildBeaconScript({ websiteId: "site-1", consent: { event: "emdash:consent:analytics" } });
		const dom = runInFakeDom(code, "/");
		expect(dom.appended).toBe(0);
		expect(dom.listeners["emdash:consent:analytics"]).toHaveLength(1);

		dom.listeners["emdash:consent:analytics"]![0]!();
		expect(dom.appended).toBe(1);
	});

	it("injects immediately when the granted flag is already set", () => {
		const code = buildBeaconScript({
			websiteId: "site-1",
			consent: { event: "emdash:consent:analytics", grantedFlag: "analyticsConsented" },
		});
		expect(runInFakeDom(code, "/", { analyticsConsented: true }).appended).toBe(1);
		expect(runInFakeDom(code, "/", { analyticsConsented: false }).appended).toBe(0);
		expect(runInFakeDom(code, "/", { analyticsConsented: () => true }).appended).toBe(1);
	});

	it("never appends twice, however often the event fires", () => {
		const code = buildBeaconScript({ websiteId: "site-1", consent: { event: "go" } });
		const dom = runInFakeDom(code, "/");
		dom.listeners["go"]![0]!();
		dom.listeners["go"]![0]!();
		expect(dom.appended).toBe(1);
	});

	it("swallows its own errors rather than logging in every visitor's console", () => {
		const code = buildBeaconScript({ websiteId: "site-1" });
		const fn = new Function("location", "document", "window", code);
		const hostileDocument = {
			createElement() {
				throw new Error("nope");
			},
		};
		// The script must not propagate a DOM failure: an exception from an
		// inline head script blocks nothing, but it does land in the console
		// of every visitor.
		expect(() => fn({ pathname: "/" }, hostileDocument, {})).not.toThrow();
	});
});

/**
 * Executes the injected script against a minimal fake DOM and reports what
 * it did. Testing the string is not enough — the point is the behaviour in
 * a browser.
 */
function runInFakeDom(code: string, pathname: string, windowExtras: Record<string, unknown> = {}) {
	const state = {
		appended: 0,
		src: "",
		defer: false,
		attributes: {} as Record<string, string>,
		listeners: {} as Record<string, Array<() => void>>,
	};

	const element = {
		set src(value: string) {
			state.src = value;
		},
		get src() {
			return state.src;
		},
		set defer(value: boolean) {
			state.defer = value;
		},
		get defer() {
			return state.defer;
		},
		setAttribute(name: string, value: string) {
			state.attributes[name] = value;
		},
	};

	const document = {
		createElement: () => element,
		head: {
			appendChild: () => {
				state.appended++;
			},
		},
		documentElement: {
			appendChild: () => {
				state.appended++;
			},
		},
	};

	const windowObj: Record<string, unknown> = {
		...windowExtras,
		addEventListener(event: string, handler: () => void) {
			(state.listeners[event] ??= []).push(handler);
		},
	};

	const fn = new Function("location", "document", "window", code);
	fn({ pathname }, document, windowObj);
	return state;
}
