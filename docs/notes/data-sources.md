# Feed data sources — verified findings

> Verified free data sources and query-operator behaviour for the side project:
> Google News RSS, the `site:` / `OR` operators, the broken date operators,
> direct outlet feed availability, publisher-URL resolution, and the source
> modes.
>
> All findings below were empirically checked with curl from the sandbox, not
> assumed. **Re-test before relying on them at build time — free endpoints
> change.**

## Google News RSS — the backbone

`https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en`

- **200, no API key, no signup, no stated quota.** Free.
- Accepts arbitrary natural-language queries, including full questions
  ("is there an ongoing war right now" → 54 items).
- **Honours the `site:` operator natively** — verified:
  - `btc halving` → 54 items
  - `btc halving site:reuters.com` → 47
  - `btc halving site:bbc.co.uk` → 6
  - `btc halving (site:reuters.com OR site:bbc.co.uk)` → 54 (clean union)
  - `btc halving (site:reuters.com OR site:bloomberg.com)` → 100
- **`when:7d` silently returns 0 items.** Accepted, then broken. Any
  date-window operator must be handled client-side against the item's
  `pubDate`, never passed upstream. Same risk applies to `after:`/`before:` —
  verify before using.
- Item `<title>` has `" - Publisher"` appended → publisher name is available for
  free source labelling in the UI.
- **Risk:** undocumented, unofficial interface. Google could throttle or remove
  it. Mitigation: build the *recurring* watchlist on stable publisher feeds and
  treat Google News RSS as the fallback for one-off queries.
- **Google's bot-check is UA-sensitive.** `curl/8.x` gets the real feed; a full
  Chrome User-Agent got 429. A browser-style UA is the *worse* choice against
  this endpoint. A 302 to `https://www.google.com/sorry/index?continue=…` means
  the soft block, not a broken URL — `curl -L` masks it, and a naive client
  sees HTML instead of RSS.

## Other free endpoints

| Endpoint | Result |
|---|---|
| `bing.com/news/search?q=<q>&format=RSS` | 200, works, no key — usable second index |
| `hn.algolia.com/api/v1/search?query=<q>` | 200, free, no key, JSON |
| `hnrss.org/frontpage` | 200, 20 items |
| `feeds.bbci.co.uk/news/world/rss.xml` | 200, 19 items |
| `rss.nytimes.com/services/xml/rss/nyt/HomePage.xml` | 200, 19 items |
| `www.theguardian.com/world/rss` | 200, 45 items |
| `feeds.arstechnica.com/arstechnica/index` | 200, 20 items |
| `feeds.bloomberg.com/markets/news.rss` | 200, 20 items |
| `techcrunch.com/feed/` | 200, 20 items |
| `www.engadget.com/rss.xml` | 200, 20 items |
| `www.ft.com/rss/home` | 200, 12 items |
| `feeds.npr.org/1001/rss.xml` | 200, 10 items |
| `www.theverge.com/rss/index.xml` | 200, 10 items |
| `www.reddit.com/r/<sub>/.json` | **403** — needs OAuth |
| `rsshub.app` (public instance) | **403** — Cloudflare wall; self-host (AGPL, ~46k stars) |
| `mastodon.social/api/v1/timelines/public` | **422** — requires auth now |
| `apnews.com/index.rss` | **403** |
| `feeds.reuters.com/reuters/topNews` | **000** (connection failed) |
| `reuters.com/arc/outboundfeeds/rss/?outputType=xml` | **404** — endpoint retired |
| `feeds.wsj.com/rss/RSSMarketsMain` | **000** (connection failed) |

**Key finding:** Reuters, WSJ and AP — three of the highest-trust outlets —
have no working direct feed from here. That argues for routing "preferred
sources" through the Google News `site:` operator rather than through feed
discovery.

## Paid search fallbacks (only if general-web results are needed)

