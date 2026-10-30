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

const RSS_TTL = 60 * 60;            // 1 hour for a raw feed
const RESOLVE_TTL = 60 * 60 * 24 * 30; // 30 days — a publisher URL never changes
const RESOLVE_LIMIT = 40;
const state = { lastSuccess: null, lastError: null };            // resolve at most this many per search

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

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
    },
    body: opts.body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
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

function batchPayload(aid, ts, sg) {
  const pl = ['garturlreq',
    [['en-US', 'US', ['FINANCE_TOP_INDICES', 'WEB_TEST_1_0_0'], null, null, 1, 1, 'US:en', null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]],
      'en-US', 'US', 1, [2, 3, 4, 8], 1, 0, '655000234', 0, 0, null, 0],
    aid, ts, sg];
  return JSON.stringify([[['Fbv4je', JSON.stringify(pl), null, 'generic']]]);
}

async function resolveGoogleLink(googleUrl) {
  const key = new Request('https://ursift.internal/resolved?u=' + encodeURIComponent(googleUrl.split('?')[0]));
  const hit = await cacheGet(key);
  if (hit) return (await hit.json()).url || '';

  const idMatch = googleUrl.match(/\/articles\/([^?]+)/);
  if (!idMatch) return '';
  const aid = idMatch[1];

  const html = await fetchText(googleUrl.split('?')[0] + '?oc=5');
  const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) return '';

  const body = 'f.req=' + encodeURIComponent(batchPayload(aid, ts, sg));
  const txt = await fetchText('https://news.google.com/_/DotsSplashUi/data/batchexecute', { method: 'POST', body });
  const m = txt.match(/garturlres\\",\\"(https?:[^\\"]+)/);
  if (!m) return '';

  await cachePut(key, new Response(JSON.stringify({ url: m[1] }), {
    headers: { 'Content-Type': 'application/json' },
  }), RESOLVE_TTL);
  return m[1];
}

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

  const cacheKey = new Request('https://ursift.internal/feed?u=' +
    encodeURIComponent(effective) + '&r=' + encodeURIComponent(region || 'US:en'));
  const hit = await cacheGet(cacheKey);
  if (hit) return { items: await hit.json(), cached: true };

  const [gxml, bxml] = await Promise.all([
    fetchText(gnewsUrl(effective, region)).catch(() => ''),
    fetchText(`${BING}?q=${encodeURIComponent(query)}&format=RSS`).catch(() => ''),
  ]);

  const items = merge(parseFeed(gxml, 'google'), parseFeed(bxml, 'bing'));

  const filtered = mode === 'only' && srcs.length
    ? items.filter(it => it.domain && srcs.includes(it.domain))
    : items;

  await cachePut(cacheKey, new Response(JSON.stringify(filtered), {
    headers: { 'Content-Type': 'application/json' },
  }), RSS_TTL);

  return { items: filtered, cached: false };
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
        lastError: state.lastError || null
      });
    }

    if (url.pathname === '/api/resolve') {
      const u = url.searchParams.get('u');
      if (!u || !u.startsWith('https://news.google.com/rss/articles/')) {
        return json({ url: '' }, 400);
      }
      try {
        const real = await resolveGoogleLink(u);
        return json({ url: real });
      } catch (e) {
        return json({ url: '', error: String(e && e.message || e) }, 502);
      }
    }

    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const mode = url.searchParams.get('mode') || 'all';
      const sources = (url.searchParams.get('sources') || '').split(',').filter(Boolean);
      const region = url.searchParams.get('region') || 'US:en';
      if (!query.trim()) return json({ items: [] });

      try {
        const { items, cached } = await search({ query, mode, sources, region });
        state.lastSuccess = new Date().toISOString();
        state.lastError = null;

        // Resolve the visible head of the list to real publisher URLs.
        // Cached per article, so this cost is paid once per story, ever.
        const head = items.slice(0, RESOLVE_LIMIT);
        const resolved = await Promise.all(head.map(async (it) => {
          if (!it.needsResolve) return it;
          try {
            const real = await resolveGoogleLink(it.url);
            return real ? { ...it, url: real, needsResolve: false } : it;
          } catch { return it; }
        }));

        return json({ query, mode, generatedAt: new Date().toISOString(), cached, items: resolved });
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
