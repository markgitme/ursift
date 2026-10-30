# Changelog

## v0.5.5 — the Worker stops shouting, and a link resolves when you reach it

Google started answering Cloudflare's edge with **HTTP 503**. Every search
took 20-27 seconds and returned a handful of items. The sandbox could still
reach Google in 0.37 s, so Google was not down — this Worker was too loud.

### Why it was too loud
Resolving a Google News link to the publisher's own URL costs **two
requests**. The search path resolved the head of the list, so one search cost
**26 to 80 requests** to Google from a single IP. That is what a scraper
looks like, and it is what earned the 503s. (The same 40-item head also blew
Cloudflare's own limit of 50 subrequests per invocation, which is why the
links came back unresolved.)

### The search is quiet now
- A search costs **two requests**: the feed, and the second-opinion feed.
- The list is served the way the feed has it.
- A link is resolved **when the visitor reaches it** — the pointer rests on
  it, or it takes focus. One request, for the one article somebody is about
  to click. If the resolution fails, the Google News link stays, and it
  still works.

### A slow answer is cut off
Google's 503 took 8.7 seconds to arrive, so three attempts of it was 26
seconds of waiting. Each attempt now has a 5-second budget, and a 4xx is
treated as an answer rather than as something worth retrying.

### The note says what is true
"links open through Google News, and resolve to the publisher as you reach
them".


## v0.5.4 — Google is the backbone, and a deploy never inherits a poisoned cache

Two more things the live Worker was getting wrong, both found by reading what
it actually returned.

### "Nothing matched" was sometimes a lie
The Worker is honest about a failed feed, but it was still answering with an
empty list in one case: **Google failed, and Bing's second-opinion feed came
back with nothing.** Bing's feed answers with an empty list for most queries,
so that combination looked exactly like "no results for this wording" — when
in fact the search was never really answered.

Google is the backbone, so now: if Google failed and what is left is nothing,
the Worker answers with an error instead of an empty list, and the interface
falls back to the relays.

### A deploy could not clear a bad cache
The edge cache was keyed by the query and the region alone. A failure cached
by an older build stayed cached for its whole hour — so a deploy that fixed
the bug still served the broken answer to anyone who searched the same words.
The cache key carries a version now, so every deploy starts clean.


## v0.5.3 — a failed feed is no longer allowed to look like an empty result

v0.5.2 made the Worker run. It ran, and the live site started answering — but
three things about it were wrong, all of them found by looking at what the
deployed Worker actually returned rather than at what it was supposed to
return.

### The Worker was swallowing feed failures
`fetchText(...).catch(() => '')` turned a failed fetch into an empty feed, and
the empty feed was then **cached for an hour**. A query that failed once
stayed empty for the rest of that hour — which is exactly the thing this
project's first rule forbids: *a failed fetch must never look like an empty
result.* The Worker was breaking the rule the whole site is built around.

- The feed is fetched with up to three attempts, spaced 500 ms and 1 s.
- If **both** feeds fail, the Worker answers 502 rather than an empty list,
  and the interface falls back to the relays.
- If **one** feed fails, the other's items are shown and the failure is
  reported.
- A result that came out of a failed fetch is **not cached**.

### The resolution budget was blowing the subrequest limit
Resolving one article costs two requests, and the head of the list was 40
articles — 80 requests against a limit of 50 per invocation. The limit was
hit, every resolution failed, and all 40 links came back as Google wrappers.
Measured on the live Worker: 10 items resolved perfectly, 40 items resolved
to nothing.

- The head is now 12 articles (26 requests).
- The rest of the list keeps its Google News link, which works.

### The list was being cut short
The route returned only the resolved head, so the site showed 12 results out
of 97. The whole list is returned now, and the response carries `total` so
the tests can catch it if it ever happens again.

### The note tells the truth
"links open through Google News" was printed under every result set, including
the ones whose links went straight to the publisher. The note now says which
is which.

### The tests caught all three
The smoke test found the truncation (12 items instead of 97). The browser
test found the link assertion was wrong. Both were written before the fix,
which is the point: a test that never fails is not a test.


