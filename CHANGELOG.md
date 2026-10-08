# emdash-umami-analytics

## 0.1.3

The settings form follows the order of setup, with plain labels and an example in every description. The Umami API URL is a URL field with a placeholder, and a Read-through switch (on by default, so existing settings keep working) turns read-through off without clearing its fields. Setting keys are unchanged.

Days follow the site's time zone. Every day was a UTC day, so on a Sydney site a page view before about 10 am (11 am in daylight time) was counted on the day before: a view at 8:15 am on 27 September landed on the 26th. EmDash gives a sandboxed plugin no site time zone, so a new Time zone setting takes an IANA name, starts at `Australia/Sydney`, and falls back to it for a name that is not recognised. Set it to the website's time zone in Umami. The setting has the same key, label and default as in Buffer Plus.

Each day is asked of Umami as that local day: `startAt` and `endAt` are its first and last millisecond in the zone, so the day the clocks change is 23 or 25 hours long. `stats`, `metrics/expanded` and `events/series` also get `timezone`, which they accept. `events/series` buckets read-through by it, where it had `UTC` before. The event data routes take no `timezone` and get none. Charts place each day at its local midnight, and the analytics page, the dashboard card, the per-entry page and the MCP tools count today in the zone.

What happens on update: the first sync finds a store keyed in UTC (0.1.2 recorded no zone) and clears it before anything else. It deletes the `rollup` and `daily` rows, frozen ones included, and resets each entry's views (`views7`, `views30` and their parts) to zero, a few hundred rows per run. With a scheduler each run starts the next about a minute later. Entries, the content index and settings stay. Then the overview reads today and yesterday, and the history pass reads every earlier day again, newest first, back to Keep daily rows for, while the paths tick refills the views per entry. Read-through is read again too. Until the catch-up ends, charts are shorter and views per entry lower than before: on Node about two hours for 90 days and 100 entries, on Cloudflare Workers at the Cron Trigger's pace. Changing the Time zone setting later clears and refills the same way.

The registry page has tabs: description, installation, FAQ, changelog and security, from the files in `docs/registry/`. It also has a banner, drawn at the registry's 3:1 shape so link previews show it whole.

No new permissions, and the new setting needs no approval. The MCP tools' descriptions now say their days are in the Time zone setting, not UTC (`src/tools/declare.ts`: the day field, `until`, and the `days` window of `top_entries` and `site_totals`). That changes the manifest's `mcp.tools`, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

## 0.1.2

Engagement beside the totals: bounce rate, average visit and pages per visit, against the period before, on the Analytics page (with a chart each for bounce rate and visit time by day), on the dashboard card and in the `site_totals` MCP tool. It comes with each day's totals at no extra request. Days stored by an earlier version are read again in the background.

Read-through per entry, for sites that send a custom event as a reader reaches each depth of an entry: four new settings, off by default. It shows on the Analytics per entry page, in the editor panel and as reads by day on the Analytics page. The sync reads it with `/websites/{id}/event-data/values` and `/websites/{id}/events/series`, new among the endpoints the plugin requests.

Faster catch-up: while catching up, each sync step starts the next about a minute later. On Node a fresh install with 90 days of history and 100 entries is caught up in about two hours. On Cloudflare Workers the pace is set by the site's Cron Trigger.

The `site_totals` tool's answer gained an `engagement` field, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

## 0.1.1

The Analytics page shows page views by the event data your site attaches to them, starting with a "Views by category" table. The property names come from the new Views by event data setting (`category` unless changed), up to three, so section, tag or byline tables are a setting away. A value sent as a comma-separated list, such as tags, counts once for each part. A site that sends no event data sees nothing new.

The tables are read from Umami with the page, in the same five requests: the page now takes yesterday's totals from its own store. They count page views on every hostname the website reports, and they appear only while Umami answers. Values are shown as the site sends them, usually slugs.

Umami's `/websites/{id}/event-data/events` endpoint is new among those the plugin requests. If a sign-in proxy guards your Umami, let it through as well.

## 0.1.0

First release. Umami analytics on the EmDash dashboard and next to your content, for Umami Cloud and for a self-hosted Umami from 3.4.0:

- a Traffic widget on the dashboard, with visits and page views for the last seven days and the five most viewed pages
- an Analytics page with a daily chart, top entries, referrers and countries over 7, 30 or 90 days, and a setup check that names the fix for each thing the numbers depend on
- a per-entry page and an editor panel with each entry's page views over 7 and 30 days, translations included
- four read-only MCP tools that answer from the stored numbers
- an Astro integration that injects Umami's tracking script, with a consent gate
- demo data, for trying the plugin without an Umami website

Derived from `@eisbachcode/emdash-plugin-analytics` 0.3.0 by Eisbachcode, under the same MIT licence. That plugin reads Cloudflare Web Analytics. This one reads Umami instead.
