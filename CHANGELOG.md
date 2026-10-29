# Changelog

## v0.3.1 — 2026-10-29
- **One relay is probed once per run, not once per watch.** If the network is
  down, every watch finds out together and fast, instead of each one burning
  40 seconds rediscovering that the same dead relay is still dead. Measured: 6
  relay requests for three watches, down from 12.
- A failed probe is remembered for 60 s, so the next watch fails immediately.
- A relay that worked and then stopped is forgotten, so the next attempt probes
  again.

## v0.3.0 — 2026-10-29
Nothing fetches until you ask for it.

- **No network on page load.** Measured: 0 relay requests on load and on reload.
  The last result set is kept in localStorage, so a reload shows what was last
  found without touching the network.
- **The bundled copy is now a fallback, not a default.** A watch is checked
  live first; only if the live feed fails do the build-time articles appear, and
  then they are labelled as a copy with the build date.
- **Human error copy.** "Could not reach the news feeds" instead of "no CORS
  relay answered". The relay names sit behind a "technical details" disclosure.
- **Severity depends on whether there is anything to show.** A failed check with
  articles on screen is a quiet grey note, not a red banner.
- **Try again actually retries** — it used to return the same cached data and
  swallow the error, so it looked broken. It now shows "Checking…" and updates.
- A watch that has never been checked says so, and offers "⟳ check".
- A check interrupted by closing the tab no longer leaves a permanent
  "Checking…" behind.

## v0.2.0 — 2026-10-29
The three-state fix, and the samples that are actually yours.

- **A failed fetch no longer looks like an empty result.** "Not run yet", "the feed
  answered but nothing matched" and "could not reach the feed" are now three
  different messages, in three different places. A failed refresh keeps the last
  good results and shows when they were fetched, instead of blanking the list.
  Each failure gets its own **Try again** button.
- **The error names the relays it tried** — "no CORS relay answered (allorigins,
  cors.lol, codetabs, corsfix)" — instead of a bare failure.
- **The samples are your five examples**, verbatim: BTC halving · peso price today ·
  is there an ongoing war right now · when is the new pokemon game gonna get
  released · my chemical romance band concert. 200 real articles, every one
  resolved to the publisher's own URL.
- **Resolved links survive a live refresh.** The relay path can only produce
  Google redirect links, so when live results arrive they keep any publisher URL
  already resolved.
- **The footer says which mode you are in** and whether links go via Google.
- **A per-watch "updated 3m ago" stamp.**
- Fixed: a mode change made while a refresh was running was silently dropped.
- Fixed: marking a link read did not repaint the groups.
- Fixed: the relay chain could hang forever — each attempt now has an 11 s cap
  and dead relays sit out a 90 s cooldown.

## v0.1.0 — 2026-10-29
First working build.

- Watchlist dashboard as the home screen; the search bar adds a watch.
- Three source modes per watch: All Sources / My Sources First / My Sources Only.
- Source list captured from results ("+ source"), no URLs to type.
- Grouping: Read > Published Today > Unread. Read is collapsed, Unread caps at 20 with "Show more".
- Period filter: Latest / This Week / This Month / This Year / 2000-2025 / All Time.
- Ignore any link; ignored links live on their own page with 7/14/30/90-day or indefinite retention.
- Export / import a single JSON file carrying queries, sources, read marks and ignored links.
- Everything in localStorage. No account, no server-side user data.
- Cloudflare Worker data layer in `worker/` — server-side fetch, publisher-URL resolution, caching.
