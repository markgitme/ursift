#!/usr/bin/env bash
# ursift — Worker smoke test.
#
# Runs the REAL Worker on the REAL runtime (workerd, via `wrangler dev`) and
# asks it the questions a visitor would. No Cloudflare account is needed: the
# local runtime has a real cache, a real fetch, and the real code.
#
# This script exists because v0.5.1 shipped a Worker that had never been
# executed. A helper was called with the wrong number of arguments, so every
# search threw "Invalid URL: undefined" before it ever reached the feed.
# `wrangler deploy --dry-run` cannot catch that — it checks that the bundle
# builds, not that the code runs. The first person to find out was a visitor.
#
# Usage:   ./build.sh && ./tools/smoke.sh
#          PORT=9000 QUERY=bitcoin ./tools/smoke.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
QUERY="${QUERY:-technology}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t ursift-smoke.XXXXXX.log)"

export CI=1
export WRANGLER_SEND_METRICS=false

fail=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=1; }

cleanup() {
  if [ -n "${WRANGLER_PID:-}" ]; then
    kill "$WRANGLER_PID" 2>/dev/null
    wait "$WRANGLER_PID" 2>/dev/null
  fi
  # workerd is a grandchild. Left alone it keeps the port, and the next run
  # hangs against a server that no longer answers.
  pkill -f 'workerd serve' 2>/dev/null
  sleep 1
}
trap cleanup EXIT INT TERM

printf '\nursift smoke test — the real Worker, running locally\n\n'

if [ ! -d "$ROOT/build" ]; then
  bad "build/ is missing — run ./build.sh first"
  exit 1
fi

cd "$ROOT" || exit 1

# The local runtime keeps its cache on disk between runs, so a stale entry
# could answer the first search and make the test prove nothing. Start clean.
rm -rf worker/.wrangler/state 2>/dev/null || true

if command -v wrangler >/dev/null 2>&1; then
  WRANGLER="wrangler"
else
  WRANGLER="npx --yes wrangler@latest"
fi

$WRANGLER dev \
  --config worker/wrangler.toml \
  --port "$PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
WRANGLER_PID=$!

# The first run downloads workerd, so this can take a while.
up=0
for _ in $(seq 1 90); do
  # A port already taken by a stale server makes every request hang. Say so
  # instead of waiting it out.
  if grep -q 'Address already in use' "$LOG" 2>/dev/null; then
    bad "port $PORT was taken between the check and the launch - retry"
    tail -20 "$LOG"
    exit 1
  fi
  if curl -fsS -o /dev/null --max-time 3 "$BASE/" 2>/dev/null; then up=1; break; fi
  sleep 1
done
if [ "$up" -ne 1 ]; then
  bad "the local Worker never came up"
  tail -40 "$LOG"
  exit 1
fi
ok "the Worker is up on $BASE"

# 1. the site itself
code="$(curl -sS -o /tmp/ursift-smoke-index.html -w '%{http_code}' --max-time 15 "$BASE/" 2>/dev/null)"
if [ "$code" = "200" ] && grep -q '<title>ursift' /tmp/ursift-smoke-index.html; then
  ok "GET / serves the site"
else
  bad "GET / returned HTTP $code"
fi

# 2. the health endpoint
health="$(curl -fsS --max-time 15 "$BASE/api/health" 2>/dev/null)"
if printf '%s' "$health" | grep -q '"ok":true'; then
  ok "GET /api/health answers"
else
  bad "GET /api/health did not answer: ${health:0:160}"
fi

# 3. the actual search — the one that has to work
body="$(curl -sS --max-time 60 "$BASE/api/search?q=$(printf '%s' "$QUERY" | sed 's/ /%20/g')&region=US:en" 2>/dev/null)"
count="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(-1); raise SystemExit
items = d.get("items")
if not isinstance(items, list):
    print(-2); raise SystemExit
if d.get("error"):
    print(-3); raise SystemExit
print(len(items))
' 2>/dev/null || echo -4)"

if [ "$count" -gt 0 ] 2>/dev/null; then
  ok "GET /api/search?q=$QUERY returned $count items"
elif printf '%s' "$body" | grep -q '429'; then
  # Google is rate-limiting this address right now. That is the environment
  # talking, not the Worker: a build must not be failed by it, but it must
  # not be hidden either.
  bad "Google is rate-limiting this address right now (429) — the Worker cannot be judged"
  printf '        body: %s\n' "${body:0:300}"
else
  bad "GET /api/search?q=$QUERY returned no usable items (code=$count)"
  printf '        body: %s\n' "${body:0:400}"
