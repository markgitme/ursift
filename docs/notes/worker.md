# ursift — the live Cloudflare Worker

> How it failed four times before it worked, why Cloudflare's edge and Google
> do not get along, and the test tooling that now guards it.
>
> Read before deploying or debugging the Worker.

Live at `https://ursift.ursf.workers.dev` — Workers + git integration on
`markgitme/ursift`, production branch `main`.

Cloudflare dashboard fields:
**Build** `./build.sh` · **Deploy** `npx wrangler deploy --config worker/wrangler.toml` ·
**Preview** `npx wrangler preview --config worker/wrangler.toml`

The `--config` matters: `worker/wrangler.toml` is not at the repo root, and a
Wrangler command that finds no configuration falls back to *automatic project
configuration*, which opens a pull request against the repository.

---

## The lesson that cost the most

**`wrangler deploy --dry-run` checks that the bundle builds, not that the code
runs.** v0.5.1 shipped a Worker that had never been executed: `cacheGet(req,
key)` was declared with two parameters and called with one, so
`caches.default.match(undefined)` threw `Invalid URL: undefined` on every
search. The live site answered 502 for every query and the cause was one word.

A dry run, a successful deploy and a green `wrangler` banner are not evidence.
**Run the thing.**

## The four releases it took

- **v0.5.2** — fixed the signature. The Worker path became primary; the relays
  became the fallback (Worker first, relays take over only when it does not
  answer at all; a Worker answering with zero items is a real answer and is
  never second-guessed).
- **v0.5.3** — the Worker swallowed feed failures with `.catch(() => '')` and
  then **cached the emptiness for an hour**, breaking ursift's founding rule
  (*a failed fetch must never look like an empty result*). Now: three attempts,
  502 when both feeds fail, and a result that came out of a failed fetch is
  never cached. The same release fixed two more: the resolution budget blew
  Cloudflare's 50-subrequest-per-invocation limit (40 items x 2 requests = 82),
  and the route returned only the resolved head, so 97 results became 12.
- **v0.5.4** — Google is the backbone. If Google failed and what was left was
  nothing, the Worker answers with an error rather than an empty list, because
  Bing answering with an empty feed is not an answer. The cache key carries a
  version so a deploy never inherits a poisoned cache.
- **v0.5.5** — Google began answering Cloudflare's edge with **HTTP 503** and
  every search took 20–27 s. The cause was this Worker being too loud:
  resolving a link to the publisher's own URL costs two requests, and the
  search path resolved the head of the list, so one search made 26–80 requests
  to Google from a single IP. Now **a search costs two requests** (the feed and
  the second-opinion feed), and **a link resolves when the visitor reaches it** —
  the pointer rests on it or it takes focus, then `/api/resolve` is asked for
  that one article. Each feed attempt has a 5 s budget, and a 4xx is treated
  as an answer rather than as something to retry.

## Cloudflare's edge and Google do not get along

Measured on 2026-10-30:

| path | result |
|---|---|
| sandbox → Google News RSS | 0.29–0.37 s, 100 items, every time |
| Cloudflare edge → same feed | **bimodal**: sometimes 0.5 s with 58–100 items, sometimes stalling past 5 s or 503ing at ~8.7 s |
| Cloudflare edge → a news.google.com article page | the same bimodality (0.56 s, 5.2 s, 8.3 s, 9.1 s) |
| Cloudflare edge → Bing News RSS | always fast (~0.19 s) but thin (4–12 items) |
| sandbox → Bing News RSS | 200, 5 items |

The article page shows the same shape as the feed, so it is the **edge's path to
Google**, not one endpoint. The most likely cause is cumulative volume earning
the edge's IP range a penalty from Google — the sandbox IP was never affected.
Corollary: **a Cloudflare Worker fetching Google in a loop gets itself
throttled.** Keep the request count per search small.

## The root cause, found 2026-10-31 (v0.5.9)

**Google rate-limits by IP address, and every Cloudflare Worker shares one pool
of egress addresses.** When the pool is warm, Google answers the edge with
HTTP 429, or HTTP 200 with a body containing no articles.

Proved from a real edge using `wrangler deploy --temporary` (a throwaway
Cloudflare account — **no push needed to test on the real edge**), same feed,
four User-Agents: the honest one hung at 8 s, a Chrome string 503'd at 5.1 s,
`Cloudflare-Workers` 503'd at 7.5 s, `curl/8.0` hung at 8 s. **All four fail —
it is not the User-Agent.** The same feed from the same edge through `cors.lol`
answered in 1.5 s with 109 items. The feed is fine; the edge's address is the
problem.

