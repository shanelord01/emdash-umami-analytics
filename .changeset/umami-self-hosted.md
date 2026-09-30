---
"@eisbachcode/emdash-plugin-analytics": minor
---

Umami can now be a self-hosted instance as well as Umami Cloud. Set **Umami API URL** to `https://your-host/api`. It needs Umami 3.4.0 or later, the first release with API keys for self-hosted installs, and a public hostname, because EmDash refuses private addresses.

The plugin's network capability changes from `network:request` with a list of allowed hosts to `network:request:unrestricted`, because the host of a self-hosted Umami is typed into the settings and cannot be named in the manifest. Check that change against your own policy before updating. The plugin still requests only `api.cloudflare.com` and the Umami API URL from its settings.

The `./astro` beacon integration takes `scriptUrl` for the tracker script of a self-hosted Umami.
