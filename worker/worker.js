/* ursift — production data layer (Cloudflare Worker).
 *
 * Why this exists: the browser cannot fetch news.google.com (no CORS headers),
 * and Google hands out opaque links that need a server round-trip to become
 * the publisher's real URL. This Worker does both, and caches the answers.
 *
 * Routes
 *   GET /api/search?q=…&mode=all|first|only&sources=a.com,b.com&region=US:en
 *   GET /api/resolve?u=<google-news-url>        (resolve one link on demand)
 *   GET /api/health
 *
 * SSRF note: this Worker never fetches a host supplied by the user. The only
 * outbound requests are to news.google.com and www.bing.com. A user's source
 * list is only ever interpolated into a query string as a `site:` operator.
 */

const GNEWS = 'https://news.google.com/rss/search';
const BING = 'https://www.bing.com/news/search';
// An honest User-Agent. Impersonating Chrome is what we were doing, and it
// is both dishonest and no better: measured against Google News RSS, a plain
// curl UA and this one both get the feed, and the honest one got MORE items
// (100 vs 57) than the Chrome impersonation did.
const UA = 'Mozilla/5.0 (compatible; ursift/1.0; +https://github.com/markgitme/ursift)';

const CACHE_VERSION = 4;             // bumped on deploys, so a fix takes effect at once
const RSS_TTL = 60 * 60;            // 1 hour for a raw feed
const RESOLVE_TTL = 60 * 60 * 24 * 30; // 30 days — a publisher URL never changes
// The good case answers in 0.13 s from the edge. A budget much past two
// seconds only buys a slower failure, and a slow failure delays the visitor
// while the reliable path — the relays, from the visitor's own address —
// waits to be asked.
const FEED_TIMEOUT = 2500;
const RELAY_TIMEOUT = 6000;
const RESOLVE_TIMEOUT = 2500;        // resolving one article is a nice-to-have, never a wait

/* Three routes to the same Google News feed.
 *
 * Google treats Cloudflare's egress addresses badly. Measured from one colo:
 * a direct fetch answered in 0.13 s with 99 items half the time, and stalled
 * past five seconds the other half. The sandbox reached the same feed in
 * 0.29 s every time, so Google is not down and the feed is not broken — it is
 * the edge's own addresses that Google is slow with.
 *
 * The relays reach the same feed from addresses that are not Cloudflare's, so
 * they are not affected. Racing all three means the fast route wins when it
 * works and a working route wins when it does not.
 *
 * The cost of the race is two requests to third parties, and still exactly
 * one request to Google. */
// The second relay waits this long before it starts, so the first one is
// given a chance to answer alone. The relays are free services run by
// people, and their limits are shared with everybody else, so only one is
// spent when one is enough.
const FEED_STAGGER = 400;

