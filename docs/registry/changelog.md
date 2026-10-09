## 0.1.3, 9 October 2026

- Days follow your time zone. They were UTC days, so a page view before about 10 am in Sydney counted on the day before. The new Time zone setting starts at Australia/Sydney. Set the website's zone in Umami.
- On update the stored numbers are cleared once and read again from Umami, newest first. Charts and views per entry refill over the catch-up: about two hours for 90 days and 100 entries on Node, at the Cron Trigger's pace on Cloudflare Workers. Changing the setting later does the same.
- Named after Umami, so they are not taken for another plugin's: the Umami Analytics and Umami per entry pages (same addresses), the Umami traffic card and the Umami editor panel.
- The registry page has tabs, including this changelog, and a banner.
- Admin fixes: no false "no page is matched", the dashboard's top pages cover its 7 days, the daily chart names its series, and the editor panel names the day its stored history starts.
- No new permissions. The MCP tools now describe their days in your time zone, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

## 0.1.2, 1 October 2026

- Engagement beside the totals: bounce rate, average visit and pages per visit against the period before, on the Analytics page, the dashboard card and in the `site_totals` MCP tool.
- Read-through per entry, for sites that send a custom event as a reader reaches each depth. Four new settings, off by default. It shows on the Analytics per entry page, in the editor panel and as reads by day on the Analytics page.
- Faster catch-up after install.
- Two new Umami endpoints: `/websites/{id}/event-data/values` and `/websites/{id}/events/series`, used only with read-through on.
- The `site_totals` answer gained an `engagement` field. Turn Agent access on again under Plugins after the update.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-umami-analytics/blob/main/CHANGELOG.md).
