# Umami Analytics for EmDash

Shows your Umami numbers inside the EmDash admin: site traffic on the
dashboard, and page views next to the entries that earned them. It works
with Umami Cloud and with a self-hosted Umami.

The plugin only reads. It needs a Umami API key, and it never changes
anything in Umami or in your content.

## What it adds to the admin

| Where | What you see |
|---|---|
| Dashboard | A Traffic card: visits and page views for the last seven days against the week before, the five most viewed pages with their entries, and the time of the last sync |
| Plugins > Analytics | Visits and page views over 7, 30 or 90 days with a daily chart, top entries, referrers and countries, a link to the website in Umami, and a setup check |
| Plugins > Analytics per entry | Every published entry with its page views over 7 and 30 days, sortable, by collection or across all of them. Translated content can be shown with its languages combined |
| Entry editor | An Analytics panel with that entry's 7 and 30 day page views and the path they are counted at |
| MCP | Four read-only tools that give an AI agent the same numbers |

## What you need

| | |
|---|---|
| EmDash | 1.0.1 or later, with a plugin sandbox runner configured (registry plugins run in the sandbox) |
| Umami | Umami Cloud, or a self-hosted Umami 3.4.0 or later. 3.4.0 is the first self-hosted release with API keys |
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
| Umami API key | The key from the step above. It is stored encrypted |
| Umami website ID | The ID from the website's settings in Umami. If you leave it empty, the dashboard card lists the websites the key can see so you can copy one |
| Umami API URL | Leave as it is for Umami Cloud. For a self-hosted Umami enter `https://your-host/api` |
| Hostnames to count | Leave empty to count your site URL and its `www` form. Enter a comma-separated list to count other hostnames |
| Sync every | 15 minutes by default |
| Keep daily rows for | 90 days by default, 400 at most. The plugin reads this far back from Umami after install |
| Paths per sync tick | 36 by default. Lower it to write fewer database rows per day |

After saving, open Plugins > Analytics and select Check setup. It runs
through everything the numbers depend on, from the key to the scheduled
sync, and gives one sentence for each problem it finds. Most setup
mistakes produce zeroes and no error, so run it if the numbers look
empty.

## Self-hosted Umami

The Umami API has to be reachable on a public hostname. EmDash does not
let a plugin request a private address, so `localhost`, a LAN address or
a VPN-only name will not work.

If a sign-in proxy sits in front of your Umami, let the five endpoints
below through without it. Umami checks the API key on each of them.

## What the plugin requests

Five `GET` endpoints of the Umami API, each with the API key as a Bearer
token.

| Endpoint | Used for |
|---|---|
| `/websites/{id}/stats` | one day's page views, visits and visitors |
| `/websites/{id}/metrics/expanded` | pages, referrers, countries and hostnames |
| `/websites` | listing websites, only while no website ID is set or during a setup check |
| `/me/teams` | listing the key's teams, only while no website ID is set |
| `/teams/{id}/websites` | listing a team's websites, only while no website ID is set |

A sync makes at most seven requests. Opening the Analytics page makes
five.

## How the numbers are made

Umami answers for one day per request, so the plugin reads a day at a
time and stores what it reads in your site's database.

Today is read on every sync and is labelled as still counting. Earlier
days are read once each, newest first, back to the Keep daily rows for
setting. At the default sync interval that is about three days every two
hours, so 90 days of history arrive in about two and a half days and the
chart grows backwards while it does. Per-entry views over 7 and 30 days
are sums of those stored days plus today.

The Analytics page also asks Umami directly each time it opens, so it
shows numbers from the first minute after setup.

When you compare with Umami's own dashboard:

- Days are UTC. Umami shows days in your timezone, so daily figures
  differ near midnight.
- Visits are Umami's visits. Visitors are not shown yet.
- The referrers table lists referring sites only. Visits that arrived
  without a referrer are in the totals and in no row of that table.
- Pages under `/_emdash` are left out of every number.
- A day with 10,000 or more distinct paths is more than the plugin reads.
  It reports that and stores nothing for that day.

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
| `site_totals` | Site visits and page views over 7, 30 or 90 days against the period before |

To use them, open the plugin under Plugins and turn on Agent access.
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

- Visitors. Umami counts them, and no page shows them yet.
- Referrers and countries for longer ranges when Umami cannot be reached.
  The Analytics page reads them from Umami, and falls back to the last
  sync's week.
- A views column in EmDash's content list.
- Fast catch-up on large sites. Each sync step handles a few dozen entries
  or one day of history.
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
