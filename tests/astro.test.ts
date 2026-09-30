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
		const { injectScript } = run({ token: "tok" });
		expect(injectScript).toHaveBeenCalledTimes(1);
		expect(injectScript.mock.calls[0]![0]).toBe("head-inline");
	});

	it("warns and injects nothing without a token", () => {
		// A silent no-op here is a site that collects nothing and looks fine.
		const { injectScript, warn } = run({});
		expect(injectScript).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toMatch(/token/);
		// And it names the token/tag confusion, which is the actual trap.
		expect(warn.mock.calls[0]![0]).toMatch(/not the site tag/i);
	});

	it("skips astro dev by default", () => {
		// A dev server reports under the same site tag as production.
		const { injectScript, info } = run({ token: "tok" }, "dev");
		expect(injectScript).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalled();
	});

	it("injects in dev when asked explicitly", () => {
		const { injectScript } = run({ token: "tok", includeDev: true }, "dev");
		expect(injectScript).toHaveBeenCalledTimes(1);
	});

	it("respects a production flag env var", () => {
		const name = "ANALYTICS_TEST_PROD_FLAG";
		delete process.env[name];
		expect(run({ token: "tok", productionFlagEnv: name }).injectScript).not.toHaveBeenCalled();

		process.env[name] = "false";
		expect(run({ token: "tok", productionFlagEnv: name }).injectScript).not.toHaveBeenCalled();

		process.env[name] = "true";
		expect(run({ token: "tok", productionFlagEnv: name }).injectScript).toHaveBeenCalledTimes(1);
		delete process.env[name];
	});

	it("refuses an unknown provider rather than guessing", () => {
		const { injectScript, warn } = run({ provider: "plausible" as "cloudflare", token: "tok" });
		expect(injectScript).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});
});

describe("the injected script", () => {
	it("is syntactically valid JavaScript", () => {
		// It runs in every visitor's browser; a syntax error is not something
		// a type-checker would have caught.
		const code = buildBeaconScript({ token: "tok" });
		expect(() => new Function(code)).not.toThrow();
	});

	it("bails out on the admin before creating anything", () => {
		const code = buildBeaconScript({ token: "tok" });
		expect(code).toContain('"/_emdash"');
		expect(code).toMatch(/indexOf\("\/_emdash" \+ "\/"\) === 0/);
	});

	it("actually skips injection on an admin path when executed", () => {
		expect(runInFakeDom(buildBeaconScript({ token: "tok" }), "/_emdash/admin/dashboard").appended).toBe(0);
		expect(runInFakeDom(buildBeaconScript({ token: "tok" }), "/_emdashboard/").appended).toBe(1);
		expect(runInFakeDom(buildBeaconScript({ token: "tok" }), "/blog/").appended).toBe(1);
	});

	it("carries the token in the beacon attribute", () => {
		const dom = runInFakeDom(buildBeaconScript({ token: "abc123" }), "/");
		expect(dom.attributes["data-cf-beacon"]).toBe('{"token":"abc123"}');
		expect(dom.src).toBe("https://static.cloudflareinsights.com/beacon.min.js");
		expect(dom.defer).toBe(true);
	});

	it("only emits spa when explicitly disabled", () => {
		expect(runInFakeDom(buildBeaconScript({ token: "t" }), "/").attributes["data-cf-beacon"]).toBe('{"token":"t"}');
		expect(runInFakeDom(buildBeaconScript({ token: "t", spa: false }), "/").attributes["data-cf-beacon"]).toBe(
			'{"token":"t","spa":false}',
		);
	});

	it("cannot be terminated early by a crafted token", () => {
		// A token containing </script> would otherwise close the inline
		// element and dump the rest of the code into the document as text.
		const code = buildBeaconScript({ token: "a</script><script>alert(1)</script>" });
		expect(code).not.toContain("</script>");
		expect(() => new Function(code)).not.toThrow();
	});

	it("waits for the consent event when a gate is configured", () => {
		const code = buildBeaconScript({ token: "t", consent: { event: "emdash:consent:analytics" } });
		const dom = runInFakeDom(code, "/");
		expect(dom.appended).toBe(0);
		expect(dom.listeners["emdash:consent:analytics"]).toHaveLength(1);

		dom.listeners["emdash:consent:analytics"]![0]!();
		expect(dom.appended).toBe(1);
	});

	it("injects immediately when the granted flag is already set", () => {
		const code = buildBeaconScript({
			token: "t",
			consent: { event: "emdash:consent:analytics", grantedFlag: "analyticsConsented" },
		});
		expect(runInFakeDom(code, "/", { analyticsConsented: true }).appended).toBe(1);
		expect(runInFakeDom(code, "/", { analyticsConsented: false }).appended).toBe(0);
		expect(runInFakeDom(code, "/", { analyticsConsented: () => true }).appended).toBe(1);
	});

	it("never appends twice, however often the event fires", () => {
		const code = buildBeaconScript({ token: "t", consent: { event: "go" } });
		const dom = runInFakeDom(code, "/");
		dom.listeners["go"]![0]!();
		dom.listeners["go"]![0]!();
		expect(dom.appended).toBe(1);
	});

	it("swallows its own errors rather than logging in every visitor's console", () => {
		const code = buildBeaconScript({ token: "t" });
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

describe("the Umami beacon", () => {
	const umami = { provider: "umami" as const, websiteId: "11111111-2222-4333-8444-555555555555" };

	it("loads Umami Cloud's tracker with the website ID and nothing of Cloudflare's", () => {
		const dom = runInFakeDom(buildBeaconScript(umami), "/");
		expect(dom.appended).toBe(1);
		expect(dom.src).toBe("https://cloud.umami.is/script.js");
		expect(dom.attributes).toEqual({ "data-website-id": umami.websiteId });
	});

	it("limits the tracker to the named hostnames", () => {
		const dom = runInFakeDom(buildBeaconScript({ ...umami, domains: ["example.com", "www.example.com"] }), "/");
		expect(dom.attributes["data-domains"]).toBe("example.com,www.example.com");
	});

	it("needs a website ID, not a token, and says so when it is missing", () => {
		expect(run(umami).injectScript).toHaveBeenCalledTimes(1);

		const { injectScript, warn } = run({ provider: "umami", token: "tok" });
		expect(injectScript).not.toHaveBeenCalled();
		expect(warn.mock.calls[0]![0]).toMatch(/websiteId/);
	});

	it("skips the admin and waits for consent like the Cloudflare beacon", () => {
		expect(runInFakeDom(buildBeaconScript(umami), "/_emdash/admin").appended).toBe(0);

		const dom = runInFakeDom(buildBeaconScript({ ...umami, consent: { event: "go" } }), "/");
		expect(dom.appended).toBe(0);
		dom.listeners["go"]![0]!();
		expect(dom.appended).toBe(1);
	});

	it("cannot be terminated early by a crafted value", () => {
		const code = buildBeaconScript({ ...umami, websiteId: "a</script><script>alert(1)</script>" });
		expect(code).not.toContain("</script>");
		expect(() => new Function(code)).not.toThrow();
	});
});
