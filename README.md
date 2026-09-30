# Umami Analytics for EmDash

Umami analytics on the EmDash dashboard, and next to your content.

The plugin reads your numbers from Umami, on Umami Cloud or on your own
Umami, and keeps a `path → entry` index, so views are attributed to the
entry that earned them and not to a URL string.

> **Status: first release.** A dashboard widget, an Analytics page with a
> setup check, a per-entry page, an Analytics panel in the entry editor and
> four read-only MCP tools. Needs EmDash 1.0.1 or later. See "Not in this
> version".

## The dashboard widget

A **Traffic** card on the dashboard: visits and page views for the last
seven days against the week before, the five most viewed pages with the
entry they belong to, and when the numbers were last synced.

## The Analytics page

**Plugins → Analytics** in the admin sidebar, or "Open analytics" on the
dashboard widget. Editors and admins see it.

The page asks Umami live on every load, so it has numbers from the first
minute after setup and does not wait for the sync. If the live request
fails, the page shows the plugin's own store.

- Range: last 7, 30 or 90 days. Visits and page views with the change
  against the previous period of the same length, shown only once stored
  history reaches back that far.
- A daily chart of page views and visits. Days without a page view are
  left out, not drawn as zero.
- Top entries with path, and title and collection once the plugin has
  matched the page to an entry.
- Referrers and countries for the whole range.
- "Open in Umami" goes to the website in Umami.

## Check setup

**Check setup** on the Analytics page runs every check the numbers depend
on, in the order a fix has to happen: data source, API key, Umami access,
website ID, hostnames, site URL, content index, scheduled sync and last
sync. Each problem gets one sentence that names the fix.

Most setup mistakes do not fail, they produce zeroes: a website without the
tracking script, a hostname filter that leaves out the host Umami reports,
a site without a stored URL, a Worker without a Cron Trigger. None of them
raises an error the sync could report, which is why the check exists.

The check only reads. Values are entered in the plugin's settings form.
With a website ID set it makes one request to Umami, and a second when
Umami answers 401, because Umami gives that answer both for a key it does
not know and for a website the key's user may not view. The second request
tells the two apart. While no website ID is set it lists the websites to
choose from, which takes up to six requests.

## Analytics per entry

**Plugins → Analytics per entry**, or "Per entry" on the Analytics page.

Every published entry with its page views over the last 7 and 30 days,
today included, by collection or across all of them. Click a column header
to sort. Sorting ascending puts the entries nobody visited first, which a
list of visited paths cannot show. The publish date says when a small
number just means a young entry.

On a site with translations, each row also shows the 30-day total of all
its languages, and **Languages combined** shows one row per translated
piece of content with each language's share. That mode groups the first
300 entries in the chosen order and says so when there are more.

**Rebuild index** walks the site's content again. The plugin keeps its
page-to-entry index current from the content hooks and catches up on
existing content by itself. A rebuild is for a changed URL pattern or site
URL.

## The editor panel

In the entry editor, the **Analytics** panel shows that entry's 7- and
30-day page views and the path they are counted at, and on a translated
entry each language's numbers and their total. An entry that is not
published at a public URL says so.

## MCP tools

EmDash's MCP server can hand the same numbers to an AI agent. The plugin
declares four read-only tools:

| Tool | Answers |
|---|---|
| `emdash-umami-analytics__top_entries` | The most viewed published entries over 7 or 30 days, optionally for one collection |
| `emdash-umami-analytics__unviewed_entries` | Published entries without a single view in 7 or 30 days |
| `emdash-umami-analytics__entry_views` | One entry's 7- and 30-day views, found by id or by path, with its translations and their total |
| `emdash-umami-analytics__site_totals` | Site visits and page views over 7, 30 or 90 days, against the period before |

They read what the sync stored and never call Umami. Every answer names
its window in UTC days, where stored history starts, whether the content
index is complete and when the last sync ran, so an agent can say that the
data is thin.

To use them:

1. Under **Plugins**, open the plugin and turn on **Agent access** after
   reviewing the tools.
2. Call them as a user with `plugins:read` (editor and above), through a
   token with the `mcp:tools:emdash-umami-analytics` scope, or `mcp:tools`
   for every plugin's tools.

After an update that changes a tool, EmDash stops serving the tools until
they are approved again, but the switch stays on. Turn it off and on.

## What you need

| | |
|---|---|
| EmDash | `>=1.0.1` |
| Umami | Umami Cloud, or a self-hosted Umami 3.4.0 or later, the first release with API keys for self-hosted installs |
| A website in Umami | with the tracking script on the site |
| An API key | created in Umami under **Settings → API keys** |
| `EMDASH_ENCRYPTION_KEY` | set on the site, or the API key cannot be stored (`npx emdash secrets generate`) |
| URL patterns | each collection needs a **URL Pattern** (under Content Types), or no page can be matched to its entry. Sites made from EmDash's blog template start without them. The setup check says so |
| Scheduled tasks | the sync runs as a plugin cron task. On Cloudflare Workers that needs the Cron Trigger and `scheduled` handler from EmDash's Cloudflare deployment guide. On Node, EmDash runs them itself |

