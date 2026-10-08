# Umami Analytics for EmDash

Shows your Umami numbers inside the EmDash admin: site traffic on the
dashboard, and page views next to the entries that earned them. It works
with Umami Cloud and with a self-hosted Umami.

The plugin only reads. It needs a Umami API key, and it never changes
anything in Umami or in your content.

It is tested with a self-hosted Umami 3.4.0. The Umami Cloud connection
is untested: it follows Umami's published API, and has not been run
against a Cloud account. If you use it with Umami Cloud, please report
what you find in the repository's issues.

## What's new

**0.1.3, 9 October 2026**
- Days follow your time zone. They were UTC days, so a view before about
  10 am in Sydney counted on the day before. The new Time zone setting
  starts at Australia/Sydney.
- On update the stored numbers are cleared once and read again from
  Umami, newest first. Charts and views per entry refill over the
  catch-up: about two hours for 90 days and 100 entries on Node, longer
  on Cloudflare Workers.
- The registry page has tabs (description, installation, FAQ, changelog
  and security) and a banner.
- The MCP tools now describe their days in your time zone, so EmDash
  turns Agent access off after the update. Turn it on again under
  Plugins.

**0.1.2, 1 October 2026**
- Engagement: bounce rate, average visit and pages per visit beside the
  totals, with charts on the Analytics page.
- Read-through: how many readers reach halfway and the end of each post,
  for sites that send a read event.
- Faster catch-up after install: a few hours instead of a few days.

**0.1.1, 1 October 2026**
- Views by category on the Analytics page, from the event data your site
  attaches to its page views. Section, tags or byline can be added in
  settings.

**0.1.0, 30 September 2026**
- First release: Umami traffic on the dashboard, an Analytics page with a
  setup check, views per entry, an editor panel and MCP tools.

## What it adds to the admin

| Where | What you see |
|---|---|
| Dashboard | A Traffic card: visits, page views and engagement for the last seven days against the week before, the five most viewed pages with their entries, and the time of the last sync |
| Plugins > Analytics | Visits and page views over 7, 30 or 90 days with a daily chart, bounce rate and visit time with a chart each, top entries, referrers and countries, page views by the event data your site attaches (by category, to start with), reads by day, a link to the website in Umami, and a setup check |
| Plugins > Analytics per entry | Every published entry with its page views over 7 and 30 days and its read-through, sortable, by collection or across all of them. Translated content can be shown with its languages combined |
| Entry editor | An Analytics panel with that entry's 7 and 30 day page views, how far readers get, and the path they are counted at |
| MCP | Four read-only tools that give an AI agent the same numbers |

## What you need

| | |
|---|---|
| EmDash | 1.0.1 or later, with a plugin sandbox runner configured (registry plugins run in the sandbox) |
| Umami | A self-hosted Umami 3.4.0 or later (3.4.0 is the first self-hosted release with API keys), or Umami Cloud, which is untested |
| A website in Umami | with Umami's tracking script already on your site |
| An API key | see "Create the Umami key" below |
| `EMDASH_ENCRYPTION_KEY` | set on the site, so the API key can be stored encrypted. `npx emdash secrets generate` makes one |
| URL patterns | each collection needs a URL Pattern (under Content Types), or pages cannot be matched to entries |
| Scheduled tasks | the sync runs as a plugin cron task. On Node, EmDash runs it. On Cloudflare Workers it needs the Cron Trigger from EmDash's Cloudflare deployment guide |

## Install

1. In the EmDash admin, open Registry.
2. Search for `@shane.bsky.shas.am/emdash-umami-analytics` and open it.
3. Review the permissions and select Install.

The plugin asks for three permissions: read content, read the schema, and
make network requests to any public host. The last one is needed because
the address of a self-hosted Umami is something you type into the
settings, so it cannot be fixed in advance. The plugin only ever requests
the Umami API URL from its settings.

## Create the Umami key

An Umami API key has no permissions of its own. It can do whatever the
user who created it can do, so create it under a user made for this.

1. In Umami, create a user with the role View only.
2. Add that user to the team that holds your website, with the team role
   View only. If the website belongs to you and not to a team, move it to
   a team first.
3. Sign in to Umami as that user and create a key under Settings > API
   keys.

A key made this way can read the websites of that team and change
nothing. A key made under an admin user could change or delete every
website, so do not use one here.

## Settings

Open Plugins in the admin, then the plugin's settings.

