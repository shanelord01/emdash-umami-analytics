# emdash-umami-analytics

## 0.1.0

First release. Umami analytics on the EmDash dashboard and next to your content, for Umami Cloud and for a self-hosted Umami from 3.4.0:

- a Traffic widget on the dashboard, with visits and page views for the last seven days and the five most viewed pages
- an Analytics page with a daily chart, top entries, referrers and countries over 7, 30 or 90 days, and a setup check that names the fix for each thing the numbers depend on
- a per-entry page and an editor panel with each entry's page views over 7 and 30 days, translations included
- four read-only MCP tools that answer from the stored numbers
- an Astro integration that injects Umami's tracking script, with a consent gate
- demo data, for trying the plugin without an Umami website

Derived from `@eisbachcode/emdash-plugin-analytics` 0.3.0 by Eisbachcode, under the same MIT licence. That plugin reads Cloudflare Web Analytics. This one reads Umami instead.
