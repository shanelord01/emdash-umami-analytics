**Why does everything show zero?**
Most setup mistakes give zeroes and no error. Open Plugins > Analytics and select Check setup: it names the fix for each problem it finds.

**Why do my numbers differ from Umami's dashboard?**
Days are UTC, while Umami shows days in your timezone, so daily figures differ near midnight. Pages under `/_emdash` are left out, and the totals count only the hostnames in Hostnames to count (your site URL and its `www` form unless changed).

**Does it work with Umami Cloud?**
It follows Umami's published API, but has not been run against a Cloud account. Please report what you find in the repository's issues.

**My Umami sits behind a sign-in proxy.**
Let the plugin's eight Umami API endpoints through without it. The README lists them, and Umami checks the API key on each one.

**How many requests does it make?**
A sync makes at most seven requests to Umami. Opening the Analytics page makes five.

**Can I try it without Umami?**
Yes. Set Data source to Demo data and select Refresh on the dashboard card. It generates 90 days of made-up traffic over your real entries. Switching the data source clears every stored number, so demo figures never mix with real ones.

**Who can see the numbers?**
Editors and admins see the dashboard card, both Analytics pages and the MCP tools. Authors see the editor panel for their own entries.

**Where do the category tables come from?**
From event data your site attaches to its page views with the Umami tracker's `data-before-send` hook. Name up to three properties in Views by event data. A site that sends none sees no tables.

**How does read-through work?**
Your site sends a custom event as a reader reaches each depth of an entry, for example `post_read` with `post` and `depth`. Fill in the four Read-through settings to match. They are empty by default, which turns it off.

**Which languages does it speak?**
English and German, following each user's admin language.
