# Changelog

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
