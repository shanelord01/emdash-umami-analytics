## 0.1.4

- The pages sit in one Umami folder in the sidebar (Analytics, Per entry) on EmDash 1.2 and later. Their addresses are unchanged, and older EmDash lists them one by one.
- No new permissions and no change to the MCP tools.

## 0.1.3, 9 October 2026

- Days follow your time zone. They were UTC days, so a page view before about 10 am in Sydney counted on the day before. The new Time zone setting starts at Australia/Sydney. Set the website's zone in Umami.
- On update the stored numbers are cleared once and read again from Umami, newest first. Charts and views per entry refill over the catch-up: about two hours for 90 days and 100 entries on Node, at the Cron Trigger's pace on Cloudflare Workers. Changing the setting later does the same.
- Named after Umami, so they are not taken for another plugin's: the Umami Analytics and Umami per entry pages (same addresses), the Umami traffic card and the Umami editor panel.
- The registry page has tabs, including this changelog, and a banner.
- Admin fixes: no false "no page is matched", the dashboard's top pages cover its 7 days, the daily chart names its series, and the editor panel names the day its stored history starts.
- No new permissions. The MCP tools now describe their days in your time zone, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

## 0.1.2, 1 October 2026

- Engagement beside the totals: bounce rate, average visit and pages per visit against the period before, and a new `engagement` field in `site_totals`.
- Read-through per entry (four settings, off by default) and two new Umami endpoints used only with it on. Faster catch-up after install.
- Turn Agent access on again under Plugins after the update.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-umami-analytics/blob/main/CHANGELOG.md).
