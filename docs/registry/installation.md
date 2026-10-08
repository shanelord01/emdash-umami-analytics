You need EmDash 1.0.1 or later with a plugin sandbox runner, a website in Umami with Umami's tracking script already on your site, a self-hosted Umami 3.4.0 or later (the first self-hosted release with API keys) or Umami Cloud, and `EMDASH_ENCRYPTION_KEY` set on the site so the API key can be saved encrypted (`npx emdash secrets generate` makes one).

1. Install the plugin from the Registry and review its permissions: read content, read the schema, and network requests to any public host. The plugin only ever requests the Umami API URL from its settings.
2. In Umami, create a user with the role View only. Add it to the team that holds your website, with the team role View only. If the website is yours and not a team's, move it to a team first.
3. Sign in to Umami as that user and create a key under Settings > API keys.
4. In EmDash, open Plugins, then this plugin's settings. Paste the key into Umami API key.
5. For a self-hosted Umami, set Umami API URL to `https://your-host/api`. The default is Umami Cloud's address.
6. Enter the Umami website ID from the website's settings in Umami. Leave it empty and the dashboard card lists the websites the key can see, so you can copy one. Save.
7. Open Plugins > Analytics and select Check setup. It runs through everything the numbers depend on and gives one sentence for each problem.

The first syncs read back as far as Keep daily rows for (90 days by default), newest first. On Node that takes about two hours for a site of 100 entries.

Each collection needs a URL Pattern (under Content Types), or pages cannot be matched to entries. On Cloudflare Workers, the sync needs the Cron Trigger from EmDash's deployment guide.

A self-hosted Umami must be on a public hostname: EmDash refuses private addresses, so `localhost`, a LAN address or a VPN-only name will not work.

To use the MCP tools, turn on Agent access for the plugin under Plugins. Turn it on again after an update that changes a tool.
