# emdash-umami-analytics

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
