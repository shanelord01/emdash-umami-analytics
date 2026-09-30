import { validateBlocks } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GRAPHQL_ENDPOINT } from "../src/providers/cloudflare.js";
import type { SyncState } from "../src/sync/scheduler.js";

/**
 * End-to-end through the real sandbox: the plugin is built, loaded into
 * workerd and driven through the production host bridge.
 *
 * Two things about this harness, both of which cost time to find:
 *
 * - A collection must be created with `routable: true`. `getPublicUrl()`
 *   checks `collectionInfo.routable` and answers `null` without it, so the
 *   index silently stays empty and it reads as a plugin bug rather than a
 *   missing fixture field. `urlPattern` alone is not enough.
 * - `actions.content.*` do fire the plugin hooks, but deferred through
 *   `after()`: nothing awaits them and `dispose()` does not drain them, so
 *   a test that ends early leaves hook work running against a torn-down
 *   database. Fixtures therefore come from `fixtures.content()`, which
 *   writes the row without firing anything, and hooks are driven with
 *   `transport.invokeHook()`. The one test of the real pipeline waits for
 *   the last effect it produces.
 *
 * Plugin storage also outlives `dispose()` within a file, so assertions
 * here name the row they are about instead of counting the collection.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

async function newHost() {
	return await createPluginRuntimeTestHost({
		site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
	});
}

/** A host with one routable collection holding one genuinely published entry. */
async function hostWithEntry(title = "Hello", opts: { routable?: boolean; slug?: string } = {}) {
	const runtime = await newHost();
	const collection = opts.routable === false ? "notes" : "posts";
	await runtime.fixtures.collection({
		slug: collection,
		label: "Entries",
		...(opts.routable === false ? {} : { urlPattern: "/blog/{slug}" }),
		routable: opts.routable !== false,
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	const item = await runtime.fixtures.content(collection, {
		slug: opts.slug ?? "hello",
		data: { title },
		status: "published",
		publishedAt: new Date().toISOString(),
	});
	return { runtime, id: item.id, collection, title };
}

/** Fire the hook the host would have fired for a real publish. */
async function firePublish(runtime: PluginRuntimeTestHost, collection: string, id: string, title: string) {
	await runtime.transport.invokeHook("content:afterPublish", { collection, content: { id, title } });
}

describe("scheduling without an Enable click", () => {
	it("schedules both tasks from the widget's first page load", async () => {
		// The PoC's own acceptance row, and the fix for the review's first
		// blocker: `plugin:activate` is dispatched only by the admin Enable
		// endpoint, so a site that registers the plugin through `plugins: []`
		// never gets one. Nothing here calls activate.
		host = await newHost();

		await expect(host.inspect.scheduledTasks()).resolves.toEqual([]);

		await host.admin.loadWidget("traffic");

		const tasks = await host.inspect.scheduledTasks();
		expect(tasks.map((t) => String(t.name))).toEqual(expect.arrayContaining(["sync", "reconcile"]));
		expect(tasks.find((t) => t.name === "sync")?.schedule).toBe("*/15 * * * *");
		expect(tasks.find((t) => t.name === "reconcile")?.schedule).toBe("10 3 * * *");
	});

	it("schedules from a content save as well", async () => {
		const { runtime, id, collection, title } = await hostWithEntry();
		host = runtime;
		await runtime.transport.invokeHook("content:afterSave", {
			collection,
			content: { id, title },
			isNew: false,
		});
		const tasks = await runtime.inspect.scheduledTasks();
		expect(tasks.map((t) => String(t.name))).toContain("sync");
	});

	it("schedules even when indexing the entry fails", async () => {
		// Scheduling comes first in the handler precisely so a content-access
		// problem cannot leave the plugin permanently unscheduled.
		host = await newHost();
		await host.transport.invokeHook("content:afterSave", {
			collection: "does-not-exist",
			content: { id: "nope" },
			isNew: true,
		});
		expect((await host.inspect.scheduledTasks()).map((t) => String(t.name))).toContain("sync");
	});

	it("does not duplicate a task when every entry point fires", async () => {
		// `CronAccess.schedule` upserts on (plugin, task); this asserts the
		// upsert rather than trusting the documentation.
		const { runtime, id, collection, title } = await hostWithEntry();
		host = runtime;
		await runtime.admin.loadWidget("traffic");
		await runtime.transport.invokeHook("content:afterSave", { collection, content: { id, title }, isNew: true });
		await runtime.admin.loadWidget("traffic");

		const tasks = await runtime.inspect.scheduledTasks();
		expect(tasks.filter((t) => t.name === "sync")).toHaveLength(1);
	});
});

describe("the widget through the sandbox", () => {
	it("emits Block Kit the host accepts", async () => {
		host = await newHost();
		const response = await host.admin.loadWidget("traffic");
		// The host validates the response itself before returning it, so
		// reaching this line already proves it passed; asserting makes the
		// intent explicit.
		expect(validateBlocks(response.blocks).valid).toBe(true);
	});

	it("explains that the first sync has not run instead of showing zeroes", async () => {
		host = await newHost();
		const response = await host.admin.loadWidget("traffic");
		expect(JSON.stringify(response.blocks)).toMatch(/first sync has not run/i);
	});

	it("renders for an editor, not only for an admin", async () => {
		// The route declares `plugins:read`. Without that declaration
		// dispatch falls back to `plugins:manage` and every editor gets a
		// widget card that 403s before the plugin runs at all.
		host = await newHost();
		const editor = await host.fixtures.user({ email: "editor@example.test", role: "editor" });
		const response = await host.admin.loadWidget("traffic", { user: editor });
		expect(validateBlocks(response.blocks).valid).toBe(true);
	});

	it("offers a refresh button", async () => {
		host = await newHost();
		const response = await host.admin.loadWidget("traffic");
		expect(JSON.stringify(response.blocks)).toContain("analytics:refresh");
	});
});

describe("the refresh button", () => {
	it("names the missing credential rather than failing silently", async () => {
		host = await newHost();
		const response = await host.admin.act("widget:traffic", "analytics:refresh");

		expect(validateBlocks(response.blocks).valid).toBe(true);
		expect(response.toast?.type).toBe("error");
		expect(String(response.toast?.message)).toMatch(/not configured yet/i);
		expect(String(response.toast?.message)).toMatch(/Account Analytics/);
	});

	it("asks for a tick instead of syncing inside the request", async () => {
		// A sync phase and a render do not both fit in one sandboxed
		// invocation's ten bridge calls, so the button schedules the tick.
		host = await newHost();
		await host.fixtures.plugin.setting("provider", "demo");
		const today = new Date().toISOString().slice(0, 10);

		const response = await host.admin.act("widget:traffic", "analytics:refresh");
		expect(response.toast).toMatchObject({ type: "success" });
		expect(String(response.toast?.message)).toMatch(/requested/i);
		await expect(host.inspect.storage.get("rollup", today)).resolves.toBeNull();

		host.scheduled.setTime(new Date());
		await host.scheduled.run();

		await expect(host.inspect.storage.get("rollup", today)).resolves.not.toBeNull();
		expect((await host.inspect.scheduledTasks()).map((t) => String(t.name))).not.toContain("refresh");
	});
});

describe("a tick without credentials", () => {
	it("records the error in state so the next render can show it", async () => {
		host = await newHost();
		await host.transport.invokeHook("cron", { name: "sync", scheduledAt: new Date().toISOString() });

		const state = await host.inspect.kv.get<SyncState>("state");
		expect(state?.lastError).toMatch(/not configured yet/i);
		expect(state?.lastErrorAt).toBeTruthy();

		const response = await host.admin.loadWidget("traffic");
		expect(JSON.stringify(response.blocks)).toMatch(/not configured yet/i);
	});

	it("never calls Cloudflare", async () => {
		// `api.cloudflare.com` is the only allowed host and there is no token,
		// so the tick must fail on configuration before it opens a socket.
		host = await newHost();
		await host.transport.invokeHook("cron", { name: "sync", scheduledAt: new Date().toISOString() });
		expect(host.http.requests()).toEqual([]);
	});
});

describe("the path to entry index", () => {
	it("stores the published URL as the join key, with the site's trailing slash", async () => {
		const { runtime, id, collection, title } = await hostWithEntry();
		host = runtime;
		await firePublish(runtime, collection, id, title);

		// What the site actually serves has to be what the index stores, or
		// the provider's reported path never matches and every entry reads
		// zero while the dashboard looks perfectly healthy.
		await expect(runtime.inspect.content.publicUrl("posts", id)).resolves.toBe("https://example.test/blog/hello/");

		const row = await runtime.inspect.storage.get<{
			path: string;
			collection: string;
			entryId: string;
			status: string;
			views7: number;
		}>("entries", "/blog/hello/");

		expect(row).toMatchObject({
			path: "/blog/hello/",
			collection: "posts",
			entryId: id,
			status: "published",
			views7: 0,
		});
	});

	it("keeps the title so the widget can show more than a path", async () => {
		const { runtime, id, collection, title } = await hostWithEntry("Hello World");
		host = runtime;
		await firePublish(runtime, collection, id, title);
		const row = await runtime.inspect.storage.get<{ title: string }>("entries", "/blog/hello/");
		expect(row?.title).toBe("Hello World");
	});

	it("marks an unpublished entry rather than forgetting it", async () => {
		// Past traffic stays attributable to the entry that earned it.
		const { runtime, id, collection, title } = await hostWithEntry();
		host = runtime;
		await firePublish(runtime, collection, id, title);
		await runtime.transport.invokeHook("content:afterUnpublish", { collection, content: { id } });

		// The row survives, marked — it is not deleted.
		const row = await runtime.inspect.storage.get<{ status: string; entryId: string }>("entries", "/blog/hello/");
		expect(row).toMatchObject({ entryId: id, status: "unpublished" });
	});

	it("indexes nothing for a collection that is not routable", async () => {
		// An entry with no public URL has no page to attribute traffic to,
		// and inventing one would poison the join.
		const { runtime, id, collection, title } = await hostWithEntry("Private", { routable: false, slug: "private" });
		host = runtime;
		await firePublish(runtime, collection, id, title);

		await expect(runtime.inspect.content.publicUrl(collection, id)).resolves.toBeNull();

		const rows = await runtime.inspect.storage.list<{ collection: string }>("entries");
		expect(rows.some((r) => r.data.collection === collection)).toBe(false);
	});

	it("indexes an entry published through EmDash itself, with no test-fired hook", async () => {
		const runtime = await newHost();
		host = runtime;
		await runtime.fixtures.collection({
			slug: "posts",
			label: "Entries",
			urlPattern: "/blog/{slug}",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const created = await runtime.actions.content.create("posts", { slug: "live", data: { title: "Live" } });
		if (!created.success) throw new Error(created.error.message);
		const id = created.data.item.id;
		await runtime.actions.content.publish("posts", id);

		await vi.waitFor(async () => {
			await expect(runtime.inspect.storage.get("entries", "/blog/live/")).resolves.toMatchObject({
				entryId: id,
				status: "published",
			});
			expect((await runtime.inspect.scheduledTasks()).map((t) => String(t.name))).toContain("sync");
		});
	});
});

describe("the manifest the host actually loaded", () => {
	it("declares the capabilities, storage and route permission it needs", async () => {
		host = await newHost();
		const manifest = host.manifest as unknown as {
			capabilities: string[];
			allowedHosts: string[];
			storage: Record<string, { indexes: string[] }>;
			routes?: Array<{ name: string; permission?: string }>;
		};

		expect(manifest.capabilities).toEqual(["content:read", "schema:read", "network:request"]);
		expect(manifest.allowedHosts).toEqual(["api.cloudflare.com", "api.umami.is"]);
		expect(Object.keys(manifest.storage).sort()).toEqual(["daily", "entries", "rollup"]);
		// Sorting the content page by these needs them declared as indexes.
		expect(manifest.storage.entries!.indexes).toEqual(
			expect.arrayContaining(["path", "collection", "entryId", "translationGroup", "views30", "views7"]),
		);
		expect(manifest.routes?.find((r) => r.name === "admin")?.permission).toBe("plugins:read");
	});
});

describe("the analytics page on day one", () => {
	it("shows the provider's numbers before any sync has run", async () => {
		// Waiting for the store would take hours to days on a fresh install,
		// while the provider's own dashboard answers at once.
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		host = await newHost();
		await host.actions.plugin.updateSettings({ cfApiToken: "cfat_test", cfAccountId: "acct-1", cfSiteTag: "tag-1" });
		const today = new Date().toISOString().slice(0, 10);
		await host.http.respond(
			GRAPHQL_ENDPOINT,
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									totals: [{ count: 4321, sum: { visits: 1234 }, avg: { sampleInterval: 1 } }],
									series: [{ count: 4321, sum: { visits: 1234 }, avg: { sampleInterval: 1 }, dimensions: { date: today } }],
									pages: [{ count: 999, sum: { visits: 500 }, avg: { sampleInterval: 1 }, dimensions: { requestPath: "/blog/hello/" } }],
									refs: [{ count: 10, sum: { visits: 9 }, dimensions: { refererHost: "news.example" } }],
									geo: [],
								},
							],
						},
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
		);

		const response = await host.admin.act("/analytics", "analytics:range", { value: 7 });
		const text = JSON.stringify(response.blocks);
		expect(text).toContain("/blog/hello/");
		expect(text).toContain("news.example");
		expect(text).not.toMatch(/No analytics yet/);
		await expect(host.inspect.storage.list("rollup")).resolves.toEqual([]);
	});

	it("never asks for more than the exact window, whatever the range", async () => {
		// A sampled 30-day answer put a week's 25 page views on one day as
		// 300. Older days come from the store or are not shown.
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		host = await newHost();
		await host.actions.plugin.updateSettings({ cfApiToken: "cfat_test", cfAccountId: "acct-1", cfSiteTag: "tag-1" });
		const empty = { data: { viewer: { accounts: [{ totals: [], series: [], pages: [], refs: [], geo: [] }] } } };
		await host.http.respond(GRAPHQL_ENDPOINT, new Response(JSON.stringify(empty), { headers: { "Content-Type": "application/json" } }));

		await host.admin.act("/analytics", "analytics:range", { value: 30 });

		const body = JSON.parse(new TextDecoder().decode(host.http.requests()[0]!.body)) as { variables: { since: string } };
		const exactStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
		expect(body.variables.since).toBe(exactStart);
	});
});
