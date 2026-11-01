# ursift — project state

> The repo layout, the naming, the three data backends, the verified feed
> facts, the rename checklist and the open decisions.
>
> Read before changing or deploying this project.

## THE NAME — decided 2026-10-30: **Ur Sift** (lowercase brand: `ursift`)

Chosen by Mark. The project is **no longer called "Watchlab."** "Watch" was
rejected because the word is now strongly linked to watching video and reels.

**How the name was found** (worth keeping — the method is reusable): a single
common noun in this category is almost always already taken by something. The
fix is a **two-word name: a short form of "your" + a rare synonym of the
filtering verb.** Mark proposed the device ("ur" + a rare synonym of search).
61 such names were tested against the authoritative IANA RDAP servers: **56 were
simultaneously free on `.com`, `.tools`, `.site` and `.is`.** Single common
nouns, by contrast, were almost universally taken.

The runner-up was **Ur Comb**; "comb" was rejected because it reads as a *hair*
comb in isolation.

### The rename checklist — apply in ONE pass when Mark gives a build trigger

| What | Current | Becomes |
|---|---|---|
| localStorage state key | `watchlab.state.v1` | `ursift.state.v1` |
| localStorage results key | `watchlab.results.v1` | `ursift.results.v1` |
| relay memory key | `watchlab.relay` | `ursift.relay` |
| relay cooldown key | `watchlab.relayfail` | `ursift.relayfail` |
| backend meta tag | `<meta name="watchlab-backend">` | `ursift-backend` |
| relay probe query | `watchlabprobe` | `ursiftprobe` |
| export filename | `watchlab-*.json` | `ursift-*.json` |
| repo folder | `/workspace/watchlab` | `/workspace/ursift` |
| worker name | `worker/wrangler.toml` | `ursift` |
| zip filenames | `watchlab-v0.X.Y-*.zip` | `ursift-v0.X.Y-*.zip` |

Also: the display name in the header/footer, page `<title>`s, meta descriptions,
the CHANGELOG/README headings, and the git remote name.

**No user-data migration is needed** — nothing has been released, no real
users, and the five baked sample queries are keyed by their *query strings*,
not by the product name. Existing localStorage keys can simply be replaced.

## What it is

Keep a list of questions you care about ("btc halving", "peso price today"). The
site shows what is new about them. Text only, no images, no account, no
server-side user data.

**The search bar is the input form, not the product. The watchlist is the
product.**

## Repo & state

- Repo: `markgitme/ursift` — git, tags `v0.1.0` (c942532) … `v0.6.3`
  (372e66b).
- Live: `https://ursift.ursf.workers.dev` — Workers + git integration on
  `markgitme/ursift`, production branch `main`. **Cloudflare's git integration
  deploys on every push**, so there is no way to release without pushing.
- No domain bought.
- Stack: dependency-free static HTML/CSS/JS, exactly like InputScope. Dark
  theme.

```
site/            the static client
  index.html
  assets/js/store.js   localStorage state, grouping, export/import
  assets/js/api.js     worker | relay | snapshot backends
  assets/js/app.js     interface
  assets/css/app.css
  site/data/snapshot.json   baked real articles (200 items, all with publisher URLs)
worker/worker.js Cloudflare Worker data layer — DEPLOYED
worker/wrangler.toml
tools/bake_snapshot.py     bakes site/data/snapshot.json from live feeds
tools/smoke.sh             drives the Worker locally with `wrangler dev`
tools/browser-test.py      drives the interface in real Chromium
build.sh          stages site/ -> build/  (--skip-snapshot reuses the baked one)
```

## The three backends (understand this before changing api.js)

1. **worker** — `GET /api/search` same-origin. Production path. Server-side
   fetch, server-side publisher-URL resolution via Google's batchexecute,
   caching. Set the meta tag to `worker`. **Deployed.**
2. **relay** — static host, public CORS relay. The relays are tried in turn,
   each with its own timeout, and the failures are remembered. Public relays
   522/503 constantly.
3. **snapshot** — baked real articles. The page paints instantly from it; the
   live feed replaces it in the background when a relay answers. **Never show an
   error screen.**