| Setting | What to enter |
|---|---|
| Data source | Umami. Demo data is for trying the plugin without Umami (see below) |
| Umami API URL | For your own Umami, its address with `/api` on the end, such as `https://analytics.example.com/api`. The default is Umami Cloud's address, which is untested |
| Umami API key | The key from the step above. It is stored encrypted |
| Umami website ID | The ID from the website's settings in Umami. If you leave it empty, the dashboard card lists the websites the key can see so you can copy one |
| Hostnames to count | Leave empty to count your site URL and its `www` form. Enter a comma-separated list to count other hostnames |
| Time zone | The zone your days are counted in, as an IANA name such as `Australia/Sydney` (the default), `Europe/Berlin` or `UTC`. Use the website's time zone in Umami. A name that is not recognised counts as `Australia/Sydney`. Changing it clears the stored numbers, which are then read again |
| Break down page views by | `category` by default. Up to three event data properties your site attaches to its page views, comma-separated, for example `category, section`. Leave it empty to show none. See "Views by event data" below |
| Read-through | On by default. Turn it off to stop reading it without clearing the four fields that follow |
| Reading event, Post property, Progress property, Reading milestones | Empty by default, which means no read-through. See "Read-through" below |
| Sync every | 15 minutes by default |
| Keep daily history for | 90 days by default, 400 at most. The plugin reads this far back from Umami after install |
| Entries per sync step | 36 by default. Lower it to write fewer database rows per day |

After saving, open Plugins > Analytics and select Check setup. It runs
through everything the numbers depend on, from the key to the scheduled
sync, and gives one sentence for each problem it finds. Most setup
mistakes produce zeroes and no error, so run it if the numbers look
empty.

## Self-hosted Umami

The Umami API has to be reachable on a public hostname. EmDash does not
let a plugin request a private address, so `localhost`, a LAN address or
a VPN-only name will not work.

If a sign-in proxy sits in front of your Umami, let the eight endpoints
below through without it. Umami checks the API key on each of them.

## What the plugin requests

Eight `GET` endpoints of the Umami API, each with the API key as a Bearer
token.

| Endpoint | Used for |
|---|---|
| `/websites/{id}/stats` | one day's page views, visits and visitors |
| `/websites/{id}/metrics/expanded` | pages, referrers, countries and hostnames |
| `/websites/{id}/event-data/events` | page views by event data value, when the Analytics page opens |
| `/websites/{id}/event-data/values` | read events per entry, during the sync, only with read-through on |
| `/websites/{id}/events/series` | read events per day, during the sync, only with read-through on |
| `/websites` | listing websites, only while no website ID is set or during a setup check |
| `/me/teams` | listing the key's teams, only while no website ID is set |
| `/teams/{id}/websites` | listing a team's websites, only while no website ID is set |

A sync makes at most seven requests. Opening the Analytics page makes
five.

## How the numbers are made

Umami answers for one day per request, so the plugin reads a day at a
time and stores what it reads in your site's database.

Today is read on every sync and is labelled as still counting. Earlier
days are read once each, newest first, back to the Keep daily history
for setting, and the chart grows backwards while they arrive. Per-entry views
over 7 and 30 days are sums of those stored days plus today.

While the plugin is catching up (matching your entries to their pages,
reading earlier days, or reading read-through for the first time), each
sync step starts the next one about a minute later instead of waiting for
the next scheduled sync. On Node, 90 days of history and a site of 100
entries take about two hours. On Cloudflare Workers a step started this
way waits for the site's next Cron Trigger, so catching up there runs at
the trigger's pace. Once caught up, the plugin syncs at the Sync every
interval only.

Engagement (bounce rate, average visit and pages per visit) comes with
each day's totals, so it costs no extra request. Days stored before
version 0.1.2 have none until the plugin reads them again, and are left
out of the figures, never counted as zero.

The Analytics page also asks Umami directly each time it opens, so it
shows numbers from the first minute after setup.

When you compare with Umami's own dashboard:

- Days are calendar days in the Time zone setting. Umami's dashboard
  shows days in the website's time zone, so set the same zone in both or
  daily figures differ near midnight.
- Visits are Umami's visits. Visitors are not shown yet.
- The referrers table lists referring sites only. Visits that arrived
  without a referrer are in the totals and in no row of that table.
- Pages under `/_emdash` are left out of every number.
- A day with 10,000 or more distinct paths is more than the plugin reads.
  It reports that and stores nothing for that day.

## Views by event data

Umami can store extra values with each page view, such as the category of
the blog post being read. When your site sends them, the Analytics page
shows how many page views carried each value, one table for each property
named in the Break down page views by setting. The default is `category`.

Your site attaches the values with the Umami tracker's `data-before-send`
hook. A page view is an `event` payload without a `name`:

```html
<script defer src="https://your-umami/script.js"
  data-website-id="your-website-id"
  data-before-send="addPageData"></script>
<script>
  function addPageData(type, payload) {
    if (type === "event" && !payload.name) {
      payload.data = { category: document.body.dataset.category };
    }
    return payload;
  }
</script>
```

