# Working notes — ursift

> **The working notes for this project are not in this repository.** They live
> in a private repository, `markgitme/projectnotes`, under `ursift/docs/notes/`
> — the same paths they used to occupy here, so the mapping is one to one.
>
> This folder is a pointer, not a copy. The notes were moved out because they
> carry the owner's own decisions, his product definition and his words, and
> those do not belong on a public URL.

## Reading them

The private repository needs a token to clone. The token is fine-grained and
scoped to that repository alone, and the clone puts it in a scoped HTTP header
so it never lands in `.git/config`, in the remote URL, or in any commit:

```bash
AUTH=$(printf 'x-access-token:%s' "$GH_TOKEN_NOTES" | base64 -w0)
git -c "http.https://github.com/.extraheader=Authorization: Basic $AUTH" \
    clone https://github.com/markgitme/projectnotes.git
```

**If that clone fails, say so and stop** — do not carry on from a summary as if
the notes had been read. A missing document that is not noticed is worse than
one that is.

## What is in there

| File | Read it before |
|---|---|
| `product.md` | touching the project at all — what the owner actually wanted, the scope drift named honestly, the old implementation that still lives in git history, and the next slice |
| `project-state.md` | changing structure — the repo layout, the naming and the rename checklist, the three data backends, the verified feed facts, the hard-won rules, and the open decisions |
| `worker.md` | deploying or debugging the Worker — why Cloudflare's edge and Google do not get along, and the tests that guard it |
| `data-sources.md` | touching the source layer — Google News RSS, its operators, the verified free endpoints, the source modes |

## What is still here, and public

| File | What it is |
|---|---|
| `CHANGELOG.md` | every release, what changed and why |
| `README.md` | the project README — what the site does, the data layer, the relay path |
| `worker/` | the Cloudflare Worker and its configuration |
| `tools/` | the two test suites that guard the Worker |