- **Brave Search API** — $5 / 1,000 requests, $5 free credit/month (~1,000
  calls), **card required at signup**, and **attribution required** on the
  site. Free tier eliminated Feb 2026.
- **Serper** — ~$0.30–1 / 1,000, 2,500 free one-time (not monthly). Scrapes
  Google; Google took legal action against SerpApi in 2025 → continuity/legal
  risk.
- Do not build the foundation on either. Google News RSS covers the use case
  free.

## Architecture consequence

"Preferred sources only" = ONE query with the user's domains OR'd in:
`(site:a.com OR site:b.com OR ...)`. No fetch-then-filter (which loses items
the index ranked below the cut), no per-source plumbing. All three source modes
ride on the same single endpoint.

## Google News links must be resolved server-side

The RSS `<link>` is an opaque `news.google.com/rss/articles/CBMi…` ID. Three
things verified by test:

1. **Base64-decoding the ID no longer yields the URL.** The decoded payload is
   now `AU_yqLMku_5vtKO79…` — protobuf-ish, no embedded `http`. (The old
   "base64 the CBM string to get the publisher URL" trick is dead.)
2. **`<description>` does not leak the real URL** — it contains the same Google
   `articles/CBM…` link.
3. **The link does not 302 to the publisher.** It returns HTTP 200 with a
   ~586 KB Google News interstitial, no article URL in the HTML.

**Working resolution (tested end to end):**

1. GET the `news.google.com/rss/articles/…` link with a browser UA → 200 HTML.
2. Scrape `data-n-a-sg` and `data-n-a-ts` attributes from the page.
3. POST `f.req=[[["Fbv4je","[\"garturlreq\",[[…],\"<article_id>\",\"<ts>\",\"<sg>\"]",null,"generic"]]]]`
   to `https://news.google.com/_/DotsSplashUi/data/batchexecute`
   (Content-Type `application/x-www-form-urlencoded;charset=UTF-8`).
4. The response contains `garturlres` with the real publisher URL.

Verified output:
`https://www.reuters.com/markets/currencies/crypto-fans-count-down-bitcoins-halving-2024-04-19/`

Do this in the Worker and cache it — a given article ID always resolves to the
same URL, so resolve once and store permanently. Then dedupe by real URL, label
the source by real domain, and the visited marker becomes meaningful.

**Note:** resolving a publisher URL costs two requests, and doing it for the
head of every result list is what got the Worker throttled (see `worker.md`).

## Source-preference modes — the empirical result that settles the design

General query vs site-restricted query for `peso price today`:

| Query | Items | Also in general list |
|---|---|---|
| general | 97 | — |
| `site:business.inquirer.net` | 88 | 1 / 88 |
| `site:philstar.com` | 100 | 1 / 100 |
| `site:reuters.com` | 100 | 0 / 100 |
| `site:bloomberg.com` | 99 | 0 / 99 |

The two lists are almost **disjoint**. Preferred-source articles are not merely
ranked low in the general result — they are **absent** from it. The general list
for that query was crypto/forex noise (sources: StoneX, Mexperience, CryptoRank,
MUFG Research, Facebook) and carried no Reuters peso coverage.

**Consequence:** "sort the general list so preferred sources float up" is a
broken implementation — it silently shows zero of the user's own sources. "My
Sources First" must issue a **separate `site:` query** and merge the two result
sets.

Final mode set:

1. **All Sources** — 1 query, general. Default for first run.
2. **My Sources First** — 2 queries (`(site:a OR site:b) q` + `q`), preferred
   first.
3. **My Sources Only** — 1 query, `site:` only.

Present as two labelled sections ("From your sources" / "Everything else") rather
than one interleaved list, so the guarantee is visible.

Also: `source:Reuters` works as a shorter alternative to `site:reuters.com` and
returns a *different* set (36 vs 100 items). Prefer `site:` for user-entered
domains; use `source:` when the `site:` list gets long. Cap `site:` OR-lists at
~10 domains per request for URL length.

## Recency