fi

# 4. every item has to be a real link with a real title — a count alone can
#    hide a parser that returns empty shells.
shells="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    print(-1); raise SystemExit
print(sum(1 for i in items if not (i.get("title") or "").strip() or not (i.get("url") or "").strip()))
' 2>/dev/null || echo -1)"
if [ "$shells" = "0" ]; then
  ok "every item has a title and a url"
else
  bad "$shells item(s) had an empty title or url"
fi

# 5. the list must not be shortened by the resolution budget
trunc="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("?"); raise SystemExit
items = d.get("items") or []
total = d.get("total")
print("%s/%s" % (len(items), total))
' 2>/dev/null || echo '?')"
got="${trunc%%/*}"; want="${trunc##*/}"
if [ "$got" = "$want" ]; then
  ok "the whole list came back ($got items, none dropped)"
else
  bad "the list was shortened: $got items returned, $want in the feed"
fi

# 6. the search must NOT resolve the links itself. Resolving one article
#    costs two requests, so doing it for every link made the Worker the
#    loudest thing on the edge — and Google answered with 503.
google_items="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    print(0); raise SystemExit
print(sum(1 for i in items if i.get("via") == "google"))
' 2>/dev/null || echo 0)"
still_google="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    print(0); raise SystemExit
print(sum(1 for i in items
          if i.get("via") == "google" and "news.google.com" in (i.get("url") or "")))
' 2>/dev/null || echo 0)"
if [ "$google_items" = "0" ]; then
  ok "no Google items to check (the second feed answered)"
elif [ "$google_items" = "$still_google" ]; then
  ok "the search left $google_items link(s) for the visitor to reach"
else
  bad "the search resolved $((google_items - still_google)) link(s) itself"
fi

# 7. the answer must say which route served it
route="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    print(json.load(sys.stdin).get("route") or "")
except Exception:
    print("")
' 2>/dev/null || echo '')"
case "$route" in
  google|cors.lol|allorigins)
    ok "the search came through the '$route' route" ;;
  *)
    bad "the search did not report a route (route='$route')" ;;
esac

# 8. when the direct route answers, no third party is touched at all
started="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    print(",".join(json.load(sys.stdin).get("started") or []))
except Exception:
    print("")
' 2>/dev/null || echo '')"
# The policy is: the direct route is always tried first, and the two relay
# routes only start once it has had its stagger. Whether they then start at
# all depends on how long Google takes, so the stable property to check is
# the order.
if [ "${started%%,*}" = "google" ]; then
  ok "the direct route was tried first (started=$started)"
else
  bad "the direct route was not tried first (started=$started)"
fi

# 9. a link resolves on demand, one at a time
one_url="$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    print(""); raise SystemExit
for i in items:
    if "news.google.com" in (i.get("url") or ""):
        print(i.get("url")); break
' 2>/dev/null || echo '')"
if [ -z "$one_url" ]; then
  ok "no Google link to resolve on demand"
else
  resolved="$(curl -sS --max-time 45 "$BASE/api/resolve?u=$(printf '%s' "$one_url" | sed 's/?/%3F/g; s/&/%26/g; s/=/%3D/g; s/:/%3A/g; s,/,%2F,g')" 2>/dev/null | python3 -c '
import sys, json
try:
    u = (json.load(sys.stdin) or {}).get("url") or ""
except Exception:
    u = ""
print("publisher" if (u and "news.google.com" not in u) else "wrapper")
' 2>/dev/null || echo wrapper)"
  if [ "$resolved" = "publisher" ]; then
    ok "one link resolves to the publisher on demand"
  else
    bad "the on-demand resolution did not produce a publisher URL"
  fi
fi

# 6. the second search must come out of the cache and still be correct
body2="$(curl -sS --max-time 60 "$BASE/api/search?q=$(printf '%s' "$QUERY" | sed 's/ /%20/g')&region=US:en" 2>/dev/null)"
cached="$(printf '%s' "$body2" | python3 -c '
import sys, json
try:
    print(json.load(sys.stdin).get("cached"))
except Exception:
    print("?")
' 2>/dev/null || echo '?')"
if [ "$cached" = "True" ]; then
  ok "the repeat search was served from the cache"
else
  bad "the repeat search was not served from the cache (cached=$cached)"
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32msmoke test passed\033[0m\n\n'
  exit 0
fi
printf '\033[31msmoke test failed\033[0m\n\n'
tail -40 "$LOG"
exit 1
