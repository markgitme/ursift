# Watchlab

A watchlist of questions. You keep a list of things you want to keep an eye on —
*"btc halving"*, *"peso price today"*, *"my chemical romance concert dates"* — and every
time you come back, the site shows you what is **new** about them. Text only. No
account, no feed of your own, no images.

The search bar is not the product. It is how you add to the watchlist. The watchlist is
the product.

---

## What it does

| | |
|---|---|
| **Watchlist home** | Every watch shows counts: published today, unread, read. Expand for the list. |
| **Honest states** | *Not run yet*, *the feed answered but nothing matched* and *could not reach the feed* are three different messages. A failed refresh keeps the last good results and shows when they were fetched. |
| **Three source modes** | *All Sources* · *My Sources First* · *My Sources Only*, per watch. |
| **My Sources** | Publishers you trust. Captured from results with **+ source** — no URLs to type. |
| **Grouping** | `Read` → `Published Today` → `Unread`. Read is collapsed, Unread caps at 20 with "Show more". |
| **Period filter** | Latest · This Week · This Month · This Year · 2000–2025 · All Time. |
| **Ignore** | Any link can be ignored. Ignored links get their own page and a retention window (7/14/30/90 days, or indefinite). After that they come back. |
| **Export / import** | One JSON file carries your watches, sources, read marks and ignored links to another device. |

Everything lives in `localStorage`. Nothing about you is stored on a server, because
there is no server holding user data.

---

## The data layer

News comes from **Google News RSS** (broad, and it honours `site:`) with **Bing News
RSS** as a second index (its links carry the publisher's real URL directly).

Google hands out an opaque link like `news.google.com/rss/articles/CBMi…`. That is a
redirect shim, not an article. The production Worker resolves it server-side through
Google's own `batchexecute` endpoint and stores the publisher's actual URL, so a link
in this site goes straight to the article — never through a Google page.

```
click → https://www.reuters.com/markets/… → article
```

That resolution is cached per article, so it costs two requests once per story, ever.

### Three realities, one output shape

The client in `site/assets/js/api.js` picks its backend from the
`<meta name="watchlab-backend">` tag in `index.html`:

- **worker** — `GET /api/search?q=…` on the same origin. Production. Server-side fetch,
  full publisher-URL resolution, aggressive caching, and it works when the user is
  behind a restrictive network. Set the meta tag to `worker`.
- **relay** — the static build reached through a public CORS relay. Public relays are
  genuinely unreliable — they 522, 503 and rate-limit without warning — so the client
  tries four in turn, puts the ones that just failed into a 90-second cooldown, and
  caps each attempt at 11 seconds.
- **snapshot** — a copy of real, resolved articles baked into the build by
  `tools/bake_snapshot.py`. The page paints instantly from it and the live feed
  replaces it in the background when a relay answers. This is the floor: the site
  always shows something real, never an error screen.

All three return the same item shape, so the interface never knows the difference.

The snapshot is not a mock-up. It contains 200 real articles with their publishers'
own URLs, resolved server-side at bake time.

---

## Running it

### Static build (any host)

```bash
./build.sh          # stages site/ -> build/
```

`build/` is a self-contained static site. Serve it with anything.

### With the Worker (recommended)

The Worker in `worker/` does the fetching, the URL resolution and the caching that a
browser cannot do for itself.

```bash
cd worker
npx wrangler deploy
```

Point it at the static site — either serve `build/` from Cloudflare Pages, or add the
assets binding shown in `worker/wrangler.toml` and serve both from one Worker.

---

## Design notes worth keeping

- **A failed fetch must never look like an empty result.** This is the single
  most important rule in the interface. An earlier version printed "no results,
  press refresh" for both, which is exactly how a dead network disguises itself
  as a working product.
- **The Google News query language punishes `+OR+`.** In `+term` means *must
  contain this term*, so `+OR+` between phrases demands the literal word "or" in
  every result and matches nothing. ` OR ` is correct. Verified: the same eight
  phrases return 0 items with `+OR+` and 41–100 with ` OR `.
- **Regional editions work** — `hl=en-PH&gl=PH&ceid=PH:en` returns a full feed.
  A mismatched pair such as `hl=en-US&gl=PH` returns zero and looks like a dead
  region when it is not.
- **Keep the publisher URL when the live feed arrives.** The relay path can only
  produce Google redirect links, so live results keep any publisher URL that was
  already resolved.
- **Never hammer a free relay.** A 90-second refresh loop from one IP is how a
  working page quietly dies.

- **"Published Today" uses the reader's local day, not UTC.** `pubDate` from Google is
  GMT. A reader in UTC+8 opening at 8am local would otherwise see yesterday's articles
  labelled as today.
- **Recency is a client-side filter on `pubDate`, not a query operator.** Google News'
  `when:7d` silently returns zero results, so the period filter runs in the browser
  over items already fetched.
- **A year filter is bounded by what Google returned** (roughly the top 100). Asking for
  2024 on a query whose top 100 are all from 2026 gives an empty result — not because
  nothing exists, but because Google did not surface it. The UI says so.
- **"My Sources First" issues two queries**, not one. A site-restricted query and a
  general query return nearly *disjoint* result sets, so a preferred source's coverage
  is frequently absent from the general list altogether and cannot be recovered by
  sorting. Measured on "peso price today": `site:reuters.com` returned 100 items, of
  which **0** appeared in the general list.
- **Ignore expiry is checked at render time**, not only on refresh, so an item comes
  back the moment its window passes even if the user never pressed refresh.
- **An ignored link only returns if the query still surfaces it.** Google returns about
  100 items per query; one that falls out of that window simply disappears rather than
  coming back.

---

## Stack

No framework, no build step beyond a copy, no dependencies. Plain HTML, CSS and
JavaScript — the same shape as the rest of this author's sites.

```
site/           the static client
  index.html
  assets/css/app.css
  assets/js/store.js   local state, grouping, export/import
  assets/js/api.js     worker | proxy backends
  assets/js/app.js     interface
worker/         Cloudflare Worker data layer
build.sh        stages the deployable site
```
