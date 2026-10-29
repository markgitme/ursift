/* Watchlab — data layer.
 *
 * Two interchangeable backends, one output shape. The UI never knows which
 * one it is talking to.
 *
 *   worker  : /api/search?q=…  (same-origin Cloudflare Worker — production).
 *             Server-side fetch, server-side publisher-URL resolution, cached.
 *
 *   relay   : the static build reached through a public CORS relay. Public
 *             relays go down constantly, so we try several in turn and fall
 *             back to a snapshot baked into the build if none of them answer.
 *
 * Item shape returned by every backend:
 *   { url, title, source, domain, published, via, needsResolve }
 */
(function (global) {
  'use strict';

  var WORKER_PATH = '/api/search';
  var SNAPSHOT_PATH = 'data/snapshot.json';

  var MODE_ALL = 'all', MODE_FIRST = 'first', MODE_ONLY = 'only';

  var state = { backend: 'unknown' };
  var liveListeners = [];

  function emitLive(payload) {
    liveListeners.forEach(function (fn) {
      try { fn(payload); } catch (e) { /* a bad listener must not break the rest */ }
    });
  }

  /* ---------------- relays ---------------- */
  // Public CORS relays are unreliable by nature. Try them in order; the first
  // one that returns a parseable feed wins.

  function enc(u) { return encodeURIComponent(u); }

  var RELAYS = [
    { name: 'allorigins', url: function (u) { return 'https://api.allorigins.win/raw?url=' + enc(u); } },
    { name: 'cors.lol', url: function (u) { return 'https://api.cors.lol/?url=' + enc(u); } },
    { name: 'codetabs', url: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + enc(u); } },
    { name: 'corsfix', url: function (u) { return 'https://proxy.corsfix.com/?' + u; } }
  ];

  // A relay that just failed is put in a short cooldown, so a dead relay is
  // not re-probed on every single query.
  var relayFailUntil = RELAYS.map(function () { return 0; });
  var RELAY_COOLDOWN = 90000;
  var RELAY_TIMEOUT = 11000;

  function fetchWithTimeout(url) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, RELAY_TIMEOUT);
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (resp) {
      clearTimeout(timer);
      return resp;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function fetchViaRelay(url) {
    var order = RELAYS.map(function (r, i) { return i; });
    order.sort(function (a, b) {
      var ca = relayFailUntil[a] > Date.now() ? 1 : 0;
      var cb = relayFailUntil[b] > Date.now() ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return a - b;
    });
    var i = 0;
    function next() {
      if (i >= order.length) return Promise.reject(new Error('no relay answered'));
      var idx = order[i++];
      var r = RELAYS[idx];
      return fetchWithTimeout(r.url(url)).then(function (resp) {
        if (!resp.ok) throw new Error(r.name + ' HTTP ' + resp.status);
        return resp.text();
      }).then(function (txt) {
        if (!/<item>|<entry/i.test(txt)) throw new Error(r.name + ' returned no feed');
        relayFailUntil[idx] = 0;
        return txt;
      }).catch(function (err) {
        relayFailUntil[idx] = Date.now() + RELAY_COOLDOWN;
        throw err;
      }).catch(next);
    }
    return next();
  }

  /* ---------------- helpers ---------------- */

  function decode(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  function hostOf(u) {
    try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  function normTitle(t) {
    return decode(t).toLowerCase().replace(/\s+[-–—]\s+[^-–—]+$/, '').replace(/[^a-z0-9]+/g, '').slice(0, 70);
  }

  // true when the item's domain is one of the user's, at any subdomain depth
  function domainMatches(itemDomain, sources) {
    var d = String(itemDomain || '').toLowerCase();
    for (var i = 0; i < (sources || []).length; i++) {
      var s = String(sources[i] || '').toLowerCase();
      if (!s) continue;
      if (d === s || d.endsWith('.' + s) || s.endsWith('.' + d)) return true;
    }
    return false;
  }

  // region is a Google News edition id: "US:en", "PH:fil", "MX:es-419".
  function gnewsUrl(query, region) {
    var r = region || 'US:en';
    var p = r.split(':');
    var country = p[0] || 'US';
    var lang = p[1] || 'en';
    var hl = lang.indexOf('-') >= 0 ? lang : lang + '-' + country;
    return 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) +
      '&hl=' + encodeURIComponent(hl) +
      '&gl=' + encodeURIComponent(country) +
      '&ceid=' + encodeURIComponent(r);
  }

  function bingUrl(query) {
    return 'https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=RSS';
  }

  // Build the site: restriction for "My Sources" modes.
  function withSources(query, domains) {
    if (!domains || !domains.length) return query;
    var clause = domains.map(function (d) { return 'site:' + d; }).join(' OR ');
    return '(' + clause + ') ' + query;
  }

  function parseRss(xml) {
    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('Could not parse feed');
    var out = [];
    var nodes = doc.querySelectorAll('item');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var q = function (tag) {
        var e = n.querySelector(tag);
        return e ? decode(e.textContent) : '';
      };
      var title = q('title');
      var link = (n.querySelector('link') ? n.querySelector('link').textContent : '').trim();
      var date = q('pubDate');
      var srcEl = n.querySelector('source');
      if (!title || !link) continue;
      out.push({
        title: title,
        link: link,
        published: date ? new Date(date).toISOString() : null,
        source: srcEl ? decode(srcEl.textContent) : '',
        sourceUrl: srcEl ? (srcEl.getAttribute('url') || '') : ''
      });
    }
    return out;
  }

  /* ---------------- Bing: direct publisher URLs ---------------- */
  // Bing wraps each link in an apiclick.aspx tracker, but the real publisher
  // URL sits URL-encoded in the `url=` parameter. No server round-trip needed.

  function unwrapBing(link) {
    try {
      var m = link.match(/[?&]url=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function toGoogleItem(it) {
    var isG = it.link.indexOf('news.google.com/rss/articles/') === 0;
    return {
      title: it.title,
      url: it.link,
      published: it.published,
      source: it.source,
      domain: it.sourceUrl ? hostOf(it.sourceUrl) : '',
      via: 'google',
      needsResolve: isG
    };
  }

  function toBingItem(it) {
    var real = unwrapBing(it.link);
    return {
      title: it.title,
      url: real || it.link,
      published: it.published,
      source: it.source || hostOf(real),
      domain: hostOf(real),
      via: 'bing',
      needsResolve: !real
    };
  }

  /* ---------------- merge ---------------- */

  function merge(googleItems, bingItems) {
    var byTitle = {};
    bingItems.forEach(function (b) { byTitle[normTitle(b.title)] = b; });
    var seen = {};
    var out = [];

    googleItems.forEach(function (g) {
      var k = g.url.indexOf('news.google.com') === 0 ? normTitle(g.title) : g.url;
      if (seen[k]) return;
      seen[k] = true;
      var b = byTitle[normTitle(g.title)];
      var useBing = b && b.url && b.url.indexOf('news.google.com') !== 0;
      out.push({
        title: g.title,
        url: useBing ? b.url : g.url,
        published: g.published || (b && b.published) || null,
        source: g.source || (b && b.source) || '',
        domain: (useBing ? b.domain : g.domain) || '',
        via: 'google',
        needsResolve: useBing ? false : g.needsResolve
      });
    });

    bingItems.forEach(function (b) {
      var k = normTitle(b.title);
      if (seen[k] || seen[b.url]) return;
      seen[k] = true; seen[b.url] = true;
      out.push({
        title: b.title, url: b.url, published: b.published,
        source: b.source, domain: b.domain, via: 'bing', needsResolve: b.needsResolve
      });
    });

    return out;
  }

  function applyMode(items, mode, sources) {
    if (mode === MODE_ONLY && sources && sources.length) {
      return items.filter(function (it) {
        return it.domain && domainMatches(it.domain, sources);
      });
    }
    return items;
  }

  /* ---------------- snapshot fallback ---------------- */

  var snapshotPromise = null;
  function loadSnapshot() {
    if (snapshotPromise) return snapshotPromise;
    snapshotPromise = fetch(SNAPSHOT_PATH).then(function (r) {
      if (!r.ok) throw new Error('no snapshot');
      return r.json();
    }).catch(function () { return { queries: {} }; });
    return snapshotPromise;
  }

  function snapshotFor(query) {
    return loadSnapshot().then(function (snap) {
      var items = (snap.queries && snap.queries[query]) || [];
      return items.map(function (i) {
        return {
          title: i.title, url: i.url, published: i.published,
          source: i.source, domain: i.domain, via: 'snapshot', needsResolve: !!i.needsResolve
        };
      });
    });
  }

  /* ---------------- backends ---------------- */

  function workerSearch(query, mode, sources) {
    var u = WORKER_PATH + '?q=' + encodeURIComponent(query) +
      '&mode=' + encodeURIComponent(mode) +
      '&sources=' + encodeURIComponent((sources || []).join(',')) +
      '&region=' + encodeURIComponent((global.Store && global.Store.state().settings.region) || 'US:en');
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('worker HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      state.backend = 'worker';
      return j.items || [];
    });
  }

  function relaySearch(query, mode, sources) {
    var q = (mode === MODE_ALL) ? query : withSources(query, sources);
    var region = (global.Store && global.Store.state().settings.region) || 'US:en';

    return fetchViaRelay(gnewsUrl(q, region)).then(function (gxml) {
      var g = parseRss(gxml).map(toGoogleItem);
      return fetchViaRelay(bingUrl(query)).then(function (bxml) {
        return merge(g, parseRss(bxml).map(toBingItem));
      }).catch(function () {
        return merge(g, []);
      });
    }).then(function (items) {
      state.backend = 'relay';
      return applyMode(items, mode, sources);
    });
  }

  function relayThenSnapshot(query, mode, sources) {
    return relaySearch(query, mode, sources).catch(function (err) {
      return snapshotFor(query).then(function (items) {
        if (!items.length) throw err;
        state.backend = 'snapshot';
        return applyMode(items, mode, sources);
      });
    });
  }

  // Pull live results in the background and hand them to whoever is listening.
  function liveRefresh(query, mode, sources) {
    return relaySearch(query, mode, sources).then(function (items) {
      if (items && items.length) {
        state.backend = 'relay';
        emitLive({ query: query, items: items });
      }
      return items;
    }).catch(function () { return null; });
  }

  // The backend is declared in index.html rather than probed, so a static host
  // never fires a stray 404 at /api/search on every load.
  var backendProbe = null;
  function detectBackend() {
    if (backendProbe) return backendProbe;
    var declared = null;
    var meta = document.querySelector('meta[name="watchlab-backend"]');
    if (meta) declared = (meta.getAttribute('content') || '').toLowerCase();
    if (declared === 'worker') {
      backendProbe = Promise.resolve(true);
      return backendProbe;
    }
    if (declared === 'relay') {
      backendProbe = Promise.resolve(false);
      return backendProbe;
    }
    backendProbe = fetch(WORKER_PATH + '?q=__probe__&mode=all')
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
    return backendProbe;
  }

  function search(query, mode, sources) {
    return detectBackend().then(function (hasWorker) {
      if (hasWorker) return workerSearch(query, mode, sources);
      // Paint immediately from the bundled snapshot when we have one, and pull
      // live results in the background. A dead relay must never hold the page.
      return snapshotFor(query).then(function (snap) {
        if (snap.length) {
          state.backend = 'snapshot';
          liveRefresh(query, mode, sources);
          return applyMode(snap, mode, sources);
        }
        return relayThenSnapshot(query, mode, sources);
      });
    });
  }

  global.Api = {
    MODE_ALL: MODE_ALL, MODE_FIRST: MODE_FIRST, MODE_ONLY: MODE_ONLY,
    search: search,
    backend: function () { return state.backend; },
    onLive: function (fn) { liveListeners.push(fn); },
    withSources: withSources,
    domainMatches: domainMatches,
    gnewsUrl: gnewsUrl,
    bingUrl: bingUrl,
    unwrapBing: unwrapBing
  };
})(window);
