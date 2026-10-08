## 0.1.3, 9 October 2026

- Days follow your time zone. They were UTC days, so a page view before about 10 am in Sydney counted on the day before. A new Time zone setting takes an IANA name and starts at Australia/Sydney. Set the website's zone in Umami.
- On update the stored daily numbers, site totals and per-entry views are cleared once and read again from Umami, newest first, back to Keep daily rows for. Charts and views per entry refill over the catch-up: about two hours for 90 days and 100 entries on Node, at the Cron Trigger's pace on Cloudflare Workers. Changing the setting later does the same.
- The registry page has tabs, including this changelog, and a banner.
- Admin fixes: no false "no page is matched", the dashboard's top pages cover its 7 days, and the daily chart names its series.
- No new permissions. The MCP tools now describe their days in your time zone, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

## 0.1.2, 1 October 2026

- Engagement beside the totals: bounce rate, average visit and pages per visit against the period before, on the Analytics page (with a chart each for bounce rate and visit time), on the dashboard card and in the `site_totals` MCP tool. Days stored by an earlier version are read again in the background.
- Read-through per entry, for sites that send a custom event as a reader reaches each depth. Four new settings, off by default. It shows on the Analytics per entry page, in the editor panel and as reads by day on the Analytics page.
- Faster catch-up: while catching up, each sync step starts the next about a minute later.
- Two new Umami endpoints: `/websites/{id}/event-data/values` and `/websites/{id}/events/series`, used only with read-through on.
- The `site_totals` answer gained an `engagement` field. Turn Agent access on again under Plugins after the update.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-umami-analytics/blob/main/CHANGELOG.md).