Google News sometimes returns **genuinely old articles** with a fresh `pubDate`
(verified: a Reuters item dated 2024-04-19 surfacing under "btc halving").

But **`pubDate` IS the real publication date** — eight `site:reuters.com`
articles were resolved back to their publisher URLs and every `pubDate` matched
the article's actual date (e.g. `Fri, 19 Apr 2024 07:00:00 GMT` for an article
whose URL ended `…crypto-fans-count-down-bitcoins-halving-2024-04-19/`). So a
calendar rule ("published today → New") is trustworthy on this field.

The `site:` list for "btc halving" was mostly 2023–2024 Reuters coverage; the
general (unrestricted) list was fresh. Consequence: **recency filtering on
pubDate is mandatory**, or "My Sources First" shows a 2023 piece above today's
news and the mode looks broken. Default to 7 days, applied client-side; if
nothing survives, show older matches with a note rather than an empty list.

## Regional editions

`hl=<lang>-<COUNTRY> & gl=<COUNTRY> & ceid=<COUNTRY>:<lang>`

| params | items | top sources |
|---|---|---|
| `hl=en-US&gl=US&ceid=US:en` | 56 | 24/7 Wall St., Yahoo Finance, Galaxy |
| `hl=en-GB&gl=GB&ceid=GB:en` | 57 | 24/7 Wall St., eToro, Galaxy |
| `hl=en-US&gl=AU&ceid=AU:en` | 56 | 24/7 Wall St., CMC Markets, eToro |
| `hl=es-419&gl=MX&ceid=MX:es-419` | 53 | Revista IMEF, TradingView |
| `hl=en-US&gl=PH&ceid=PH:en` | **0** | — |

- **Region genuinely changes the result set** — regional sources appear (Revista
  IMEF for MX). The region control is real, not cosmetic.
- **`PH:en` returns zero items.** Not every country has an edition in every
  language. The region list must be a **validated table** (country → available
  edition → fallback chain: language match → `US:en`), never a free-form
  country/language grid.
- Label the control **"News region", not "Language"** — it changes which news
  you get, not the UI language.
- **Correction:** an earlier note claimed `hl=en-PH&gl=PH&ceid=PH:en` was
  invalid. It is not — that combination works fine and returns a full feed.
  What returns zero is the *mismatched* `hl=en-US&gl=PH`. Regional editions are
  fine.

**Free location signals if regional awareness is wanted later:** the browser
`Accept-Language` header and `request.cf.country` on the Worker (Cloudflare
gives the country free — no geo-IP service, no third party, no privacy
question). The dropdown overrides both.

**"My Sources" is already the regional control** — for "peso price today" the US
general feed gave crypto noise while `site:business.inquirer.net` gave 88 real
peso stories. Adding local outlets to your sources gives local coverage with
no region system. One mechanism, two jobs.

## Rate limiting and caching

Hit **HTTP 429 Too Many Requests** from Google News RSS after ~50 rapid
requests in one session. A daily refresh won't approach that, but it confirms
caching is mandatory, not theoretical.

Design consequence: cache the whole pipeline — query → raw RSS → resolved real
URLs → final list. A resolved URL never changes for a given article ID, so
cache it permanently. **On a failed refresh, show the last good results with a
timestamp, never an error screen.** "Here's what we found 3 hours ago" is a
feature for a daily-digest tool; an error is how you lose a daily user.

## Google Trends RSS — works, but is the wrong empty state

`https://trends.google.com/trending/rss?geo=US|GB|PH` → HTTP 200, 10 items, no
key. The US sample was `derek jeter`, `alex rodriguez`, `david ortiz`,
`rihanna`, `kelly oubre` — sports and celebrities. Viral noise, the opposite
of a personal watchlist, and it teaches the wrong lesson about the product. Use
**prefilled example watchlist entries** as the empty state; keep Trends as an
optional separate strip only.

## Reachability boundaries and the SSRF requirement

