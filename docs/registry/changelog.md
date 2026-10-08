## 0.1.3, 9 October 2026

- The registry page has tabs (description, installation, FAQ, changelog and security) and a banner.
- No changes to the plugin itself, no new permissions and no MCP tool output changes.

## 0.1.2, 1 October 2026

- Engagement beside the totals: bounce rate, average visit and pages per visit against the period before, on the Analytics page (with a chart each for bounce rate and visit time), on the dashboard card and in the `site_totals` MCP tool. Days stored by an earlier version are read again in the background.
- Read-through per entry, for sites that send a custom event as a reader reaches each depth. Four new settings, off by default. It shows on the Analytics per entry page, in the editor panel and as reads by day on the Analytics page.
- Faster catch-up: each sync step starts the next about a minute later while catching up. On Cloudflare Workers the pace is set by the site's Cron Trigger.
- Two new Umami endpoints: `/websites/{id}/event-data/values` and `/websites/{id}/events/series`, used only with read-through on.
- The `site_totals` answer gained an `engagement` field, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-umami-analytics/blob/main/CHANGELOG.md).
