# Working notes — ursift

> The notes that used to live in a chat assistant's memory, moved into the
> repository so they survive every new conversation.
>
> **How to use this folder:** clone the repo and read the file that matches what
> you are about to do. Nothing here is needed to *serve* the site — it is the
> reasoning, the measurements and the traps behind the code.
>
> **These notes are public and readable without any credentials.** The parts
> that are about the owner rather than the code — the product he actually
> wants, the open decisions and the domain position — live in the owner's
> **private** notes repository, `markgitme/projectnotes`, under
> `ursift/docs/notes/`. This repository is the engineering half; that one is
> the rest.
>
> To read the private half:
> ```bash
> AUTH=$(printf 'x-access-token:%s' "$GH_TOKEN_NOTES" | base64 -w0)
> git -c "http.https://github.com/.extraheader=Authorization: Basic $AUTH" \
>     clone https://github.com/markgitme/projectnotes.git
> ```
> **If that clone fails, say so and stop** — do not carry on from a summary as
> if the notes had been read.

## The one thing to read first

**ursift is parked at v0.6.3.** The product the owner actually wants is the
**saved layer** — your own sources, your own queries, your preferences, all in
one file you carry — not the search box that was built. That is in the private
notes, under `ursift/docs/notes/product.md`; read it before touching anything.

## The files

| File | Read it before |
|---|---|
| `product.md` *(private)* | touching the project at all — what the owner actually wanted, the scope drift named honestly, the old implementation that still lives in git history, and the next slice — **private, in the owner's notes repository** |
| [`project-state.md`](project-state.md) | changing structure — the repo layout, the naming and the rename checklist, the three data backends, the verified feed facts, the rules this project learned the hard way, and the open decisions |
| [`worker.md`](worker.md) | deploying or debugging the Worker — how it failed four times before it worked, why Cloudflare's edge and Google do not get along, and the test tooling that guards it |
| [`data-sources.md`](data-sources.md) | touching the source layer — Google News RSS and its operators, the verified free endpoints, publisher-URL resolution, the source modes, the grouping cascade and the relay measurements |

## The rules that come out of them

- **A failed fetch must never look like an empty result.** It is the single
  most important rule in this interface.
- **Nothing fetches unless the user presses a button.** No burst of requests on
  load — free relays throttle and then the site blames the network.
- **The Worker is a fast path, not the backbone.** Google rate-limits by IP
  address and every Cloudflare Worker shares one egress pool. The visitor's own
  address is the reliable one.
- **The snapshot is a fallback, never the default.** Nothing stale on screen
  unless it is labelled as a copy with the build date.
- **Manual refresh only**, until the owner says otherwise.
- **A push is a release.** Cloudflare's git integration deploys on every push,
  so there is no way to release without pushing — which is why "never push
  without being asked" matters twice over here.
- **Never conclude a shared-IP path is dead from a single sample.** The direct
  edge→Google route was removed on the evidence of one bad run and had to be
  put back.

## Related files in the repository

| File | What it is |
|---|---|
| [`../../CHANGELOG.md`](../../CHANGELOG.md) | every release, what changed and why |
| [`../../README.md`](../../README.md) | the project README — what the site does, the data layer, the relay path |
| [`../../tools/`](../../tools) | the two test suites that guard the Worker |

## Housekeeping

Update these notes **in place** when a decision changes, rather than starting a
new document. A note that is out of date is worse than no note, because it will
be believed.