const FEED_ROUTES = [
  { name: 'google', delay: 0, timeout: FEED_TIMEOUT, url: (u) => u },
  { name: 'cors.lol', delay: FEED_STAGGER, timeout: RELAY_TIMEOUT, url: (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
  { name: 'allorigins', delay: FEED_STAGGER, timeout: RELAY_TIMEOUT, url: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) }
];

/* Three routes, because Google rate-limits by IP address and every Worker on
 * the internet shares one pool of egress addresses. Google's limiter treats
 * that pool as one extremely busy customer, and it lets the edge through
 * intermittently rather than not at all.
 *
 * The direct route is the fast one when it works — 0.13 s and a hundred
 * items — and it fails with a 429 or an empty body when it does not. It is
 * kept because it is one request, and because it has answered many times
 * from the edge. An earlier note here said it "never worked"; that was
 * wrong, and the measurement behind it was taken while the whole pool was
 * shut out.
 *
 * The relays reach the same feed from addresses that are not Cloudflare's,
 * and they have their own rate limits — which are also per address, so the
 * Worker's budget there is shared with every other Worker on the internet.
 *
 * The visitor's own address is the one with a budget nobody else shares,
 * which is why the interface asks the relays too, from the browser, when the
 * Worker's answer is thin. That is the shape of the simple version that
 * worked before this one: fetch Google through a relay, from an address that
 * is not a shared cloud one. */

const state = { lastSuccess: null, lastError: null, lastRoute: null };            // resolve at most this many per search

/* ------------------------------------------------------------------ cache */

async function cacheGet(key) {
  const cache = caches.default;
  const hit = await cache.match(key);
  if (!hit) return null;
  return hit;
}

async function cachePut(key, response, ttl) {
  const cache = caches.default;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  const wrapped = new Response(response.body, { status: response.status, headers });
  await cache.put(key, wrapped);
}

/* ------------------------------------------------------------------ fetch */

// One signal that aborts when either of its parents does.
function linkSignals(a, b) {
  if (!b) return a;
  const c = new AbortController();
  const abort = () => { try { c.abort(); } catch (e) { /* ignore */ } };
  if (a.aborted) abort(); else a.addEventListener('abort', abort);
  if (b.aborted) abort(); else b.addEventListener('abort', abort);
  return c.signal;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* One feed, fetched with a few patient retries. A feed that fails once from
 * Cloudflare's edge fails roughly one time in twelve, and a failed fetch must
 * never be allowed to look like an empty result. That is this project's
 * founding rule, and the Worker was breaking it by swallowing the error. */
/* Race every route to the feed. The first one that answers with a real feed
 * wins and the rest are aborted — nothing keeps running once the answer is
 * on screen. A route that answers with something that is not a feed has not
 * answered at all. */
async function fetchFeedRaced(url) {
  const ctl = new AbortController();
  const failures = [];
  const started = [];

  const routes = FEED_ROUTES.map((route) => new Promise((resolve) => {
    setTimeout(() => {
      // Another route already answered. This one never starts, so the request
      // is never sent.
      if (ctl.signal.aborted) { resolve(null); return; }
      started.push(route.name);
      fetchText(route.url(url), { timeout: route.timeout, signal: ctl.signal })
        .then((xml) => {
          // A valid feed with nothing in it is an ANSWER — a query nobody
          // has written about yet. Only a body that is not a feed at all
          // (an error page, a challenge) counts as a route that failed.
          if (!/<rss[\s>]|<feed[\s>]|<channel[\s>]/i.test(xml)) {
            failures.push(route.name + ': the response was not a feed');
            resolve(null);
            return;
          }
          try { ctl.abort(); } catch (e) { /* ignore */ }
          resolve({ xml: xml, route: route.name, started: started.slice() });
        })
        .catch((e) => {
          failures.push(route.name + ': ' + (e.message || String(e)));
          resolve(null);
        });
    }, route.delay || 0);
  }));

  const winner = await new Promise((resolve) => {
    let pending = routes.length;
    let settled = false;
    for (const p of routes) {
      p.then((r) => {
        if (settled) return;
        if (r) { settled = true; resolve(r); return; }
        pending -= 1;
        if (pending === 0) { settled = true; resolve(null); }
      });
    }
  });

  if (!winner) {
    const err = new Error('no route answered with a feed — ' + failures.join('; '));
    err.routeFailures = failures;
    throw err;
  }
  return winner;
}

async function fetchFeed(url, opts = {}) {
  const attempts = opts.attempts || 3;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchText(url, { timeout: FEED_TIMEOUT, signal: opts.signal });
    } catch (e) {
      last = e;
      // A 4xx is the feed saying no: retrying it only spends the visitor's
      // time. A 5xx, a timeout or a dead connection is worth another go.
      if (e.status && e.status >= 400 && e.status < 500) break;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
  }
  throw last;
}

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  let timer = null;
  if (opts.timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      try { ctrl.abort(); } catch (e) { /* ignore */ }
    }, opts.timeout);
  }

  const combined = opts.signal ? linkSignals(ctrl.signal, opts.signal) : ctrl.signal;

  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
      },
      body: opts.body,
      signal: combined,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } catch (e) {
    if (timedOut) {
      const err = new Error(`no answer within ${Math.round(opts.timeout / 1000)}s`);
      err.transient = true;
      throw err;
    }
    if (!e.status) e.transient = true;   // a dead connection or a reset
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ parse */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function unwrapBing(link) {
  try {
    const m = link.match(/[?&]url=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch { return ''; }
}

function parseFeed(xml, via) {
  const out = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
      return m ? decodeEntities(m[1].trim()) : '';
    };
    const title = pick('title');
    const link = pick('link');
    const pub = pick('pubDate');
    const srcMatch = b.match(/<source url="([^"]*)">([\s\S]*?)<\/source>/);
    if (!title || !link) continue;

    if (via === 'bing') {
      const real = unwrapBing(link);
      out.push({
        title,
        url: real || link,
        published: pub ? new Date(pub).toISOString() : null,
        source: srcMatch ? decodeEntities(srcMatch[2]) : hostOf(real),
        domain: hostOf(real),
        via: 'bing',
        needsResolve: !real,
      });
    } else {
      const isGoogle = link.includes('news.google.com/rss/articles/');
      out.push({
        title,
        url: link,
        published: pub ? new Date(pub).toISOString() : null,
        source: srcMatch ? decodeEntities(srcMatch[2]) : '',
        domain: srcMatch ? hostOf(srcMatch[1]) : '',
        via: 'google',
        needsResolve: isGoogle,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ resolve */

/* ------------------------------------------------------------------ merge */

function normTitle(t) {
  return String(t).toLowerCase().replace(/\s+[-–—]\s+[^-–—]+$/, '').replace(/[^a-z0-9]+/g, '').slice(0, 70);
}

function merge(googleItems, bingItems) {
  const byTitle = {};
  for (const b of bingItems) byTitle[normTitle(b.title)] = b;
  const seen = new Set();
  const out = [];

  for (const g of googleItems) {
    const k = g.url.includes('news.google.com') ? normTitle(g.title) : g.url;
    if (seen.has(k)) continue;
    seen.add(k);
    const b = byTitle[normTitle(g.title)];
    const useBing = b && b.url && !b.url.includes('news.google.com');
    out.push({
      title: g.title,
      url: useBing ? b.url : g.url,
      published: g.published || (b && b.published) || null,
      source: g.source || (b && b.source) || '',
      domain: (useBing ? b.domain : g.domain) || '',
      via: 'google',
      needsResolve: useBing ? false : g.needsResolve,
    });
  }

  for (const b of bingItems) {
    const k = normTitle(b.title);
    if (seen.has(k) || seen.has(b.url)) continue;
    seen.add(k); seen.add(b.url);
    out.push({
      title: b.title, url: b.url, published: b.published,
      source: b.source, domain: b.domain, via: 'bing', needsResolve: b.needsResolve,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ search */

function gnewsUrl(q, region) {
  // region is a Google News edition id: "US:en", "PH:fil", "MX:es-419".
  const [country, lang] = String(region || 'US:en').split(':');
  const hl = (lang || 'en').indexOf('-') >= 0 ? lang : `${lang || 'en'}-${country || 'US'}`;
  return `${GNEWS}?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(country || 'US')}&ceid=${encodeURIComponent(region || 'US:en')}`;
}

async function search({ query, mode, sources, region }) {
  const srcs = (sources || []).map(s => s.trim().toLowerCase()).filter(Boolean);
  const siteClause = srcs.length ? '(' + srcs.map(d => `site:${d}`).join(' OR ') + ') ' : '';
  const effective = mode === 'all' ? query : siteClause + query;

  // The version in the key busts the cache on every deploy. Without it, a
  // failure cached by an older build stays cached for its whole hour — a
  // deploy that fixes the bug still serves the broken answer.
  const cacheKey = new Request('https://ursift.internal/feed?u=' +
    encodeURIComponent(effective) + '&r=' + encodeURIComponent(region || 'US:en') +
    '&v=' + CACHE_VERSION);
  const hit = await cacheGet(cacheKey);
  if (hit) {
    const saved = await hit.json();
    // Older entries were a bare array. Read both shapes rather than serving
    // an empty list to a cache written before the route was recorded.
    if (Array.isArray(saved)) return { items: saved, cached: true, errors: [], route: '', started: [] };
    return { items: saved.items || [], cached: true, errors: [], route: saved.route || '', started: saved.started || [] };
  }

  // The two feeds are fetched together, but the second one is stopped the
  // moment the first answers. It is the slower of the two and its items are
  // only a second opinion, so waiting for it after Google has already
  // answered would hold the whole response for nothing.
  const bingCtrl = new AbortController();
  const googleP = fetchFeedRaced(gnewsUrl(effective, region)).then((x) => {
    try { bingCtrl.abort(); } catch (e) { /* ignore */ }
    return { xml: x.xml, route: x.route, started: x.started, err: null };
  }, (e) => ({ xml: '', route: '', started: [], err: e }));

  const bingP = fetchFeed(`${BING}?q=${encodeURIComponent(query)}&format=RSS`, { signal: bingCtrl.signal })
    .then(x => ({ xml: x, err: null }), e => ({ xml: '', err: e }));

  const g = await googleP;
  const b = await bingP;
  // If Google answered, the second feed was stopped on purpose, so its
  // failure is not a failure worth reporting.
  if (!g.err && b.err) b.err = null;

  const feedErrors = [];
  if (g.err) feedErrors.push('google: ' + (g.err.message || String(g.err)));
  if (b.err) feedErrors.push('bing: ' + (b.err.message || String(b.err)));

  // Both feeds failed: the question was never answered. Saying so lets the
  // interface fall back to the relays, instead of telling the visitor that
  // nothing matched a query that was never sent anywhere.
  if (g.err && b.err) {
    throw new Error('both feeds failed — ' + feedErrors.join('; '));
  }

  const items = merge(parseFeed(g.xml, 'google'), parseFeed(b.xml, 'bing'));

  // Newest first. The feed is roughly in order, but merging a second feed
  // into it is not, and a search engine should lead with the newest thing.
  items.sort((a, b) => {
    const ta = a.published ? Date.parse(a.published) : 0;
    const tb = b.published ? Date.parse(b.published) : 0;
    return tb - ta;
  });

  const filtered = mode === 'only' && srcs.length
    ? items.filter(it => it.domain && srcs.includes(it.domain))
    : items;

  // Google is the backbone. If Google failed and what is left is nothing,
  // then "nothing matched" is a lie: the search was never really answered,
  // and Bing answering with an empty feed is not an answer. Say so, so the
  // interface can fall back to the relays instead of showing an empty list.
  if (g.err && !filtered.length) {
    throw new Error('the main feed failed and the second feed had nothing — ' + feedErrors.join('; '));
  }

  // A result that came out of a failed fetch is not a result. Caching it would
  // freeze the failure for an hour, which is how one bad minute became an
  // empty search that stayed empty all day.
  const route = g.route || '';
  if (!feedErrors.length) {
    await cachePut(cacheKey, new Response(JSON.stringify({ items: filtered, route: route, started: g.started || [] }), {
      headers: { 'Content-Type': 'application/json' },
    }), RSS_TTL);
  }

  return { items: filtered, cached: false, errors: feedErrors, route: route, started: g.started || [] };
}

/* ------------------------------------------------------------------ route */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      // The last successful fetch, not just "the Worker is up". A stale
      // badge is worse than no badge.
      return json({
        ok: true,
        ts: new Date().toISOString(),
        lastSuccess: state.lastSuccess || null,
        lastError: state.lastError || null,
        lastRoute: state.lastRoute || null
      });
    }

    /* There is no /api/resolve.
     *
     * It used to turn a Google News link into the publisher's own URL, so the
     * status bar showed `statnews.com` instead of `news.google.com`. It
     * needed Google's article page and a batchexecute call, both fetched
     * straight from the edge — and the edge cannot reach Google. So it never
     * worked, and every link a visitor reached cost a request for nothing.
     *
     * The Google News link is a wrapper that bounces on to the publisher: it
     * works, and it lands there in under two seconds. */
    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const mode = url.searchParams.get('mode') || 'all';
      const sources = (url.searchParams.get('sources') || '').split(',').filter(Boolean);
      const region = url.searchParams.get('region') || 'US:en';
      if (!query.trim()) return json({ items: [] });

      try {
        const { items, cached, errors, route, started } = await search({ query, mode, sources, region });
        state.lastSuccess = new Date().toISOString();
        state.lastError = null;
        state.lastRoute = route || null;

        // One line per search, so the dashboard log can be read without
        // guessing: which route answered, how many items it produced, and
        // what failed if anything did.
        console.log('ursift search', JSON.stringify({
          q: query,
          route: route || null,
          items: items.length,
          started: started || [],
          cached: !!cached,
          errors: errors || []
        }));

        // The links are NOT resolved here.
        //
        // Resolving one article costs two requests, so resolving a list meant
        // 26 to 80 requests for a single search — against a limit of 50 per
        // invocation, and it was by far the loudest thing this Worker did.
        // Google started answering Cloudflare's edge with 503, which turned
        // every search into a 25-second wait.
        //
        // The list is served the way the feed has it, and a link is resolved
        // when the visitor actually reaches it. One request, for the one
        // article somebody is about to click.
        return json({
          query, mode,
          generatedAt: new Date().toISOString(),
          cached,
          total: items.length,
          items,
          route: route || '',
          started: started || [],
          errors: errors || []
        });
      } catch (e) {
        state.lastError = String(e && e.message || e);
        return json({ error: state.lastError, items: [] }, 502);
      }
    }

    // Everything else is the static site, served from the assets binding.
    // Without the binding there is nothing to fall back to, and calling
    // fetch(request) here would re-invoke this Worker forever.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('ursift worker: no ASSETS binding configured', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
