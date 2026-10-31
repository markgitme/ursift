# ursift — the product, and the scope drift

> What the project is actually for, what was built instead, and what to do
> when it comes back.
>
> Read this **before** touching ursift. The project is parked; nothing changes
> until the owner says so.

## The pin

Mark parked ursift on 2026-10-31 at **v0.6.3** (commit `372e66b`), live at
`https://ursift.ursf.workers.dev`. Nothing changes until he says so. The site
stays exactly as it is — v0.6.3 is a working filtered-search tool, just not
the product he meant to build.

## What he actually wanted

His words: *"search the web, find what you like, add it as a source, save your
search queries and preferences as json or txt, upload them the next day to the
site so that you don't have to type anything."*

The product is **the saved layer**, not the search box:

- **your own sources** — added from a result you liked;
- **your own queries**, each with a mode;
- **your preferences** — what you've read, what you want ignored, for how long;
- all of it in **one file you carry** — JSON or plain text — uploaded next day,
  so you type nothing.

No account, no server, no database. **The file is the database.**

## The drift, named honestly

What was built is the **fetch primitive**: one query, one filtered list. It is
necessary — the sifter runs the same fetch — but it is not the product, and
three weeks went into making it ~99% reliable (his word: *"not actual
percentage, just a vibe"*). It is not. The live Worker answered
`ethereum price today` with **7 Bing items**, while the browser path returned a
full list from the visitor's own address.

**The reliability fight was partly self-inflicted.** The original design
(v0.1.0, and Mark's own `latest.html`) fetched Google **from the visitor's
browser**, through a relay, always the same URL so the relay had it cached.
That path works today — it is the path that returned 100 items. Moving the
fetch into the Worker moved it onto a shared Cloudflare egress pool that Google
throttles per address. So the sifter should keep fetching **in the browser**;
the Worker is a fast path when it works, never the backbone. Otherwise the
sifter inherits the 7-item problem for everyone.

## The old implementation is NOT lost — it is in git history

Commit **`c942532`** (v0.1.0, the "watchlist of questions" version) is a
reference implementation of the whole saved layer:

- `site/assets/js/store.js` (320 lines) — `addQuery(text, mode)`,
  `addSource(name, domain)`, `markRead` / `isRead`, `ignore(item, days)` with
  expiry, `purgeExpiredIgnored()`, one localStorage blob under
  `watchlab.state.v1`, export + import.
- `site/assets/js/api.js` — `MODE_ALL | MODE_FIRST | MODE_ONLY` and domain
  matching against the saved sources.
- `site/index.html` — three views (Watchlist / Sources / Ignored) plus Export
  and Import buttons.

**The Worker still speaks that protocol**: `?mode=all|first|only&sources=a.com,b.com`
is live in `worker/worker.js` today. The plumbing survived; only the client
layer was deleted in v0.4.0.

The old code was buggy (Mark: *"full of bugs as well"*). Treat it as a **data
model to read, not code to resurrect**.

## The next slice, when he comes back

Cheapest, most testable, and independent of the reliability problem — the
saved layer on top of the path that already works:

1. **"Add this source"** on a result you liked.
2. **Save a query** with its mode.
3. **Export / import** one JSON file (and the plain-text export).
4. **Run every saved query** in one go.

Client-side, localStorage-first, no account. **One piece at a time, with a live
link back after each piece.**

## Standing rules for ursift

- A push is a release — only when the owner asks.
- Do not reopen the reliability problem on your own initiative. If a search
  comes back thin, say so plainly and move on. **The sifter is the product.**
- No domain, no paid services. The site stays a static deploy he runs for
  himself ("at best on a github.io in the future"). `api.rss2json.com` was
  researched and is the right service if a keyless RSS→JSON API is ever
  wanted — but do not buy it and do not swap allorigins away.
