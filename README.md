# ursift

**A search engine to your liking.** One long input bar, one button, and a
plain list of text-only links back about whatever you typed.

The name is a possessive plus a verb: *your* sift. Not a watchlist yet, and
not a feed — just the search, with the links that matter, in text.

---

## What it does

| | |
|---|---|
| **One bar, one button** | Type anything, press **Sift**, get a list of links about it. |
| **Nothing preloaded** | No sample queries, no articles on the screen before you ask. The page makes no network request until you press the button. |
| **Two feeds** | Google News RSS for breadth, Bing News RSS for publisher-direct links. Whichever answers first gets the screen; the other merges into it. |
| **Honest states** | *The feed answered but nothing matched* and *could not reach the feeds* are two different messages. A failure never looks like an empty result. |
| **No account** | Nothing is stored on a server, because there is no server holding anything about you. |

---

## The data layer

`site/assets/js/api.js` fetches two RSS feeds through a public CORS relay
(`allorigins`), because neither Google News RSS nor Bing News RSS sends CORS
headers and a browser cannot read either one directly.

Two facts that cost real time to find, and are easy to break again:

- **`allorigins` needs up to ~20 seconds on a cold cache.** The relay timeout
  is 25 s for that reason. An earlier version used 9 s and aborted before the
  relay could answer — every typed search failed, and it looked like the feed
  was broken rather than the timeout being short.
- **Google News RSS links point at `news.google.com`**, which bounces a
  browser straight on to the publisher (verified: a Google News item link
  lands on the publisher's own site in under two seconds). They are usable.
  Bing's links are `apiclick.aspx` wrappers with the publisher's own URL in
  the `url` parameter — unwrapped client-side, no server needed.

Bing's coverage is thin and sometimes one item, so it is the second opinion,
not the backbone. Where Bing carries the same headline as Google, the Bing
link is used so that result opens directly on the publisher.

## The Worker (written, not deployed)

`worker/worker.js` is the production data layer: server-side fetch, edge
caching, server-side publisher-URL resolution, and no CORS problem at all. It
is a separate rung of the build and is deployed with:

```bash
cd worker && npx wrangler deploy
```

## Layout

```
site/
  index.html
  assets/css/app.css
  assets/js/api.js      the data layer — two feeds, one output shape
  assets/js/app.js      the interface — one bar, one button, one list
worker/worker.js        Cloudflare Worker data layer (not deployed yet)
tools/bake_snapshot.py  historic: baked the old snapshot, no longer used
build.sh                stages site/ -> build/
```

## Build

```bash
./build.sh                      # stage into ./build
zip -r ../output/ursift-vX.Y.Z-$(date +%F).zip build
```

## Rules this project keeps

- **A failed fetch must never look like an empty result.** It is the single
  most important rule in this interface.
- **Never fire a burst of requests on page load.** Free relays throttle per
  IP and then the site blames the network.
- **The snapshot is a fallback, never a default** — and as of v0.4.0 there is
  no snapshot at all.