### The key, precisely

An Umami API key can do whatever its user can: a key has no scope of its
own. So create the key under a user made for this: a **view-only** user
who can see this one website and nothing else, which in Umami means a
view-only member of a team that holds only that website. A key made under
your own admin user could read, change and delete every website that user
can reach.

The list the widget and the setup check offer covers the user's own
websites and the websites of their teams, up to four teams, so such a user
finds the website there. The ID can also be copied from the website's
settings in Umami.

### Self-hosted Umami

Set **Umami API URL** to `https://your-host/api`. It has to be a public
hostname: EmDash refuses to let a plugin request a private address, so
`localhost`, a LAN address or a name that resolves to one will not work.
The error says so.

If a login proxy (Authelia, Cloudflare Access, an identity-aware proxy)
covers the whole Umami host, exempt the endpoints listed under "What the
plugin requests" from it. Otherwise the plugin gets the sign-in page where
it expects JSON, and says so.

## Install

The plugin registers in `astro.config.mjs`:

```js
// astro.config.mjs
import umamiAnalytics from "emdash-umami-analytics";

export default defineConfig({
  integrations: [
    emdash({
      // database, storage, ...
      sandboxed: [umamiAnalytics],
    }),
  ],
});
```

`sandboxed: []` runs it in EmDash's plugin sandbox, which needs a sandbox
runner. On Cloudflare that means the Workers Paid plan; see EmDash's
[plugin sandbox guide](https://docs.emdashcms.com/deployment/plugin-sandbox/).
Listing it under `plugins: [umamiAnalytics]` runs it in-process.

The package is not on npm yet. Until it is, build it from a checkout of
[the repository](https://github.com/shanelord01/emdash-umami-analytics)
(`pnpm install`, then `pnpm build`) and add that directory as a
dependency of the site.

When published to the EmDash registry, it installs from the admin as
`@shane.bsky.shas.am/emdash-umami-analytics`, with nothing to add to the
config.

## Settings

Fill these in under **Plugins**, in the plugin's settings.

| Setting | Notes |
|---|---|
| Data source | Umami, or **demo data**: generated numbers that need no Umami website (see below) |
| Umami API key | Stored encrypted (AES-GCM). Needs `EMDASH_ENCRYPTION_KEY`. Without it saving fails, and nothing is stored as plaintext. See "The key, precisely" |
| Umami website ID | Leave empty and the widget lists the websites of the key's user and of that user's teams. The ID can also be typed in |
| Umami API URL | Umami Cloud by default. For a self-hosted Umami, `https://your-host/api` |
| Hostnames to count | Comma-separated. Empty uses the site URL and its `www` form. Any other hostname the website reports, a preview deploy for one, is not counted |
| Sync every | 15 minutes by default |
| Keep daily rows for | 90 days by default, 400 at most. The first syncs read this far back from Umami |
| Paths per sync tick | 36 by default and at most: the most one tick can handle within a sandboxed invocation's ten subrequests. Lower it to write fewer database rows per day |

### Trying it without Umami

Set **Data source** to demo data and press Refresh on the dashboard widget.
Refresh schedules a sync and does not run one, so the numbers appear after
the next scheduled run: at once on Node, with the site's next Cron Trigger
on Cloudflare. The plugin generates 90 days of plausible traffic, spread
over your real entries plus two paths that are no entry, and runs it
through the same sync, storage and path-to-entry join as real data. The
widget says "Demo data, not real traffic" while it is on. Switching the
data source back clears every stored number, so demo figures never mix
with real ones.

## What the plugin requests

Five `GET` endpoints of the Umami API, each with
`Authorization: Bearer <API key>` and no other header of its own:

| Endpoint | Used for |
|---|---|
| `/websites/{id}/stats` | one day's page views, visits and visitors |
| `/websites/{id}/metrics/expanded` | pages, referrers, countries and hostnames |
| `/websites` | the user's own websites, only while no website ID is set or Umami answers 401 during a setup check |
| `/me/teams` | the user's teams, only while no website ID is set |
| `/teams/{id}/websites` | a team's websites, for up to four teams, only while no website ID is set |

A sync makes at most seven requests, every 15 minutes by default, and the
Analytics page five when it is opened.

## How the numbers are made

Umami does not sample: every count is exact, however old. The plugin never
labels an Umami number as estimated.

Umami has no request that returns several days' numbers day by day, so
the plugin reads one day per request and keeps what it has read:

- **Today** is read from Umami on every sync, and is labelled as still
  counting.
- **Closed days** are read once each, newest first, back to **Keep daily
  rows for**. While the plugin is catching up, those reads take three of
  every four syncs that would otherwise read per-entry numbers: three
  days every two hours at the default interval, so 90 days arrive in
  about two and a half days. The fourth keeps the per-entry numbers moving
  meanwhile, and the chart grows backwards. Once caught up, the only day
  left to read is the one that ended last night.
- **Per-entry views** over 7 and 30 days are sums of those stored days
  plus today. The 30-day figure counts from where stored history starts,
  and the per-entry page says where that is until it reaches 30 days.

Things to know when comparing with Umami's own dashboard:

- **Visits are Umami's visits.** Umami also counts visitors, which the
  plugin does not show yet.
- **Referrers have no direct line.** Umami lists referring domains only,
  so visits that arrived without a referrer are in the totals and in no
  row of the referrers table.
- **Days are UTC.** Umami's dashboard shows days in your timezone, so its
  daily figures differ from the plugin's near midnight.
- **Admin pages are left out.** The plugin excludes `/_emdash` paths from
  every number it reads.
- **10,000 paths or more in one day** is more than the plugin reads in one
  request. It reports that and does not store part of a day.

## The tracking script

If your site already carries Umami's tracking script, skip this.

```js
// astro.config.mjs
import { analyticsBeacon } from "emdash-umami-analytics/astro";

export default defineConfig({
  integrations: [
    analyticsBeacon({
      websiteId: process.env.UMAMI_WEBSITE_ID,
      scriptUrl: "https://your-host/script.js", // self-hosted; Umami Cloud without it
      domains: ["example.com", "www.example.com"], // optional
      productionFlagEnv: "IS_PRODUCTION", // optional
    }),
  ],
});
```

The website ID is the same value the plugin's settings take. `domains`
becomes Umami's `data-domains`: the tracker reports only from those
hostnames, which keeps preview deploys out at the source.

It injects at Astro's `head-inline` stage, which costs **zero database
queries**. The plugin registers no page hook at all, so your logged-out
request count does not change.

Three things it does on purpose:

- **Skips `/_emdash`.** The admin is an Astro page with its own `<head>`,
  so an injected tracker would count editor sessions and put `/_emdash/…`
  paths in your top pages.
- **Skips `astro dev`.** A dev server reports under the same website ID as
  production. Pass `includeDev: true` if you want it.
- **Warns when the website ID is missing**, because a site that quietly
  collects nothing looks fine for weeks.

Consent gating, if you need it:

```js
analyticsBeacon({
  websiteId: "…",
  consent: { event: "emdash:consent:analytics", grantedFlag: "analyticsOk" },
});
```

The tracker script is appended only once the event fires. Umami sets no
cookies. Whether that removes the need for consent depends on where your
visitors are, and it is not a settled question everywhere. This
integration gives you the gate. The decision is yours and this is not
legal advice.

CSP, if your site sets one: the script's host in `script-src` and in
`connect-src`.

## Who sees the numbers

The widget and both pages declare `plugins:read`, which is **editor and
above**.

The editor panel declares `content:edit_own`, and EmDash also checks that
the user may edit that entry: **authors see their own entries' numbers,
editors and admins every entry's**, contributors none.

The MCP tools declare `plugins:read` like the pages, so an agent acting for
an author gets a permission error from all of them.

Authors and contributors still see the widget card on the dashboard and
get a permission error inside it. EmDash renders every declared widget for
every role and checks the permission when the widget loads.

## Languages

The widget, both pages, the editor panel, toasts and error messages come in
English and German, following the administrator's admin language. Any other
admin language gets English. Number, date and country names follow the
same language, so a German admin reads "1.234", "18.09.2026" and
"Deutschland".

Labels declared in the manifest stay English everywhere: the sidebar
entry, the widget title and the settings form. EmDash renders those itself
and does not read plugin translations.

## Privacy and what leaves your site

The plugin sends the Umami API key, the website ID and the hostnames to
count to the Umami API URL in the settings, and nothing from your content.
It stores the numbers it reads in the site's own database.

Where visitor data is kept is decided by your Umami: Umami Cloud's region,
or wherever you host your own.

The plugin declares `network:request:unrestricted`, because the host of a
self-hosted Umami is typed into the settings and cannot be named in the
manifest. It requests only the API URL from its settings.

## Not in this version

- Visitors. Umami counts them and the plugin reads them, but no page
  shows them yet.
- Referrers and countries from the store. The Analytics page reads them
  live. When Umami cannot be reached, it shows the last sync's week only,
  because they are kept per sync and not per day.
- A Views column in the content list. EmDash lets only native admin code
  add one, which a sandboxed plugin cannot ship.
- Large sites catch up slowly. Every sync step fits EmDash's sandbox limit
  of ten calls, so the index walk, the history of earlier days and the
  per-path sync each handle a few dozen entries or one day per step.
- Screenshots in this README and in the registry listing.

## Attribution

This plugin is based on the EmDash analytics plugin by
[Eisbachcode](https://eisbachcode.de),
[eisbachcode/emdash-plugin-analytics](https://github.com/eisbachcode/emdash-plugin-analytics),
which is MIT licensed. The dashboard widget, the pages, the content
index, the sync and its storage come from that plugin. This plugin changes
the data source: it reads Umami where the original reads Cloudflare Web
Analytics, and adds what reading Umami needs.

## Licence

MIT. See `LICENSE`.
