Report a security problem privately through the repository's advisory form: https://github.com/shanelord01/emdash-umami-analytics/security/advisories/new

**What the Umami API key can do**

An Umami API key has no permissions of its own. It can do whatever the user who created it can do. A key made under an admin user could change or delete every website in your Umami, so create it under a user with the role View only, added to the website's team with the team role View only. A key made that way can read that team's websites and change nothing. The plugin itself only sends `GET` requests.

**Network access**

The plugin asks for `network:request:unrestricted`, because a self-hosted Umami lives on a host you type into the settings, which no fixed list of hosts could name. It only ever requests the Umami API URL from its settings (`https://api.umami.is/v1` unless changed), with the key as a Bearer token. Demo data makes no requests at all. EmDash refuses private addresses for every plugin.

**What is sent and what is stored**

- Umami receives the API key, the website ID and the hostnames to count. Nothing from your content leaves the site.
- The key is saved as an encrypted setting (AES-GCM with `EMDASH_ENCRYPTION_KEY`). Without that key EmDash refuses to save it rather than store it in plain text. The plugin never writes it to its logs.
- The site's database holds page views and visits per day and path, site totals and engagement per day, the match of each path to its entry with that entry's view counts and read-through, and the sync's state with the last week's top pages, referrers and countries. Daily rows older than Keep daily rows for are deleted.

**Who can do what**

The dashboard card, both Analytics pages and the MCP tools need the editor role. The editor panel needs the author role and shows only entries the user may edit. Changing the settings needs the administrator role.
