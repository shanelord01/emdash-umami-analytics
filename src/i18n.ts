/**
 * The plugin's own message catalogue.
 *
 * Block Kit plugins localize themselves: the host passes the administrator's
 * locale in `routeCtx.ui` and does not consume plugin catalogues. English is
 * the source and the fallback for every locale without a catalogue here.
 * Manifest strings (page label, widget title, settings form) stay static.
 *
 * `de` is typed against the English keys, so a missing German entry fails
 * the build rather than showing an English sentence in a German admin.
 */

type Plural = { one: string; other: string };
type Message = string | Plural;

const en = {
	noAnalyticsYet: "No analytics yet",
	visitsLastDays: "Visits, last {days} days",
	pageviewsLastDays: "Page views, last {days} days",
	pageviews: "Page views",
	visits: "Visits",
	colPage: "Page",
	colPath: "Path",
	colViews: "Views",
	colVisits: "Visits",
	colEntry: "Entry",
	colCollection: "Collection",
	colSource: "Source",
	colCountry: "Country",
	noPagesYet: "No pages recorded yet.",
	nothingRecorded: "Nothing recorded yet.",
	refresh: "Refresh",
	openAnalytics: "Open analytics",
	openInUmami: "Open in Umami",
	rangeDays: { one: "{count} day", other: "{count} days" },
	topEntries: "Top entries",
	referrers: "Referrers",
	countries: "Countries",
	entriesEmpty: "No per-entry numbers yet. They appear once the sync has matched pages to entries.",
	snapshotSince: "Referrers and countries since {date}, from the latest sync.",
	historyStarts: "History starts on {date}",
	coverageRange: "Per-entry numbers for the last {days} days.",
	coveragePartial: "Per-entry numbers since {date}; older days in this range were not read.",
	coverageMatched: "Per-entry numbers since {date}. Days before the plugin matched an entry are not counted per entry.",
	coverageLive: "Per-entry numbers since {date}, as far back as the provider counts every page view.",
	breakdownsSince: "Referrers and countries since {date}, as far back as the provider counts every page view.",
	perEntry: "Per entry",
	viewsBy: "Views by {property}",
	bounceRateLastDays: "Bounce rate, last {days} days",
	averageVisitLastDays: "Average visit, last {days} days",
	pagesPerVisitLastDays: "Page views per visit, last {days} days",
	bounceRate: "Bounce rate",
	averageVisit: "Average visit",
	bounceRateByDay: "Bounce rate by day",
	averageVisitByDay: "Average visit by day",
	axisPercent: "%",
	axisSeconds: "Seconds",
	durationSeconds: "{seconds} s",
	durationMinutes: "{minutes} min {seconds} s",
	pointsVsPrevious: "{change} percentage points vs previous period",
	engagementSince:
		"Bounce rate, visit time and page views per visit from {date}, the first day stored with them.",
	engagementNote: "A bounce is a visit with one page view. Visit time runs from a visit's first page view to its last.",
	readsByDay: "Reads by day",
	readsNote: "{event} events by {property}, as of the sync {age}.",
	readsPartial: "Only the 100 most read entries per depth are counted.",
	colReadTo: "Read to {depth}",
	panelReadTo: "Read to {depth}, 30 days",
	panelReadOf: "{reads} of {views} views",
	colValue: "Value",
	propertiesNote:
		"Page views in this range that carry the event data the site attaches to them, counted on every hostname. A value that lists several parts separated by commas counts once for each part.",
	overview: "Overview",

	allCollections: "All",
	modeEntries: "Each language",
	modeCombined: "Languages combined",
	firstPage: "First page",
	rebuildIndex: "Rebuild index",
	rebuildRequested: "Rebuilding the content index. It runs with the next syncs, a few entries at a time.",
	col7Days: "7 days",
	col30Days: "30 days",
	colLanguage: "Language",
	colAllLanguages: "All languages, 30 days",
	colByLanguage: "By language, {days} days",
	colPublished: "Published",
	sortMostViewed: "Most viewed first, last {days} days.",
	sortLeastViewed: "Least viewed first, last {days} days.",
	showingRows: "Entries {from} to {to}.",
	historyThirty: "30-day figures count from {date}, where the stored history starts.",
	combinedPartial: "Languages combined across the first {count} entries in this order; entries after them are left out.",
	indexingAt: "Indexing content: collection {at} of {total}. Entries appear as they are indexed.",
	rebuildingAt: "Rebuilding the content index: collection {at} of {total}.",
	noEntriesYet: "No entries yet",
	noEntriesIndexing: "The content index is still being built. Entries appear as it progresses.",
	noEntriesNoUrls:
		"No published entry has a public URL. Check that the site URL is set in EmDash and that each collection has a URL Pattern (under Content Types), then press Rebuild index on the per-entry page.",
	noEntriesHere: "No published entries here.",
	panelNoPage: "No page for this entry yet",
	panelNoPageDetail: "Views appear once the entry is published at a public URL and the next sync has run.",
	panelNotPublished: "Not published at the moment; these are the numbers from when it was.",
	panelCountedAt: "Counted at {path}",
	panelAllLanguages: "All languages: {count} in 30 days",

	checkSetup: "Check setup",
	checkAgain: "Check again",
	backToAnalytics: "Back to analytics",
	setupTitle: "Setup check",
	setupAllGood: "Everything the numbers depend on is in place.",
	setupProblems: {
		one: "{count} problem stops or distorts the numbers.",
		other: "{count} problems stop or distort the numbers.",
	},
	colCheck: "Check",
	colStatus: "Status",
	colDetails: "Details",
	statusOk: "OK",
	statusProblem: "Problem",
	statusWaiting: "Waiting",
	statusSkipped: "Not checked",
	checkSource: "Data source",
	checkHosts: "Hostnames",
	checkSiteUrl: "Site URL",
	checkIndex: "Content index",
	checkScheduler: "Scheduled sync",
	checkLastSync: "Last sync",
	sourceDemo: "Demo data: generated numbers. Nothing on Umami is checked.",
	credentialsSaved: "Saved.",
	siteTagFound: "{tag}: {count} page views in the last {days} days.",
	hostsCounted: "Counted: {hosts}.",
	hostsPartly: "Counted: {counted}. Not counted: {excluded}.",
	siteUrlMissing:
		"EmDash has no site URL, so entries have no public address and page views cannot be matched to them. EmDash stores it (the emdash:site_url option) when the setup wizard runs on the live domain; a server that was already running picks it up after a restart.",
	needsSiteUrl: "Needs the site URL.",
	indexMatched: { one: "{count} entry matched to its page.", other: "{count} entries matched to their pages." },
	schedulerNotScheduled: "The sync is not scheduled yet. Opening the dashboard schedules it.",
	schedulerWaiting: "Scheduled every {interval}, not run yet. If it still has not run after {interval}, the site runs no scheduled tasks.",
	schedulerOk: "Last run {age}, scheduled every {interval}.",
	schedulerStale: "Last run {age}, but scheduled every {interval}: the site's scheduler is not running on time.",
	schedulerNeverRan: "Scheduled {age} to run every {interval}, and it has never run: the site's scheduler is not running.",
	schedulerRefreshStuck: "A sync requested {age} has not run: the site's scheduler is not running.",
	schedulerHowTo:
		"On Cloudflare Workers, EmDash runs scheduled tasks from a Cron Trigger and the scheduled handler in src/worker.ts. npx emdash doctor checks that both are configured.",
	minutes: { one: "{count} minute", other: "{count} minutes" },
	hours: { one: "{count} hour", other: "{count} hours" },
	colHostnames: "Hostnames",

	checkCredentialsUmami: "API key",
	checkAccessUmami: "Umami access",
	checkWebsiteId: "Website ID",
	sourceUmami: "Umami.",
	encryptionKeyHintUmami:
		"If saving the API key fails with an encryption error, the site needs EMDASH_ENCRYPTION_KEY: generate a value with npx emdash secrets generate and store it as a secret (on Cloudflare: wrangler secret put EMDASH_ENCRYPTION_KEY).",
	needsCredentialsUmami: "Needs the API key.",
	accessOkUmami: "Umami accepts the API key.",
	needsAccessUmami: "Needs working Umami access.",
	websiteIdMissing: "No website ID set. Copy one from the list below into Umami website ID in the plugin's settings.",
	websiteIdMissingNoList:
		"No website ID set, and Umami lists no website for this API key's user or their teams. Copy the ID from the website's settings in Umami into Umami website ID in the plugin's settings.",
	websiteNoTraffic:
		"Umami reported no page views for this website in the last {days} days. Check that the tracking script is on the site.",
	needsWebsiteId: "Needs a website ID with traffic.",
	hostsEveryUmami: "No hostname filter: counting every hostname this website reports ({hosts}).",
	hostsNoneUmami:
		"Umami reports this website under {reported}, but the plugin counts only {counted}. Change Hostnames to count in the plugin's settings.",
	websitesTitle: "Websites this API key can list",
	colWebsiteId: "Website ID",
	colName: "Name",
	websitesNote:
		"Websites the API key's user owns and the websites of that user's teams, up to four teams, and for the configured website the hostnames it reported in the last {days} days. An ID can also be copied from the website's settings in Umami.",

	demoData: "Demo data, not real traffic",
	synced: "Synced {age}",
	notSynced: "Not synced yet",
	estimatedSampled: "estimated (sampled)",
	todayCounting: "today is still counting",
	nothingMatched: "no page is matched to an entry yet; Check setup on the Analytics page says why",
	lastAttemptFailed: "Last attempt failed: {error}",
	lastAttemptFailedAge: "Last attempt failed {age}: {error}",
	firstSyncPending: "The first sync has not run yet. It is scheduled now; numbers appear after it completes.",
	syncedNoViewsUmami:
		"Synced {age}, but Umami reported no page views for this website. Check that the tracking script is on the site.",
	recently: "recently",

	noEarlierPeriod: "no earlier period to compare yet",
	noneEitherPeriod: "none in either period",
	upFromNone: "up from none last period",
	vsPrevious: "{change} vs previous period",

	syncRequested: "Sync requested. The numbers update with the next scheduled run.",
	pageRefreshed: "Updated with the latest numbers.",
	pageRefreshFailed: "The provider did not answer; showing the stored numbers.",
	syncUnschedulable: "This site runs no scheduled tasks, so a sync cannot be requested.",

	notConfigured: "Analytics is not configured yet: add {parts} in the plugin's settings.",
	partUmamiApiKey: "an Umami API key",
	noNetwork: "Analytics cannot reach the network: the network:request capability is not granted.",
	noWebsiteIdSites: "No website ID set. Websites this API key can list: {sites}.",
	noWebsiteIdNoList:
		"No website ID set, and Umami lists no website for this API key's user or their teams. Copy the ID from the website's settings in Umami into the plugin's settings.",
	indexingFailed: "Indexing content failed: {detail}",
	summingFailed: "Summing the 30-day views failed: {detail}",
	historyFailed: "Reading earlier days failed: {detail}",
	storageUnavailable: "Storage collections are not available.",
	umamiBadKey:
		"Umami rejected the API key (401). Create a key under Settings → API keys in Umami and save it in the plugin's settings.",
	umamiUnauthorized:
		"Umami answered 401 Unauthorized: the API key is wrong or revoked, or its user cannot view this website.",
	umamiNoWebsite: "Umami has no website with this ID that the API key's user can view (HTTP {status}).",
	umamiProxy:
		"Umami answered with a web page instead of JSON (HTTP {status}): a login proxy in front of the API is intercepting the request, or the API URL points somewhere else.",
	umamiRateLimited: "Umami rate-limited the request (429). The next sync tries again.",
	umamiUnreachable: "Umami could not be reached: {detail}",
	umamiHttp: "Umami returned HTTP {status}",
	umamiUnexpected: "Umami returned a response in a shape this plugin does not know.",
	umamiTruncated: "Umami reported {max} or more paths for one day, which is more than the plugin reads.",
	umamiBadUrl: "The Umami API URL is not a web address. For a self-hosted Umami it is https://your-host/api.",
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, Message> = {
	noAnalyticsYet: "Noch keine Analysedaten",
	visitsLastDays: "Besuche, letzte {days} Tage",
	pageviewsLastDays: "Seitenaufrufe, letzte {days} Tage",
	pageviews: "Seitenaufrufe",
	visits: "Besuche",
	colPage: "Seite",
	colPath: "Pfad",
	colViews: "Aufrufe",
	colVisits: "Besuche",
	colEntry: "Eintrag",
	colCollection: "Kollektion",
	colSource: "Quelle",
	colCountry: "Land",
	noPagesYet: "Noch keine Seiten erfasst.",
	nothingRecorded: "Noch nichts erfasst.",
	refresh: "Aktualisieren",
	openAnalytics: "Analytics öffnen",
	openInUmami: "In Umami öffnen",
	rangeDays: { one: "{count} Tag", other: "{count} Tage" },
	topEntries: "Meistbesuchte Einträge",
	referrers: "Verweisquellen",
	countries: "Länder",
	entriesEmpty:
		"Noch keine Zahlen pro Eintrag. Sie erscheinen, sobald die Synchronisierung Seiten den Einträgen zugeordnet hat.",
	snapshotSince: "Verweisquellen und Länder seit {date}, aus der letzten Synchronisierung.",
	historyStarts: "Verlauf beginnt am {date}",
	coverageRange: "Zahlen pro Eintrag für die letzten {days} Tage.",
	coveragePartial: "Zahlen pro Eintrag seit {date}; ältere Tage in diesem Zeitraum wurden nicht gelesen.",
	coverageMatched:
		"Zahlen pro Eintrag seit {date}. Tage, bevor das Plugin eine Seite einem Eintrag zugeordnet hat, zählen nicht pro Eintrag.",
	coverageLive: "Zahlen pro Eintrag seit {date}, so weit zurück, wie der Anbieter jeden Seitenaufruf zählt.",
	breakdownsSince: "Verweisquellen und Länder seit {date}, so weit zurück, wie der Anbieter jeden Seitenaufruf zählt.",
	perEntry: "Pro Eintrag",
	viewsBy: "Aufrufe nach {property}",
	bounceRateLastDays: "Absprungrate, letzte {days} Tage",
	averageVisitLastDays: "Durchschnittlicher Besuch, letzte {days} Tage",
	pagesPerVisitLastDays: "Seitenaufrufe pro Besuch, letzte {days} Tage",
	bounceRate: "Absprungrate",
	averageVisit: "Durchschnittlicher Besuch",
	bounceRateByDay: "Absprungrate pro Tag",
	averageVisitByDay: "Durchschnittlicher Besuch pro Tag",
	axisPercent: "%",
	axisSeconds: "Sekunden",
	durationSeconds: "{seconds} s",
	durationMinutes: "{minutes} Min. {seconds} s",
	pointsVsPrevious: "{change} Prozentpunkte ggü. vorigem Zeitraum",
	engagementSince:
		"Absprungrate, Besuchsdauer und Seitenaufrufe pro Besuch ab {date}, dem ersten Tag, der mit ihnen gespeichert ist.",
	engagementNote:
		"Ein Absprung ist ein Besuch mit einem Seitenaufruf. Die Besuchsdauer reicht vom ersten bis zum letzten Seitenaufruf eines Besuchs.",
	readsByDay: "Lesungen pro Tag",
	readsNote: "{event}-Ereignisse nach {property}, Stand der Synchronisierung {age}.",
	readsPartial: "Gezählt werden nur die 100 meistgelesenen Einträge je Lesetiefe.",
	colReadTo: "Gelesen bis {depth}",
	panelReadTo: "Gelesen bis {depth}, 30 Tage",
	panelReadOf: "{reads} von {views} Aufrufen",
	colValue: "Wert",
	propertiesNote:
		"Seitenaufrufe in diesem Zeitraum, die die Ereignisdaten tragen, die die Website ihnen mitgibt, gezählt auf jedem Hostnamen. Ein Wert, der mehrere durch Kommas getrennte Teile auflistet, zählt einmal für jeden Teil.",
	overview: "Übersicht",

	allCollections: "Alle",
	modeEntries: "Jede Sprache einzeln",
	modeCombined: "Sprachen zusammen",
	firstPage: "Erste Seite",
	rebuildIndex: "Index neu aufbauen",
	rebuildRequested:
		"Der Inhaltsindex wird neu aufgebaut. Das läuft mit den nächsten Synchronisierungen, jeweils ein paar Einträge.",
	col7Days: "7 Tage",
	col30Days: "30 Tage",
	colLanguage: "Sprache",
	colAllLanguages: "Alle Sprachen, 30 Tage",
	colByLanguage: "Nach Sprache, {days} Tage",
	colPublished: "Veröffentlicht",
	sortMostViewed: "Meistbesuchte zuerst, letzte {days} Tage.",
	sortLeastViewed: "Am wenigsten besuchte zuerst, letzte {days} Tage.",
	showingRows: "Einträge {from} bis {to}.",
	historyThirty: "Die 30-Tage-Zahlen zählen ab {date}, dem Beginn des gespeicherten Verlaufs.",
	combinedPartial:
		"Sprachen zusammengefasst über die ersten {count} Einträge in dieser Reihenfolge; spätere Einträge fehlen.",
	indexingAt: "Inhalte werden indiziert: Kollektion {at} von {total}. Einträge erscheinen, sobald sie indiziert sind.",
	rebuildingAt: "Der Inhaltsindex wird neu aufgebaut: Kollektion {at} von {total}.",
	noEntriesYet: "Noch keine Einträge",
	noEntriesIndexing: "Der Inhaltsindex wird noch aufgebaut. Einträge erscheinen nach und nach.",
	noEntriesNoUrls:
		"Kein veröffentlichter Eintrag hat eine öffentliche URL. Prüfe, ob die URL der Website in EmDash eingetragen ist und jede Kollektion ein URL-Muster hat (unter Inhaltstypen), und drücke dann „Index neu aufbauen“ auf der Seite pro Eintrag.",
	noEntriesHere: "Hier gibt es keine veröffentlichten Einträge.",
	panelNoPage: "Noch keine Seite für diesen Eintrag",
	panelNoPageDetail:
		"Aufrufe erscheinen, sobald der Eintrag unter einer öffentlichen URL veröffentlicht ist und die nächste Synchronisierung gelaufen ist.",
	panelNotPublished: "Derzeit nicht veröffentlicht; das sind die Zahlen aus der Zeit davor.",
	panelCountedAt: "Gezählt unter {path}",
	panelAllLanguages: "Alle Sprachen: {count} in 30 Tagen",

	checkSetup: "Einrichtung prüfen",
	checkAgain: "Erneut prüfen",
	backToAnalytics: "Zurück zur Analyse",
	setupTitle: "Einrichtung",
	setupAllGood: "Alles, wovon die Zahlen abhängen, ist eingerichtet.",
	setupProblems: {
		one: "{count} Problem verhindert oder verfälscht die Zahlen.",
		other: "{count} Probleme verhindern oder verfälschen die Zahlen.",
	},
	colCheck: "Prüfung",
	colStatus: "Status",
	colDetails: "Details",
	statusOk: "OK",
	statusProblem: "Problem",
	statusWaiting: "Ausstehend",
	statusSkipped: "Nicht geprüft",
	checkSource: "Datenquelle",
	checkHosts: "Hostnamen",
	checkSiteUrl: "Website-URL",
	checkIndex: "Inhaltsindex",
	checkScheduler: "Geplante Synchronisierung",
	checkLastSync: "Letzte Synchronisierung",
	sourceDemo: "Demodaten: erzeugte Zahlen. Bei Umami wird nichts geprüft.",
	credentialsSaved: "Gespeichert.",
	siteTagFound: "{tag}: {count} Seitenaufrufe in den letzten {days} Tagen.",
	hostsCounted: "Gezählt: {hosts}.",
	hostsPartly: "Gezählt: {counted}. Nicht gezählt: {excluded}.",
	siteUrlMissing:
		"EmDash hat keine Website-URL, deshalb haben Einträge keine öffentliche Adresse und Seitenaufrufe lassen sich ihnen nicht zuordnen. EmDash speichert sie (die Option emdash:site_url), wenn der Einrichtungsassistent auf der Live-Domain läuft; ein Server, der da schon lief, übernimmt sie nach einem Neustart.",
	needsSiteUrl: "Braucht die Website-URL.",
	indexMatched: {
		one: "{count} Eintrag ist seiner Seite zugeordnet.",
		other: "{count} Einträge sind ihren Seiten zugeordnet.",
	},
	schedulerNotScheduled: "Die Synchronisierung ist noch nicht geplant. Das Öffnen des Dashboards plant sie ein.",
	schedulerWaiting:
		"Geplant alle {interval}, noch nicht gelaufen. Wenn sie nach {interval} noch nicht gelaufen ist, führt die Website keine geplanten Aufgaben aus.",
	schedulerOk: "Zuletzt gelaufen {age}, geplant alle {interval}.",
	schedulerStale: "Zuletzt gelaufen {age}, geplant ist sie aber alle {interval}: Der Scheduler der Website läuft nicht pünktlich.",
	schedulerNeverRan:
		"Eingeplant {age}, alle {interval}, und noch nie gelaufen: Der Scheduler der Website läuft nicht.",
	schedulerRefreshStuck: "Eine {age} angeforderte Synchronisierung ist nicht gelaufen: Der Scheduler der Website läuft nicht.",
	schedulerHowTo:
		"Auf Cloudflare Workers führt EmDash geplante Aufgaben über einen Cron Trigger und den scheduled-Handler in src/worker.ts aus. npx emdash doctor prüft, ob beides eingerichtet ist.",
	minutes: { one: "{count} Minute", other: "{count} Minuten" },
	hours: { one: "{count} Stunde", other: "{count} Stunden" },
	colHostnames: "Hostnamen",

	checkCredentialsUmami: "API-Schlüssel",
	checkAccessUmami: "Zugriff auf Umami",
	checkWebsiteId: "Website-ID",
	sourceUmami: "Umami.",
	encryptionKeyHintUmami:
		"Wenn das Speichern des API-Schlüssels mit einem Verschlüsselungsfehler scheitert, fehlt der Website EMDASH_ENCRYPTION_KEY: Erzeuge einen Wert mit npx emdash secrets generate und hinterlege ihn als Secret (bei Cloudflare: wrangler secret put EMDASH_ENCRYPTION_KEY).",
	needsCredentialsUmami: "Braucht den API-Schlüssel.",
	accessOkUmami: "Umami akzeptiert den API-Schlüssel.",
	needsAccessUmami: "Braucht funktionierenden Zugriff auf Umami.",
	websiteIdMissing:
		"Keine Website-ID eingetragen. Übernimm eine aus der Liste unten in das Feld Umami website ID in den Einstellungen des Plugins.",
	websiteIdMissingNoList:
		"Keine Website-ID eingetragen, und Umami listet für den Benutzer dieses API-Schlüssels und seine Teams keine Website auf. Übernimm die ID aus den Einstellungen der Website in Umami in das Feld Umami website ID in den Einstellungen des Plugins.",
	websiteNoTraffic:
		"Umami hat für diese Website in den letzten {days} Tagen keine Seitenaufrufe gemeldet. Prüfe, ob das Tracking-Skript auf der Website eingebunden ist.",
	needsWebsiteId: "Braucht eine Website-ID mit Traffic.",
	hostsEveryUmami: "Kein Hostnamen-Filter: Gezählt wird jeder Hostname, den diese Website meldet ({hosts}).",
	hostsNoneUmami:
		"Umami meldet diese Website unter {reported}, das Plugin zählt aber nur {counted}. Ändere Hostnames to count in den Einstellungen des Plugins.",
	websitesTitle: "Websites, die dieser API-Schlüssel auflisten kann",
	colWebsiteId: "Website-ID",
	colName: "Name",
	websitesNote:
		"Websites, die dem Benutzer des API-Schlüssels gehören, und die Websites seiner Teams, bis zu vier Teams, und für die eingetragene Website die Hostnamen, die sie in den letzten {days} Tagen gemeldet hat. Eine ID lässt sich auch aus den Einstellungen der Website in Umami übernehmen.",

	demoData: "Demodaten, keine echten Besuche",
	synced: "Synchronisiert {age}",
	notSynced: "Noch nicht synchronisiert",
	estimatedSampled: "geschätzt (Stichprobe)",
	todayCounting: "heute läuft die Zählung noch",
	nothingMatched: "noch keine Seite einem Eintrag zugeordnet; „Einrichtung prüfen“ auf der Seite Analytics nennt den Grund",
	lastAttemptFailed: "Letzter Versuch fehlgeschlagen: {error}",
	lastAttemptFailedAge: "Letzter Versuch fehlgeschlagen {age}: {error}",
	firstSyncPending:
		"Die erste Synchronisierung ist noch nicht gelaufen. Sie ist eingeplant; die Zahlen erscheinen, sobald sie abgeschlossen ist.",
	syncedNoViewsUmami:
		"Synchronisiert {age}, aber Umami meldet für diese Website keine Seitenaufrufe. Prüfe, ob das Tracking-Skript auf der Webseite eingebunden ist.",
	recently: "kürzlich",

	noEarlierPeriod: "noch kein früherer Zeitraum zum Vergleich",
	noneEitherPeriod: "in keinem der beiden Zeiträume",
	upFromNone: "gestiegen von null im vorigen Zeitraum",
	vsPrevious: "{change} ggü. vorigem Zeitraum",

	syncRequested: "Synchronisierung angefordert. Die Zahlen werden beim nächsten geplanten Lauf aktualisiert.",
	pageRefreshed: "Mit den neuesten Zahlen aktualisiert.",
	pageRefreshFailed: "Der Anbieter hat nicht geantwortet; angezeigt werden die gespeicherten Zahlen.",
	syncUnschedulable:
		"Diese Webseite führt keine geplanten Aufgaben aus, daher lässt sich keine Synchronisierung anfordern.",

	notConfigured: "Analytics ist noch nicht eingerichtet: Trage {parts} in den Einstellungen des Plugins ein.",
	partUmamiApiKey: "einen Umami-API-Schlüssel",
	noNetwork: "Analytics kann das Netzwerk nicht erreichen: Die Berechtigung network:request ist nicht erteilt.",
	noWebsiteIdSites: "Keine Website-ID gesetzt. Websites, die dieser API-Schlüssel auflisten kann: {sites}.",
	noWebsiteIdNoList:
		"Keine Website-ID gesetzt, und Umami listet für den Benutzer dieses API-Schlüssels und seine Teams keine Website auf. Übernimm die ID aus den Einstellungen der Website in Umami in die Einstellungen des Plugins.",
	indexingFailed: "Das Indizieren der Inhalte ist fehlgeschlagen: {detail}",
	summingFailed: "Das Summieren der Aufrufe über 30 Tage ist fehlgeschlagen: {detail}",
	historyFailed: "Das Lesen früherer Tage ist fehlgeschlagen: {detail}",
	storageUnavailable: "Die Speicher-Collections sind nicht verfügbar.",
	umamiBadKey:
		"Umami hat den API-Schlüssel abgelehnt (401). Erzeuge in Umami unter Settings → API keys einen Schlüssel und speichere ihn in den Einstellungen des Plugins.",
	umamiUnauthorized:
		"Umami hat mit 401 Unauthorized geantwortet: Der API-Schlüssel ist falsch oder widerrufen, oder sein Benutzer darf diese Website nicht ansehen.",
	umamiNoWebsite:
		"Umami kennt keine Website mit dieser ID, die der Benutzer des API-Schlüssels ansehen darf (HTTP {status}).",
	umamiProxy:
		"Umami hat mit einer Webseite statt mit JSON geantwortet (HTTP {status}): Ein Login-Proxy vor der API fängt die Anfrage ab, oder die API-URL zeigt auf etwas anderes.",
	umamiRateLimited: "Umami hat die Anfrage gedrosselt (429). Die nächste Synchronisierung versucht es erneut.",
	umamiUnreachable: "Umami war nicht erreichbar: {detail}",
	umamiHttp: "Umami hat HTTP {status} zurückgegeben",
	umamiUnexpected: "Umami hat eine Antwort in einer Form geliefert, die dieses Plugin nicht kennt.",
	umamiTruncated: "Umami hat für einen Tag {max} oder mehr Pfade gemeldet, mehr als das Plugin liest.",
	umamiBadUrl: "Die Umami-API-URL ist keine Webadresse. Bei einem selbst gehosteten Umami lautet sie https://dein-host/api.",
};

const catalogues = { en, de } as const;

export type Lang = keyof typeof catalogues;
export type Params = Record<string, string | number>;

/** A translatable failure, stored so the text follows the reader's language. */
export interface Problem {
	key: MessageKey;
	params?: Params;
}

/** The catalogue for an admin locale: `de`, `de-AT` and `de-CH` read German. */
export function langOf(locale: string | undefined): Lang {
	return locale?.toLowerCase().split(/[-_]/)[0] === "de" ? "de" : "en";
}

export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
	const message = catalogues[lang][key];
	const template =
		typeof message === "string"
			? message
			: new Intl.PluralRules(lang).select(Number(params.count ?? 0)) === "one"
				? message.one
				: message.other;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

/** How a missing settings key reads inside the "not configured" sentence. */
const MISSING_PARTS: Record<string, MessageKey> = {
	umamiApiKey: "partUmamiApiKey",
};

/** A problem in the reader's language. */
export function problemText(lang: Lang, problem: Problem): string {
	if (problem.key === "notConfigured") {
		const missing = String(problem.params?.missing ?? "").split(",").filter(Boolean);
		const parts = missing.map((key) => t(lang, MISSING_PARTS[key] ?? "partUmamiApiKey"));
		return t(lang, "notConfigured", { parts: listOf(lang, parts) });
	}
	return t(lang, problem.key, problem.params);
}

function listOf(lang: Lang, parts: string[]): string {
	try {
		return new Intl.ListFormat(lang, { type: "conjunction" }).format(parts);
	} catch {
		return parts.join(", ");
	}
}

/** A failed `Result` whose error text is the English message for logs. */
export function failure(key: MessageKey, params?: Params): { ok: false; error: string; problem: Problem } {
	return { ok: false, error: t("en", key, params), problem: { key, ...(params && { params }) } };
}
