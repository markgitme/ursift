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
| **Real publisher links** | Results point at the publisher's own site, not at a Google News wrapper. The Worker resolves them server-side. |
| **Two paths, one answer** | A Cloudflare Worker on the same origin answers first. If it does not answer at all, the public relays take over. |
| **Honest states** | *The feed answered but nothing matched* and *could not reach the feeds* are two different messages. A failure never looks like an empty result. |
| **No account** | Nothing is stored on a server, because there is no server holding anything about you. |

---

## The data layer

`worker/worker.js` is the production data layer, and it is deployed. It does
the three things a browser cannot:

1. **Fetches the feed.** Google News RSS sends no CORS headers, so a browser
   cannot read it. From Cloudflare's edge it answers in 0.39 s.
2. **Caches the result** at the edge, so the same query is answered from
   Cloudflare's cache the second time.
3. **Never fetches Google directly.** Google rate-limits by IP address, and
   every Cloudflare Worker shares one pool of egress addresses, so a Worker
   that asks Google for itself gets 429s and empty responses. The Worker asks
   a **relay** instead, from an address that is not Cloudflare's, and Google
   answers it. Measured from a real colo with four User-Agents: all four
   failed, so it was never the User-Agent — it was the address.

   Google News links point at `news.google.com`, which bounces a browser on
   to the publisher (verified: a Google News item link lands on the
   publisher's own site in under two seconds). They are left as they are.

Bing News RSS is the Worker's second opinion, merged server-side. It is thin
(1–14 items against Google's 84–100) and sometimes a single item, so it never
carries the list alone.

### The relay path is the fallback, not the plan

`site/assets/js/api.js` still has the public CORS relay path (`allorigins`,
`cors.lol`) from before the Worker existed. It runs when there is no Worker
on the origin, and when the Worker is present but does not answer.

Two facts that cost real time to find, and are easy to break again:

- **`allorigins` needs up to ~25 seconds on a cold cache.** It is retried
  often and briefly, because it is flaking rather than throttling.
- **`cors.lol` is rate-limited** to roughly one request every few minutes, so
  it gets exactly one request per search, waited out patiently.
- **A relay's error response carries no CORS header**, so the browser never
  shows its status code: a 429, a 500 and a dead connection all arrive as the
  same generic "Failed to fetch". Retry on the *absence* of an answer, not on
  the code.

## Deploying

The Worker is connected to GitHub through Cloudflare's git integration, so an
approved push to `main` is a release.

| Setting | Value |
|---|---|
| **Build command** | `./build.sh` |
| **Deploy command** | `npx wrangler deploy --config worker/wrangler.toml` |
| **Preview command** | `npx wrangler preview --config worker/wrangler.toml` |

The `--config` matters: `worker/wrangler.toml` is not at the repository root,
and a Wrangler command that finds no configuration falls back to *automatic
project configuration*, which opens a pull request against the repository.

`wrangler preview` only runs for preview builds — pushes to branches other
than the production branch. With one branch it never fires; the flag is there
so that it cannot misfire if preview builds are ever switched on.

## Testing

Two tests, both real, neither needing a Cloudflare account.

```bash
./build.sh && ./tools/smoke.sh      # the Worker, on the real runtime
python3 tools/browser-test.py       # the interface, in a real browser
```

**`tools/smoke.sh`** starts the Worker with `wrangler dev` — which means the
real `workerd` runtime, the real `caches.default`, the real `fetch` — and
asks it the questions a visitor would: does the site load, does the health
endpoint answer, does a search return items with titles and URLs, is the
second search served from the cache.

**`tools/browser-test.py`** drives the interface in Chromium: nothing is
fetched until the visitor asks, the Worker answers a search, a broken Worker
hands over to the relays, and a second search cancels the first.

This exists because v0.5.1 shipped a Worker that had never been executed.
`wrangler deploy --dry-run` checks that the bundle builds. It cannot check
that the code runs.

## Layout

```
site/
  index.html
  assets/css/app.css
  assets/js/api.js      the data layer — Worker first, relays as the fallback
  assets/js/app.js      the interface — one bar, one button, one list
worker/worker.js        Cloudflare Worker data layer (deployed)
worker/wrangler.toml    the Worker configuration, including the assets binding
tools/smoke.sh          runs the real Worker and asks it real questions
tools/browser-test.py   drives the interface in a real browser
tools/bake_snapshot.py  historic: baked the old snapshot, no longer used
build.sh                stages site/ -> build/
docs/notes/             the working notes — the public, engineering half
  README.md             index: what to read before what
  project-state.md      layout, naming, the three backends, the hard-won rules
  worker.md             the live Worker, the edge/Google problem, the tests
  data-sources.md       Google News RSS, the operators, the verified endpoints
```

## Build

```bash
./build.sh                      # stage into ./build
zip -r ../output/ursift-vX.Y.Z-$(date +%F).zip site worker README.md CHANGELOG.md build.sh
```

## Rules this project keeps

- **A failed fetch must never look like an empty result.** It is the single
  most important rule in this interface.
- **Never fire a burst of requests on page load.** Free relays throttle per
  IP and then the site blames the network.
- **A piece that ships must have been executed.** Not bundled, not dry-run —
  *run*. The first version of the Worker was deployed without ever being run.
- **The snapshot is a fallback, never a default** — and as of v0.4.0 there is
  no snapshot at all.

## Working notes

`docs/notes/` holds the reasoning behind the code — the decisions made once and
not to be re-litigated, the numbers that were measured so they do not have to
be measured again, and the traps that each cost real time.

| File | Read it before |
|---|---|
| `docs/notes/product.md` | touching the project — what the owner actually wants (the saved layer, not the search box), the scope drift, and the next slice — **private, in the owner's notes repository** |
| `docs/notes/project-state.md` | changing structure — the layout, the naming, the three data backends, the verified feed facts |
| `docs/notes/worker.md` | deploying or debugging the Worker — why Cloudflare's edge and Google do not get along, and the tests that guard it |
| `docs/notes/data-sources.md` | touching the source layer — Google News RSS, its operators, the verified free endpoints, the source modes |

They live in the repository so they survive a new chat: clone the repo and read
the file that matches what you are about to do. **These notes are public and
need no credentials.** The parts that are about the owner rather than the code
are kept in a separate private repository; this one points there rather than
duplicating them.
