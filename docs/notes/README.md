# Working notes — ursift

> The notes that used to live in a chat assistant's memory, moved into the
> repository so they survive every new conversation.
>
> **How to use this folder:** clone the repo and read the file that matches what
> you are about to do. Nothing here is needed to *serve* the site — it is the
> reasoning, the measurements and the traps behind the code.

## The one thing to read first

**ursift is parked at v0.6.3.** The product the owner actually wants is the
**saved layer** — your own sources, your own queries, your preferences, all in
one file you carry — not the search box that was built. Read
[`product.md`](product.md) before touching anything.

## The files

| File | Read it before |
|---|---|
| [`product.md`](product.md) | touching the project at all — what the owner actually wanted, the scope drift named honestly, the old implementation that still lives in git history, and the next slice |
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
