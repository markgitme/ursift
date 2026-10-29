# Changelog

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