## v0.5.2 — the Worker actually runs

v0.5.1 shipped a Worker that had never been executed. Every search threw
`Invalid URL: undefined` before it reached a feed, so the live site answered
502 and nothing else. The cause was one word: `cacheGet` was declared with
two parameters and called with one, so `caches.default.match()` was handed
`undefined` and threw.

### The fix
- `cacheGet(key)` — one parameter, two call sites.

### The Worker path is the primary path now
The Worker answers a search in about a second and resolves publisher URLs
server-side, so results point at the publisher's own site. The relays are
the fallback, not the other way round.

### One broken path no longer takes the site down
If the Worker does not answer — a network error, a server error, or a
silence — the relays take over. A Worker that answers with **zero** items is
a real answer and is never second-guessed, because that would turn "nothing
matched" into a slow, misleading second opinion.

### The Worker cannot leave the interface spinning
- The probe and the search each get a budget of their own (10 s and 20 s).
- A Worker that misses its budget hands over to the relays.
- The reason is on the record: the technical details name it.

### The abort signal actually arrives
The interface created an `AbortController` for every search and aborted the
previous one — but never handed the signal to the data layer, so the
requests were never really cancelled. The generation guard hid it: stale
results still could not paint over a newer search. Now the requests are
genuinely aborted, and the browser test proves it (`net::ERR_ABORTED`).

### The tests that would have caught it
- **`tools/smoke.sh`** runs the **real** Worker on the **real** runtime
  (`wrangler dev` -> workerd): real cache, real fetch, real code. It asks
  the questions a visitor would. No Cloudflare account needed.
- **`tools/browser-test.py`** drives the interface in a real browser: nothing
  loads until the visitor asks, the Worker answers, a broken Worker hands
  over to the relays, a second search cancels the first.

`wrangler deploy --dry-run` checks that the bundle builds. It cannot check
that the code runs. That gap is why v0.5.1 shipped broken, and why both
tests now run before every release.


## v0.5.0 / v0.5.1 — one feed, cancellable searches, stop when done

The relay layer is rebuilt around what was actually measured, and the two
structural problems are fixed.

### Searches cancel each other
A search is now a **generation**. Starting a new one aborts the previous
one's requests, and a stale answer can never paint over a newer search.
Previously a late arrival replaced your results with the **previous query's**
results, and an abandoned search's error panel appeared minutes later over a
search you had already moved on from.

### Nothing runs in the background once the list is on screen
- The losing relays are **aborted** the moment one answers.
- The retry chain stops when a search is cancelled, instead of firing its
  remaining attempts at a relay nobody is waiting for any more.
- The hard deadline **aborts the requests**, rather than only stopping the
  interface from waiting.

### Bing is dropped from the browser path
It cost two of the five requests a search used to fire, brought its own
failure states, and merged only 1–14 items against Google's 84–100. Its real
value — publisher URLs that need no Google hop — is done by the Worker, which
resolves them server-side where a browser cannot.

### The timeouts are reshaped
`allorigins` is flaking rather than throttling, so it is retried often and
briefly: 12 s per attempt, 3–4.5 s apart, up to six attempts, bounded by the
search deadline. `cors.lol` is rate-limited, so it gets **exactly one request
per search**, waited out patiently. A search that used to take 57 s should
now take 10–15 s.

**v0.5.1** — a relay that fails *fast* (a 522 returns in a moment rather than
hanging) was burning its whole attempt budget in a few seconds and giving up
while there was still time left. Retries are now bounded by the deadline as
well as by an attempt count.

### The copy is honest
A relay's error response carries no CORS header, so the browser hides its
status code and every failure looks the same. The note now says **which relay
did not answer and how many attempts are left**, instead of guessing.

### The Worker is ready to be the real answer
- Its User-Agent is now honest rather than a Chrome impersonation. Measured
  against Google News RSS: the honest UA got **100 items** where the Chrome
  impersonation got 57.
- It serves the static site from an **assets binding**, so one deployment is
  the whole site — API and pages on one URL.
- `/api/health` reports the **last successful fetch**, not just "up".

## v0.4.1 — the relay layer, rebuilt after it failed in the field

