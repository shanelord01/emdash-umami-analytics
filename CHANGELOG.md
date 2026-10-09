# emdash-umami-analytics

## 0.1.3

The admin pages, the dashboard card and the editor panel are named after Umami, so they are not mistaken for another plugin's: Analytics is now Umami Analytics, Analytics per entry is Umami per entry, the Traffic card is Umami traffic and the Analytics panel beside the editor is Umami. The pages keep their paths (`/analytics` and `/analytics/content`), so bookmarks still work, and links, buttons and messages that name them, in English and German, use the new names.

The settings form follows the order of setup, with plain labels and an example in every description. The Umami API URL is a URL field with a placeholder, and a Read-through switch (on by default, so existing settings keep working) turns read-through off without clearing its fields. Setting keys are unchanged.

Days follow the site's time zone. Every day was a UTC day, so on a Sydney site a page view before about 10 am (11 am in daylight time) was counted on the day before: a view at 8:15 am on 27 September landed on the 26th. EmDash gives a sandboxed plugin no site time zone, so a new Time zone setting takes an IANA name, starts at `Australia/Sydney`, and falls back to it for a name that is not recognised. Set it to the website's time zone in Umami. The setting has the same key, label and default as in Buffer Plus.

Each day is asked of Umami as that local day: `startAt` and `endAt` are its first and last millisecond in the zone, so the day the clocks change is 23 or 25 hours long. `stats`, `metrics/expanded` and `events/series` also get `timezone`, which they accept. `events/series` buckets read-through by it, where it had `UTC` before. The event data routes take no `timezone` and get none. Charts place each day at its local midnight, and the analytics page, the dashboard card, the per-entry page and the MCP tools count today in the zone.

What happens on update: the first sync finds a store keyed in UTC (0.1.2 recorded no zone) and clears it before anything else. It deletes the `rollup` and `daily` rows, frozen ones included, and resets each entry's views (`views7`, `views30` and their parts) to zero, a few hundred rows per run. With a scheduler each run starts the next about a minute later. Entries, the content index and settings stay. Then the overview reads today and yesterday, and the history pass reads every earlier day again, newest first, back to Keep daily rows for, while the paths tick refills the views per entry. Read-through is read again too. Until the catch-up ends, charts are shorter and views per entry lower than before: on Node about two hours for 90 days and 100 entries, on Cloudflare Workers at the Cron Trigger's pace. Changing the Time zone setting later clears and refills the same way.

Fixes in the admin pages:

- The dashboard card and the Umami Analytics page said "no page is matched to an entry yet" on a site whose entries were all matched. The check counted only the entries the index walk added itself, and on a site that published after installing the plugin, the publish hooks had added every entry first, so the count stayed at 0. The sync state now keeps `matched`, the published entries stored in the index, counted by the index walk and again by every paths pass from the rows they already read, at no extra request. Check setup reports the same count. A state from 0.1.2 is counted by the next paths pass.
- The 7, 30 and 90-day buttons shared one action id, which drew React's "two children with the same key" warning. Each has its own (`analytics:range:7`), and the plain `analytics:range` with the range in its value still works. First page on Umami per entry had the same id as the button of the current language mode beside it, and has its own as well.
- Top entries on the Umami Analytics page and Umami per entry could show different "last 30 days" for one entry. Top entries asks the provider for the whole range. Umami per entry adds up the days stored in the site, which start when the plugin started reading them (demo data: about a week before install). While the stored days do not reach back far enough, its column is headed with the day they start ("Since Oct 2, 2026") and a note says why Top entries can show more. Top entries says its figures are the provider's. The editor panel labels its figures the same way, "Page views since Oct 2, 2026" in place of "last 30 days", and so do its translations table and its all-languages total. That costs the panel one more storage read, four bridge calls in all.
- On the dashboard card, the five most viewed pages showed 90-day totals under the 7-day cards after the first demo sync, whose backfill reads 90 days. A backfill no longer stores the pages, and the card shows them only when they cover the cards' week.
- Visit times such as "1 min 8 s" keep together on one line.
- Paths on Umami per entry are plain text. As code they could not wrap at a slash and were the widest column when the table was squeezed, pushing it past the right margin on a narrow window.
- The daily chart names its series under it ("Blue: Page views · Yellow: Visits"), as does the reads chart. EmDash draws no chart legend, so each series is given its colour.

The registry page has tabs: description, installation, FAQ, changelog and security, from the files in `docs/registry/`. It also has a banner, drawn at the registry's 3:1 shape so link previews show it whole.

No new permissions, and neither the new setting nor the new names need approval: a page label, a card title and a panel title are not part of `mcp.tools`. The MCP tools' descriptions now say their days are in the Time zone setting, not UTC (`src/tools/declare.ts`: the day field, `until`, and the `days` window of `top_entries` and `site_totals`). That changes the manifest's `mcp.tools`, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

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
