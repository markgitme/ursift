#!/usr/bin/env python3
"""Bake a data snapshot into the static build.

The browser cannot fetch Google News directly (no CORS headers) and public
CORS relays go down constantly, so the static build ships with a snapshot of
real articles taken at build time. Links in the snapshot are resolved to the
publisher's own URL server-side, so they are clean direct links.

Usage:  python3 tools/bake_snapshot.py [--out site/data/snapshot.json]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

SAMPLE_QUERIES = [
    "btc halving",
    "peso price today",
    "new pokemon game release date",
    "my chemical romance concert dates",
    "philippine peso exchange rate",
]

RESOLVE_LIMIT = 12          # per query — enough to fill the visible list
RESOLVE_DELAY = 0.45        # seconds between resolver calls
FEED_DELAY = 1.2            # seconds between feed fetches


def get(url, data=None, retries=4):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, data=data,
                headers={"User-Agent": UA, **(
                    {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"}
                    if data else {})})
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except Exception as exc:
            if attempt == retries - 1:
                raise
            wait = 3 * (attempt + 1)
            print(f"    retry {attempt+1} after {wait}s ({exc})", file=sys.stderr)
            time.sleep(wait)
    return ""


def decode(s):
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"),
                 ("&apos;", "'"), ("&nbsp;", " "), ("&amp;", "&")):
        s = s.replace(a, b)
    return s


def host(u):
    try:
        return urllib.parse.urlparse(u).hostname.lower().removeprefix("www.")
    except Exception:
        return ""


def parse_feed(xml):
    out = []
    for block in re.findall(r"<item>(.*?)</item>", xml, re.S):
        def pick(tag):
            m = re.search(rf"<{tag}(?:\s[^>]*)?>(.*?)</{tag}>", block, re.S)
            return decode(m.group(1).strip()) if m else ""
        title, link, pub = pick("title"), pick("link"), pick("pubDate")
        sm = re.search(r'<source url="([^"]*)">(.*?)</source>', block, re.S)
        if not title or not link:
            continue
        out.append({
            "title": title,
            "link": link,
            "published": pub,
            "source": decode(sm.group(2)) if sm else "",
            "sourceUrl": sm.group(1) if sm else "",
        })
    return out


def batch_payload(aid, ts, sg):
    pl = ["garturlreq",
          [["en-US", "US", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], None, None, 1, 1,
            "US:en", None, 180, None, None, None, None, None, 0, None, None,
            [1608992183, 723341000]],
           "en-US", "US", 1, [2, 3, 4, 8], 1, 0, "655000234", 0, 0, None, 0],
          aid, ts, sg]
    return json.dumps([[["Fbv4je", json.dumps(pl), None, "generic"]]])


def resolve(google_link):
    aid_m = re.search(r"/articles/([^?]+)", google_link)
    if not aid_m:
        return ""
    page = get(google_link.split("?")[0] + "?oc=5", retries=3)
    sg = re.search(r'data-n-a-sg="([^"]+)"', page)
    ts = re.search(r'data-n-a-ts="([^"]+)"', page)
    if not (sg and ts):
        return ""
    body = "f.req=" + urllib.parse.quote(batch_payload(aid_m.group(1), ts.group(1), sg.group(1)))
    txt = get("https://news.google.com/_/DotsSplashUi/data/batchexecute", body.encode(), retries=3)
    m = re.search(r'garturlres\\",\\"(https?:[^\\"]+)', txt)
    return m.group(1) if m else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data/snapshot.json")
    ap.add_argument("--queries", nargs="*", default=SAMPLE_QUERIES)
    args = ap.parse_args()

    snap = {"bakedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "queries": {}}

    for q in args.queries:
        print(f"  {q}")
        url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote_plus(q) +
               "&hl=en-US&gl=US&ceid=US:en")
        try:
            xml = get(url)
        except Exception as exc:
            print(f"    feed failed: {exc}", file=sys.stderr)
            continue
        items = parse_feed(xml)[:40]
        out = []
        for it in items:
            real = ""
            if it["link"].startswith("https://news.google.com/rss/articles/"):
                try:
                    real = resolve(it["link"])
                except Exception:
                    real = ""
                time.sleep(RESOLVE_DELAY)
            final = real or it["link"]
            out.append({
                "title": it["title"],
                "url": final,
                "published": it["published"],
                "source": it["source"] or host(final),
                "domain": host(final) or host(it["sourceUrl"]),
                "needsResolve": not real,
            })
        snap["queries"][q] = out
        print(f"    {len(out)} items")
        time.sleep(FEED_DELAY)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(snap, f, indent=1)
    total = sum(len(v) for v in snap["queries"].values())
    resolved = sum(1 for v in snap["queries"].values() for i in v if not i["needsResolve"])
    print(f"wrote {args.out}: {total} items, {resolved} with publisher URLs")


if __name__ == "__main__":
    main()