### The "no unreachable sites" boundary is structural, not policed

`site:` searches **Google's index**; it does not fetch the user's named
domain. The typed domain can only *narrow* what Google already has.

| Query | Items |
|---|---|
| `site:example.com` | 1 |
| `site:this-domain-does-not-exist-zzz123.com` | 0 |

So there is no code path to a darkweb market or anything else outside the
indexed web — not because a filter blocks it, but because Google has never
indexed it. **Do not add a bespoke blocklist for the normal `site:` path; it
would be cargo-culting a guarantee the architecture already makes.**

### The requirement appears only if we ever fetch a user-supplied URL

Direct RSS fetching of a preferred source (a v2 idea) would make the user's
input control a fetch, and a Cloudflare Worker fetching `http://169.254.169.254/…`
is a textbook edge-function SSRF. Guard when that path is added:

- http/https only
- resolve DNS, reject loopback / private / link-local (127/8, 10/8, 172.16/12,
  192.168/16, 169.254/16)
- explicitly reject `.onion` and `.i2p` — documents intent even though neither
  resolves from Cloudflare (no Tor, no exit nodes)

### Small personal blogs ARE reachable — "My Sources" is not news-only

| Domain | Google News `site:` | Own RSS feed |
|---|---|---|
| arstechnica.com | 100 | 20 |
| simonwillison.net | 73 | 30 |
| jvns.ca | 60 | 20 |

The two paths differ in character: **own feed** → last ~20 posts, fresh by
construction; **`site:`** → 60–100 items including years-old coverage.

**v1 decision: `site:` only.** Covers news outlets *and* small blogs, one
endpoint, no feed discovery, no extra fetch surface, no SSRF question. Feed
fetching is v2 and arrives with the SSRF guard above.

## Source naming

### Sources must be captured from results, not typed by name

- **`source:` breaks on multi-word names.** `source:Reuters` → 68 items;
  `source:Ars Technica` → **1 item** (vs `site:arstechnica.com` → 100). The
  space splits the operator into `source:Ars` + term "Technica". Only
  single-token publisher names work.
- **Searching the name finds coverage *of* the entity, not its own articles.**
  Querying "Bank of the Philippine Islands" returned publishers Yahoo Finance,
  Bloomberg, InsiderPH, GuruFocus, TradingView — none of them BPI. No domain
  can be extracted from that.
- **BPI's corporate site is not in Google News at all.** `site:bankofphilippines.com`
  → **0 items**. A bank's rate announcements are not news articles.
  (`site:bpi.com.ph` → 64, but that is a different site from BPI's corporate
  domain, and "BPI" as a bare name is ambiguous.)

**Working mechanism:** every RSS item already carries
`<source url="https://www.philstar.com/">Philstar.com</source>` — display name
AND domain, free, for every publisher in every result. So the "+ add this
source" button on an article row captures both in one click: no typing, no name
resolution, no ambiguity.

If the user does type a name, validate it: probe with the name, check whether
any result's `<source>` name matches. Match → take that domain. No match → say
so plainly ("No indexed source matches 'X' — try adding it from an article").
Honest failure beats silently returning nothing.

Verified reachable Philippine publishers for demos: `site:philstar.com` → 100,
`site:business.inquirer.net` → 88, `site:bpi.com.ph` → 64.

### Manual source-name typing is deliberately forgiving

Owner decision: do not be strict about typos. If the user types a source name,
resolve **best-effort** and show results from sources close to what they typed;
they will notice a wrong resolution and correct it in place.

Matching ladder against publisher names pulled from result metadata:

1. normalised exact match (lowercase, strip punctuation/spaces)
2. one is a prefix of the other
3. Levenshtein ratio ≥ 0.75
4. acronym match over significant words, ignoring stopwords (of, the, and, for,
   de, ng) — "BPI" → Bank, Philippine, Islands → BPI ✓ · "MCR" → My Chemical
   Romance ✓