How the tables count:

- Each table shows the ten most common values in the chosen range, as
  your site sends them, usually slugs such as `our-trips`.
- A value with commas counts once for each part, so `tags` sent as
  `towing,queensland` counts once for each tag. Any value with a comma is
  split, so send names that can contain one as slugs.
- The counts cover every hostname the website reports. The Hostnames to
  count setting does not apply to them.
- Page views from before your site started sending a property carry
  nothing, so a longer range counts only the days since.
- A property no page view carries shows no table and no error.

The tables are read from Umami each time the Analytics page opens, in one
request. They are not on the dashboard card, and when Umami cannot be
reached the page shows its stored numbers without them. Umami 3.4 has no
request made for counting page views by these values, so the plugin uses
its event data request with filters that select page views. If a later
Umami release changes how those filters combine, the tables come back
empty until the plugin is updated.

## Read-through

If your site sends a custom event as a reader reaches each part of an
entry, the plugin shows how far readers get: on the Analytics per entry
page beside each entry's 30-day views, in the editor panel as a bar per
depth against the entry's views, and as reads by day on the Analytics
page.

Set the four reading fields, below the Read-through switch, to match your event, for example:

| Setting | Example |
|---|---|
| Reading event | `post_read` |
| Post property | `post`, holding the entry's slug (the last part of its path) or its path |
| Progress property | `depth` |
| Reading milestones | `half, end`, in reading order, up to three |

Your site sends the event with the tracker, for example
`umami.track("post_read", { post: "my-post", depth: "half" })` when a
reader passes halfway. Send each depth once per visit.

The sync reads the counts every six hours and stores them, so the pages
and the panel ask Umami nothing. Per-entry counts cover the last 30 days.

## Demo data

Set Data source to Demo data and select Refresh on the dashboard card.
The plugin generates 90 days of made-up traffic over your real entries
and runs it through the same sync and storage as real data. The card says
"Demo data, not real traffic" while it is on. Switching the data source
clears every stored number, so demo figures never mix with real ones.

## Who sees the numbers

| Surface | Roles |
|---|---|
| Dashboard card and both Analytics pages | Editors and admins |
| Entry editor panel | Authors for their own entries, editors and admins for every entry |
| MCP tools | The same as the Analytics pages |

Authors and contributors still see the Traffic card on the dashboard,
with a permission message inside it. EmDash shows every dashboard card to
every role and checks the permission when the card loads.

## MCP tools

| Tool | Answers |
|---|---|
| `top_entries` | The most viewed published entries over 7 or 30 days, optionally for one collection |
| `unviewed_entries` | Published entries without a view in 7 or 30 days |
| `entry_views` | One entry's 7 and 30 day views, found by ID or by path, with its translations |
| `site_totals` | Site visits, page views and engagement over 7, 30 or 90 days against the period before |

To use them, open the plugin under Plugins and turn on Agent access.
EmDash turns it off again after an update that changes a tool, so check
it after updating.
EmDash lists each tool with the plugin's ID in front of its name. A token
needs the `mcp:tools` scope, or the scope for this plugin alone, and its
user needs to be an editor or admin.

The tools read what the sync stored and never call Umami. Each answer
says which days it covers, where stored history starts and when the last
sync ran.

## Languages

The card, the pages, the editor panel and every message are in English
and German, following each user's admin language. Other admin languages
get English. The sidebar entry, the card title and the settings form stay
in English, because EmDash shows those itself.

## Privacy

The plugin sends the API key, the website ID and the hostnames to count
to the Umami API URL in its settings. Nothing from your content leaves
the site. The numbers it reads are stored in your site's own database.

Where visitor data is kept is decided by your Umami: the region of your
Umami Cloud account, or wherever you host your own.

## Not in this version

- A tested Umami Cloud connection. See the note at the top.
- Visitors. Umami counts them, and no page shows them yet.
- Referrers and countries for longer ranges when Umami cannot be reached.
  The Analytics page reads them from Umami, and falls back to the last
  sync's week.
- A views column in EmDash's content list.
- Fast catch-up on Cloudflare Workers, where a step waits for the next
  Cron Trigger.
- Views by event data on the dashboard card, display names for the
  values, and tables limited by a second value (for example categories of
  blog posts only).
- Screenshots.

## Attribution

This plugin is based on the EmDash analytics plugin by
[Eisbachcode](https://eisbachcode.de),
[eisbachcode/emdash-plugin-analytics](https://github.com/eisbachcode/emdash-plugin-analytics),
which is MIT licensed. The dashboard card, the pages, the content index,
the sync and its storage come from that plugin. This plugin reads Umami
as its data source.

## Licence

MIT. See `LICENSE`.