**Since v0.6.2 the interface asks the Worker and the relays at the same time**
instead of waiting for the Worker to give up. The Worker is the fast path when
Google lets it through (0.13 s, ~100 items); the relays ask from the *visitor's*
address, which nobody else shares, so they are the reliable path. A **thin**
answer (the second feed alone, 4–12 items) does *not* stop the other path.

## Verified facts (do not re-derive)

- Google News RSS sends **no CORS headers**. Bing News RSS neither. No relay
  supports POST, and Google's `batchexecute` resolver is **POST-only** (GET
  returns 405), so a browser cannot resolve a Google News link to its publisher
  URL. Only a server can.
- Bing News RSS caps at ~14 items and wraps links in `apiclick.aspx`, but the
  real publisher URL is URL-encoded in the `url=` parameter — unwrap it, no
  server needed.
- A `site:`-restricted query and a general query return nearly **disjoint**
  result sets (measured: 0 of 100 Reuters items appeared in the general list for
  "peso price today"). This is why "My Sources First" needs a second query, not
  a sort.
- `when:7d` silently returns 0 items. Date windows are a client-side filter on
  pubDate.
- `pubDate` IS the real publication date (verified against 8 resolved Reuters
  URLs).
- `<source url="…">` on every RSS item gives the publisher name **and** its
  domain — which is how "+ source" captures a source with no typing and no name
  resolution.

## The rules this project learned the hard way

1. **A failed fetch must never look like an empty result.** It is the single
   most important rule in this interface, and it is the same bug Mark's own old
   single-file page had.
2. **Never let the page fire a burst of requests on load.** Free relays get
   throttled and then the site blames the network. Measured: 12 relay requests
   in one page load with 3 watches; now 6, and **0 on page load**.
3. **The snapshot is a fallback, never the default.** Nothing stale on screen
   unless it is labelled as a copy with the build date.
4. **Manual refresh only.** Nothing fetches unless the user presses a button.
   Do not reintroduce auto-refresh unless Mark asks.
5. **A search is a generation.** A new search aborts the previous one's
   requests, and a stale answer can never paint over a newer search.
6. **Retries are deadline-driven, not attempt-driven.** A relay that fails
   *fast* (a 522 returns in a moment) must not burn its attempt budget in
   seconds and give up while there is still time.
7. **Copy is honest.** The note names which relay did not answer and how many
   attempts are left, because a relay's error response carries no CORS header
   and the browser therefore hides its status code entirely.
8. **Any helper that can be called more than once must return the same answer
   every time.** The race helper early-returned on a `settled` flag and returned
   `undefined` on the second call; that reached the interface as "no result at
   all" and the whole search silently became an error panel.

## The owner's own notes (private)

**The open decisions, the domain position and the product definition are not
in this file.** They are in the owner's private notes repository, under
`ursift/docs/notes/` — `owner-notes.md` for the decisions and the domain,
`product.md` for the product he actually wants. Everything here is about the
code.

## Bugs already found and fixed

- A mode change made while a refresh was running was silently dropped → run
  queue added.
- Marking a link read did not repaint the groups → render after markRead.
- The relay chain could hang forever → per-attempt timeout + cooldown.
- `hl`/`gl` were swapped for non-US regions → edition id parsed correctly.
- Domain matching was exact, so `newsinfo.inquirer.net` did not match
  `inquirer.net` → suffix matching.
- **The query syntax in Mark's own old file was broken.** He wrote `+OR+` between
  quoted phrases. In Google News syntax `+term` means *must contain*, so `+OR+`
  demands the literal word "or" in every result. The same eight phrases:
  **`+OR+` → 0 items, ` OR ` → 41–100.**
- **A proxy being down and a query returning nothing looked identical** — the
  page showed "Loading..." forever because the container was never touched. Two
  failures, one indistinguishable symptom: silence.

## The push method

`git -c "http.https://github.com/.extraheader=Authorization: Basic $AUTH"` so
the token never enters `.git/config` or the remote URL. The ursift token lives
in the **separate `GH_TOKEN_URSIFT`** secret, deliberately kept apart from the
`GH_TOKEN` that is scoped to `markgitme/inpscp` for InputScope.

**There is no Cloudflare access from the sandbox** — `wrangler whoami` says "You
are not authenticated", and the only stored secrets are `GH_TOKEN` and
`GH_TOKEN_URSIFT`. Every release is a git push, and Cloudflare's git
integration does the deploy.