Unification: **typing a source name always runs "My Sources First" with a
best-effort resolved source list.** No match → fall back to "All Sources" with
an honest note ("No source matched 'BPI' — showing general results"). One code
path, no dead end. Resolution is one extra query, cached per source.

### The source list is global, not per-query

"+ add this source" on any result row adds that publisher to a **global** source
list used by every "My Sources First" query. This is safe despite being global:
`(site:a OR site:b) <query terms>` intersects, so irrelevant sources contribute
nothing. Per-query overrides are possible later but are not needed.

## The year filter is CLIENT-SIDE, not another query

No working date operator exists (`when:7d` → 0 items). The year is a filter on
`pubDate` applied to already-fetched results. One request.

**But it is bounded by Google's top ~100.** Material varies hugely:

| Query | Items | Spread by year |
|---|---|---|
| `bitcoin halving` | 59 | 2026: 17 · 2024: 28 · 2023: 5 · 2020: 6 · 2019: 1 · 2018: 1 · 2014: 1 |
| `peso exchange rate` | 100 | 2026: 96 · 2025: 4 |

- The year dropdown genuinely has material behind it ("bitcoin halving" reaches
  2014).
- **"This Year" default buries the good stuff for exactly those queries** — 28
  items from 2024 vs 17 from 2026 on a halving query.
- Empty-state failure must be stated honestly: "No 2024 results in this snapshot
  — Google returned 100 items, all from 2026 or later."

**Recommended default: "This week", not "This Year"** — the daily ritual needs
recency so items age out and the Published Today shelf stays meaningful. "This
Year" stays one click away.

### One dropdown, not two

Redundant "period" + "year" dropdowns conflict. Single grouped list:

```
Latest (default)          ← ambiguous: it does not name a window
─────
Today · This Week · This Month · This Year
─────
2025 … 2000
─────
All Time
```

A **year floor of 2000 is fine** — the list is static, so a generous range costs
nothing, and the empty state does the explaining.

## Grouping — the priority cascade

Strict priority, one group per item, no overlap:

**Read → Published Today → Unread**

- "Published Today" is a **shelf**: items graduate down to Unread tomorrow when
  the date stops matching.
- Needs no per-query history — only a set of clicked URLs.
- **Unread is a graveyard** — items only leave by being read. Cap it (~20 most
  recent + "show more") and make it collapsible.
- **Timezone matters:** pubDate is GMT. "Today" must use the user's local day,
  and the year boundary must be local 1 January. Otherwise an 8am UTC+8 user
  sees yesterday's articles labelled today.
- Gives up "new since I last looked" — irrelevant for a daily user, matters
  only for someone checking every 3+ days.

"Published today" / "Unread" / "Read" **overlap** — an article can be published
today AND already read. They cannot all be sections. State is the top-level
section; source preference is the sort within each section. Collapse **Read
behind a count** (`READ (14)`).

## Ignored Links

- Any link can be ignored regardless of state.
- Ignored links move to a **separate "Ignored Links" page**, not a fourth
  section.
- **Retention is user-set**: 7 / 14 / 30 / 90 days, or keep indefinitely. The
  chosen expiry is stamped per ignore entry.
- **After expiry the article naturally reappears** in normal results — it is
  simply no longer in the ignore set.
- Expiry must be evaluated **at render time**, not only at refresh time, or an
  item stays hidden for a user who opens the site days later without
  refreshing.
- Ignore is keyed on the **real article URL**, so it applies across every query
  — ignoring an article removes it from all queries, which is correct: the
  article is ignored, not the topic.
- Ignored ≠ read. Do not dim ignored items as if they were read; they have
  their own visual state.
- **Caveat to state in the UI:** an ignored article only comes back if the
  query still surfaces it. Google returns ~100 items max, and if the article
  fell out of that window it simply vanishes rather than reappearing.
- Affordance: a muted `✕` at the end of each row (not a text label). A
  keyboard shortcut is also worth adding.