v0.4.0 shipped and then failed every search for Mark, while the same searches
worked from the sandbox. The cause was not a mystery and not Google's fault —
it was three separate mistakes in how the relays were being used.

**1. The race was eating its own rate limit.** v0.4.0 fired 3 relays × 2 feeds
= 6 requests at once, two of them to `cors.lol` — which allows roughly one
request every few minutes. Asking it twice in one search burned its window.
`cors.lol` is now spent on the Google feed only: **exactly one request per
search.** allorigins, which has no practical limit, handles both feeds.

**2. The timeout was shorter than the job.** A cold Google News fetch through
allorigins legitimately takes up to about 25 seconds. The timeout was 15 s, so
the request was being killed just before it could answer. It is now 26 s.

**3. Transient failures were treated as permanent.** allorigins intermittently
answers 500/520/522 — it was seen serving 520 for a plain `example.com` while
working fine seconds later. Those now get retried with growing patience
(5 s, 12 s, 22 s), as does a 429.

**What was measured, and is now known rather than guessed:**
- Google News RSS direct: **0.39 s**, 48–100 items, never bot-blocked.
- allorigins **can** fetch a cold target — 54 items from Google, 8 from Bing,
  on a fresh query. It is slow and it flickers, but it works.
- cors.lol is the fast cold path (1.2 s, 100 items) and the strictest limit.
- rss2json is behind a Cloudflare challenge a browser cannot clear. Dead.
- Yahoo (500/429), Mojeek (403), Startpage (no RSS), corsproxy.io (401),
  corsfix (403), codetabs (522), thingproxy (dead), whateverorigin (returns
  HTML), cors.eu.org (429), isomorphic-git (403) — all non-starters.

**Also in this version:**
- A **100-second hard deadline**, so a bad afternoon at the relay cannot hang
  the page for ever. A deadline that expires with nothing to show is
  reported as a failure, never as "nothing matched".
- **The technical details now name the actual reason per relay** — the HTTP
  status, the timeout, or "did not return a feed" — instead of the useless
  "no relay answered".
- **A relay that is rate-limiting or stumbling says so on screen** while it
  waits, instead of leaving a silent spinner running.
- **A Cloudflare Worker on the same origin is now detected automatically**
  and used in place of every relay, with no rebuild. One `?q=__probe__`
  request decides it.

## v0.4.0 — the rename, and a rebuild down to one bar and one button

The project is now called **ursift**. "Watch" was dropped from the name: it
is too strongly tied to watching video and reels, and the product is the
opposite — text only, in a list.

### The name
Chosen by Mark on 2026-10-30 from a two-word device he proposed: a short
possessive plus a rare synonym of the filtering verb. The method works — of
61 names tested against the IANA RDAP servers, 56 were simultaneously free on
`.com`, `.tools`, `.site` and `.is`, where single common nouns were almost
universally taken. `urcomb` was the runner-up.

`ursift.com` was free at the time of checking.

### What changed
- **The watchlist is gone.** v0.4.0 is one long input bar, one button marked
  **Sift**, and a list of links. The watchlist, the three source modes, the
  grouping, the period filter, ignore-with-retention and export/import are
  not in this version.
- **Nothing is preloaded.** No sample queries, no articles on the screen
  before you ask, and no network request at all until the button is pressed.
  The baked snapshot is deleted — with the examples gone it had no content to
  be a fallback to.
- **Two feeds instead of one.** Google News RSS is the backbone (84–100
  items); Bing News RSS is the second opinion, and its links are the
  publisher's own URL, so a headline both feeds carry opens directly rather
  than bouncing through Google.
- **The relay timeout is fixed.** `allorigins` needs up to ~20 s on a cold
  cache; the old 9 s budget aborted before it could answer, which is why
  every typed search failed. It is now 25 s.
- **Three states kept apart**: the feed answered and nothing matched, the
  feed could not be reached, and (new) one feed answered while the other did
  not — which says so instead of pretending the list is complete.
- A failed search says *"Nothing came back, so there is nothing to show. That
  is not the same as 'no results'"*, and offers **Try again**.

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
