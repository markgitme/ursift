#!/usr/bin/env python3
"""ursift — browser test.

Exercises the interface in a real browser against a real Worker:

  1. nothing is fetched until the visitor asks for it
  2. a search that the Worker answers produces real, linked results
  3. a Worker that breaks hands over to the relay path instead of dying
  4. a second search cancels the first and cannot be painted over

Run it against a local Worker:

    ./build.sh && ./tools/smoke.sh &     # or: npx wrangler dev --config worker/wrangler.toml
    python3 tools/browser-test.py

Or against the live site:

    BASE=https://ursift.ursf.workers.dev python3 tools/browser-test.py

Needs Playwright and a Chromium build:
    pip install playwright && playwright install chromium
"""

import os
import sys
import time
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")


def _find_chromium():
    override = os.environ.get("CHROMIUM")
    if override:
        return override
    roots = [
        os.path.expanduser("~/.cache/ms-playwright"),
        "/root/.cache/ms-playwright",
        "/ms-playwright",
    ]
    shapes = [
        ("chrome-linux", "chrome"),
        ("chrome-headless-shell-linux64", "chrome-headless-shell"),
        ("chrome-linux", "headless_shell"),
    ]
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            for sub, exe in shapes:
                candidate = os.path.join(root, name, sub, exe)
                if os.path.exists(candidate):
                    return candidate
    return None


RESULTS = []


def check(name, condition, detail=""):
    RESULTS.append((name, bool(condition), detail))
    mark = "PASS" if condition else "FAIL"
    print("  \033[32mPASS\033[0m  %s" % name if condition else "  \033[31mFAIL\033[0m  %s  %s" % (name, detail))


def q_of(url):
    return parse_qs(urlparse(url).query).get("q", [""])[0]


def run_test(page, name, fn):
    print("\n%s" % name)
    try:
        fn(page)
    except Exception as exc:  # noqa: BLE001 - a crashed test is a failed test
        check(name + " (raised)", False, repr(exc))


def test_nothing_loads(page):
    seen = []

    def on_req(r):
        seen.append(r.url)

    page.on("request", on_req)
    page.goto(BASE + "/", wait_until="networkidle")
    time.sleep(1.5)
    feeds = [u for u in seen if "/api/search" in u or "allorigins" in u or "cors.lol" in u]
    check("no feed request before the visitor asks", not feeds, str(feeds[:3]))
    page.remove_listener("request", on_req)


def test_worker_answers(page):
    seen = []

    def on_req(r):
        seen.append(r.url)

    page.on("request", on_req)
    page.fill("#sift-input", "technology")
    page.click("button[type=submit]")
    page.wait_for_selector(".result", timeout=45000)
    items = page.query_selector_all(".result")
    check("the Worker produced results", len(items) > 0, "%d items" % len(items))

    titles = [(e.inner_text() or "").strip() for e in page.query_selector_all(".result__link")]
    check("every result has a title", all(titles), "%d titles" % len(titles))
    check("titles are not empty shells", all(len(t) > 8 for t in titles), str(titles[:1]))

    links = [e.get_attribute("href") for e in page.query_selector_all(".result__link")]
    check("every result links out", all(l and l.startswith("http") for l in links), str(links[:2]))

    # The Worker resolves the head of the list to the publisher's own URL.
    # The rest stay Google News links on purpose — resolving every item
    # costs more requests than Cloudflare allows in one invocation.
    head = links[:12]
    check("the head of the list points at publishers, not at Google",
          all("news.google.com" not in (l or "") for l in head),
          str([l for l in head if l and "news.google.com" in l][:2]))

    note = page.query_selector(".results__note")
    note_text = note.text_content() if note else ""
    check("the note tells the truth about the links",
          ("publisher" in note_text) or ("Google News" in note_text), note_text[:120])

    calls = [u for u in seen if "/api/search" in u]
    check("the search went to the Worker", any(q_of(u) == "technology" for u in calls), str(calls[:3]))
    page.remove_listener("request", on_req)


def test_worker_failure_falls_back(page):
    """The Worker answers the probe but fails the search -> the relays take over."""
    relays = []

    def handler(route):
        url = route.request.url
        if "/api/search" in url and q_of(url):
            route.fulfill(status=502, body="worker exploded", content_type="text/plain")
        else:
            route.continue_()

    page.route("**/*", handler)
    def on_req(r):
        if "allorigins" in r.url or "cors.lol" in r.url:
            relays.append(r.url)

    page.on("request", on_req)
    page.fill("#sift-input", "fallbacktest")
    page.click("button[type=submit]")
    # The relay path carries its own deadline (45s). Wait for the outcome
    # rather than guessing how long it takes: either the relays answered, or
    # they did not, and both are outcomes worth testing.
    page.wait_for_selector(".panel--err, .results__note--warn", timeout=70000)

    check("the relay path was used after the Worker failed", len(relays) > 0, "%d relay requests" % len(relays))

    # text_content(), not inner_text(): the technical details live inside a
    # closed <details>, so they are not rendered and inner_text() returns ''.
    tech = page.query_selector(".tech pre")
    body = tech.text_content() if tech else ""
    check("the Worker failure is on the record", "worker" in body.lower(), body[:200] or "no technical details")

    panel = page.query_selector(".panel--err")
    note = page.query_selector(".results__note--warn")
    check("the interface says which path answered",
          (panel is not None) or (note is not None),
          "panel" if panel else ("note: " + (note.inner_text() if note else "none")))
    page.unroute("**/*")
    page.remove_listener("request", on_req)


def test_second_search_wins(page):
    """A slow first search must not paint over a fast second one."""
    def handler(route):
        url = route.request.url
        if "/api/search" in url and q_of(url) == "alphatest":
            time.sleep(2.5)
            route.continue_()
        else:
            route.continue_()

    page.route("**/*", handler)
    page.fill("#sift-input", "alphatest")
    page.click("button[type=submit]")
    page.wait_for_timeout(400)
    page.fill("#sift-input", "bettatest")
    page.click("button[type=submit]")
    page.wait_for_selector(".result", timeout=45000)
    page.wait_for_timeout(4000)

    titles = [(e.inner_text() or "") for e in page.query_selector_all(".result__link")]
    check("the newer search is what is on screen",
          titles and not any("alphatest" in t.lower() for t in titles),
          str(titles[:2]))
    page.unroute("**/*")


def main():
    path = _find_chromium()
    print("ursift browser test — %s" % BASE)
    if path:
        print("chromium: %s" % path)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=path,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()

        run_test(page, "1. nothing loads until the visitor asks", test_nothing_loads)
        run_test(page, "2. the Worker answers a search", test_worker_answers)
        run_test(page, "3. a broken Worker hands over to the relays", test_worker_failure_falls_back)
        run_test(page, "4. a second search cancels the first", test_second_search_wins)

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n%d passed, %d failed" % (len(RESULTS) - len(failed), len(failed)))
    if failed:
        print("\nfailures:")
        for name, _, detail in failed:
            print("  - %s  %s" % (name, detail))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