- The ignore list, with its expiry timestamps, **must be in the export file** or
  ignores are lost when the user moves device.

## The home screen must be a dashboard, not the articles

The watchlist is the product, so the home page lists **queries** with counts
(`3 new · 12 unread`) and the mode, expanding to the grouped article list on
click. Rendering every article from every query produces the wall of links the
brief explicitly rejects, and does not scale past ~8 queries.

## The relay layer, measured properly

Everything here was measured with curl against live services, not remembered.

**The feeds themselves are healthy. The relays are the bottleneck.**

- **Google News RSS direct: 0.39 s, 48–100 items**, never bot-blocked from a
  plain `curl` UA. A full Chrome User-Agent is actually *worse* (Google 429s
  it).
- **allorigins only serves queries it has already cached.** A fresh,
  never-fetched query took it **24.6 s and then returned HTTP 408 "Oops...
  Request Timeout"**, or 500, or 522. The same query direct took 0.39 s. So
  allorigins is not blocked by Google — it simply cannot fetch a cold Google
  News RSS inside its own upstream budget.
- **allorigins' ERROR responses carry NO `Access-Control-Allow-Origin`
  header.** A 522 therefore reaches the browser as *"blocked by CORS policy"*,
  not as an HTTP error. This is why the old version's failures looked like a
  CORS bug. Its *successful* responses do carry ACAO, and it **reflects the
  Origin header**.
- **`/get` and `/raw` are different cache keys.** When `/raw` is cold and
  522s, `/get` is often warm and answering. `/get` wraps the body as
  `{"contents": "<body>"}` (JSON) — parse the `contents` field; `/raw` returns
  the body directly. Its error pages are plain text, not JSON.
- **cors.lol sends `ACAO: *` and fetches FRESH queries in ~1.2 s** (100 items
  for Google, 8 for Bing). But it allows roughly **one request and then 429s
  for minutes**. A 429 means "come back shortly", not "broken" — it is worth a
  wait-and-retry rather than being dropped.
- **Bing News RSS direct is 0.28 s**, links are `apiclick.aspx` wrappers with
  the publisher URL in the `url=` param. But **its coverage collapses** — 1 item
  for "peso price today", 11–14 for "btc halving". It is the second opinion,
  not the backbone.

### The lesson that cost the most

**A relay's error response has no `Access-Control-Allow-Origin` header, so the
browser never shows us its status code.** A 429, a 500, a 520, a 522 and a dead
connection all arrive at `fetch()` as the same generic **"Failed to fetch"**.

This broke the retry logic completely: it was written to look for `\b429\b` or
`\b5\d\d\b` in the error message, and the browser never reveals either. Every
transient failure therefore looked like a dead network and was dropped
immediately — so the retries never ran, and the one thing that would have
waited out a rate limit could never wait.

**The fix:** treat a generic fetch failure as transient and retry it, because
the status that would have identified it is never visible in the first place.

**This is a general browser-CORS fact, not a project quirk.** Any time a
cross-origin API can answer with an error status that lacks CORS headers, the
client sees a network error, not the status. Retry on the *absence* of an
answer, not on the code.

### Other relay facts

- **codetabs → 522 every time** (~20 s). **cors.lol → 429.**
  **corsproxy.io → 401**, needs an API key now. **corsfix → 400** without an
  `Origin` header (a real browser sends one, so it may work in-browser).
  **whateverorigin → 200** but a shape we do not parse. **Yahoo News RSS
  (500/429), Mojeek (403), Startpage (HTML, no RSS) and thingproxy (dead)**
  are all non-starters.
- The live relay set is allorigins (`/get` + `/raw`) and cors.lol, raced
  against each other.
- **Google News links are fine for a human.** The `news.google.com/rss/articles/…`
  interstitial (570 KB) auto-redirects to the publisher in under 2 seconds in a
  real browser, and on the live site the first result landed on coingecko.com.
  It is NOT broken; it is one hop.
