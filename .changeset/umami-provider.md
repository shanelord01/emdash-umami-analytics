---
"@eisbachcode/emdash-plugin-analytics": minor
---

Adds Umami Cloud as a data source, next to Cloudflare Web Analytics and demo data.

To use it, set **Data source** to Umami and enter an API key and the website ID. Create the key under a view-only Umami user who can see only that website: an Umami key can do whatever its user can. Umami lists no website for such a user, so the ID has to be typed in. Switching the data source clears the stored numbers, as it always has.

Umami counts every day exactly, so nothing is labelled as estimated, and the plugin reads your earlier days from Umami as well, back to **Keep daily rows for**. That history arrives one day per step: three days every two hours at the default sync interval, so 90 days take about two and a half days.

The `./astro` beacon integration takes `provider: "umami"` with a `websiteId`, and optionally `domains`.

Sites on Cloudflare Web Analytics need to do nothing: their settings, stored numbers and sync are unchanged.