**The bug it exposed:** a valid feed with zero articles is an *answer* (a query
nobody has written about yet). The race treated "no `<item>`s" as a failed
route, so such a query returned 502 *could not reach the feeds* instead of an
honest *nothing matched* — the mirror of the founding rule. A route now counts
as answered when the body is a feed document (`<rss>`, `<feed>`, `<channel>`).

Also fixed: `/api/resolve` had **no timeout at all**, so a hung Google fetch
hung the whole Worker request and every hovered link cost one.

**Method worth repeating:** `wrangler deploy --temporary` creates a throwaway
Cloudflare account and prints a `*.workers.dev` URL — real edge, real colo, no
push, no credentials, and it never touches the owner's site. Caveat: an
unclaimed temporary account sits behind a Cloudflare bot challenge, so `curl`
gets 403 challenge pages intermittently; retry, or drive it with a real
browser. Use `wrangler whoami` to confirm there are no credentials of your own.

## What the owner's old working code taught us

He attached the simple version that used to work: a page that fetched
`api.allorigins.win/get?url=` + the Google News RSS and rendered the items.
Two things in it were right and we had stopped copying them:

1. **It never fetched Google directly** — always through a relay. Google's
   limiter works on IP addresses, every Worker shares one egress pool, and the
   limiter treats that pool as one very busy customer. A relay asks from an
   address that is not Cloudflare's; a visitor's browser asks from an address
   nobody else has.
2. **It always asked for one URL**, so the relay had it cached. Every new query
   is a cold fetch — slower, and the first one to a busy relay can fail
   outright.

**Correction to an earlier note: the direct edge→Google route is INTERMITTENT,
not dead.** It answered from the edge many times — 0.13 s with 55, 99 and 103
items. It fails with 429s or an empty body when the limiter is in a bad mood.
v0.6.0 removed it on the evidence of one bad run; v0.6.1 put it back. **Never
conclude a shared-IP path is dead from a single sample.**

**The relays throttle Cloudflare's pool as well as private addresses.** From the
edge they answer 429; from this sandbox's own IP they sometimes answer in 1.0 s
with 48 items. So the Worker's relay budget is shared with the whole internet,
and the visitor's is private — which is why both paths are worth keeping.

**v0.6.0** removed the resolve-on-hover feature (it needed Google fetched
straight from the edge, so it mostly failed, and every hovered link cost a
request), the resolver's dead code, and added newest-first ordering.
**v0.6.1** restored the direct route.

**v0.6.2** — the interface now asks the **Worker and the relays at the same
time** instead of waiting for the Worker to give up. The Worker is the fast
path when Google lets it through (0.13 s, ~100 items); the relays ask from the
*visitor's* address, which nobody else shares, so they are the reliable path.
A **thin** answer does *not* stop the other path: the fuller list is still on
its way. The Worker also stops the second feed the moment the first answers
(it was holding responses for up to nine seconds for a feed it did not need),
and the warning copy now says what actually happened — which feed failed and
how many results there are because of it.

**v0.6.3** — the logs can be read, and nothing is lost.

## The tests that guard it

Both are in `tools/` and both need no Cloudflare account.

- **`tools/smoke.sh`** — starts the Worker with `wrangler dev` (the real
  `workerd` runtime, the real `caches.default`, the real `fetch`) and asks it
  the questions a visitor would: does the site load, does `/api/health`
  answer, does a search return items, is the whole list returned, is the
  search quiet, does one link resolve on demand, is the repeat search cached.
- **`tools/browser-test.py`** — drives the interface in real Chromium: nothing
  is fetched until the visitor asks, the Worker answers, a broken Worker hands
  over to the relays, a second search cancels the first, and reaching a link
  asks the Worker to resolve it.

They caught v0.5.3's truncation (12 items instead of 97) and v0.5.5's
resolution regression. Run both before every release.

Sandbox notes: `wrangler` is installed globally (4.156.0) — `npx` intermittently
fails with `EBUSY` when runs overlap. Playwright is **Python**, and its
chromium lives at `/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome`
while `HOME` is `/workspace/.home`, so the path must be given explicitly.

## Where this was left

The Worker is finished as far as we are taking it: it is a **fast path, not the
backbone**. The next work is the saved layer (the sifter — saved sources,
saved queries, export/import), and the fetch should stay in the visitor's
browser, because that is the path that still returns a full list.

**Do not re-derive the edge intermittency.** Before touching the Worker again,
let the edge alone for a while and take a clean sample of the success rate —
repeated testing from the same address is itself what earns the penalty, so a
measurement taken right after heavy testing is not a measurement.

Also still open: the ursift GitHub PAT was pasted in chat in plaintext and
needs rotating, scoped to `markgitme/ursift` only. The health badge's
`lastSuccess`/`lastRoute` are per-isolate and reset when the isolate is
recycled; KV would make them durable.
