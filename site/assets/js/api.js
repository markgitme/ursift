/* ursift — data layer.
 *
 * Two feeds, one output shape. The interface never has to know which one
 * answered.
 *
 *   Google News RSS — the backbone. Broad coverage: 84–100 items for most
 *     queries. Its links point at news.google.com, which bounces a browser
 *     straight on to the publisher (verified: a Google News item link lands
 *     on the publisher's own site in under two seconds).
 *
 *   Bing News RSS — thin, and sometimes very thin: one item for some queries,
 *     fourteen for others. Its links are the publisher's own URL, so a
 *     headline it also carries opens directly instead of bouncing. It is the
 *     second opinion, not the backbone.
 *
 * Neither feed sends CORS headers, so a browser cannot read either one
 * directly. Everything goes through a public relay, and the relays are
 * awkward in different ways:
 *
 *   allorigins — serves a query it has already cached, instantly. A cold
 *     query takes it 24 seconds and then fails (408/500/522), because
 *     fetching a cold Google News RSS is slower than its own upstream
 *     budget allows. Its ERROR responses carry no CORS header at all, so the
 *     browser reports them as a CORS failure rather than an HTTP error.
 *
 *   cors.lol — the only relay measured that can fetch a COLD query (1.2 s,
 *     100 items). But it allows roughly one request every few minutes, and
 *     it answers HTTP 429 for the rest.
 *
 * So the two are used differently. allorigins handles both feeds, because it
 * has no practical limit and repeat queries are cached there. cors.lol is
 * spent only on the Google feed — ONE request per search, because asking it
 * twice in the same search is what used to burn its window.
 *
 * If a Cloudflare Worker is deployed on the same origin, it is used instead
 * and none of this applies. The worker fetches from Cloudflare's edge, where
 * Google answers in 0.39 s, caches the result, and there is no third-party
 * rate limit to trip over.
 *
 * Nothing here runs on page load. A fetch only happens when the user sifts.
 */
(function (global) {
  'use strict';

  var RELAYS = {
    'allorigins.get': {
      name: 'allorigins.get',
      url: function (u) { return 'https://api.allorigins.win/get?url=' + enc(u); },
      extract: jsonContents,
      timeout: 26000,
      retries: 3,
      retryWait: 5000,
      retryWaits: [5000, 12000, 22000]
    },
    'allorigins.raw': {
      name: 'allorigins.raw',
      url: function (u) { return 'https://api.allorigins.win/raw?url=' + enc(u); },
      extract: identity,
      timeout: 26000,
      retries: 3,
      retryWait: 5000,
      retryWaits: [5000, 12000, 22000]
    },
    'cors.lol': {
      name: 'cors.lol',
      url: function (u) { return 'https://api.cors.lol/?url=' + enc(u); },
      extract: identity,
      timeout: 12000,
      retries: 1,
      retryWait: 20000
    }
  };

  // Which relays each feed may spend. cors.lol goes to the backbone only:
  // it is the one request it gets per search.
  var FEED_RELAYS = {
    google: ['allorigins.get', 'allorigins.raw', 'cors.lol'],
    bing: ['allorigins.get', 'allorigins.raw']
  };

  var DEFAULT_REGION = 'PH:en';
  var WORKER_PATH = '/api/search';

  function enc(u) { return encodeURIComponent(u); }

  function hostOf(u) {
    try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  /* ---------------- fetching ---------------- */

  function fetchText(url, timeoutMs) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (ctrl) ctrl.abort();
    }, timeoutMs);

    var req = fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    });

    if (!ctrl) {
      req = Promise.race([req, new Promise(function (_, rej) {
        setTimeout(function () { rej(new Error('timed out')); }, timeoutMs);
      })]);
    }

    return req.then(function (txt) {
      clearTimeout(timer);
      return txt;
    }, function (err) {
      clearTimeout(timer);
      if (timedOut) throw new Error('no answer within ' + Math.round(timeoutMs / 1000) + 's');
      throw err;
    });
  }

  function identity(txt) { return txt; }

  // allorigins /get wraps the upstream body as {"contents": "<body>", ...}.
  // Its plain error pages are not JSON at all — those are passed through and
  // caught by the feed check below.
  function jsonContents(txt) {
    if (txt.charAt(0) !== '{') return txt;
    var parsed;
    try { parsed = JSON.parse(txt); }
    catch (e) { throw new Error('relay returned truncated JSON'); }
    if (!parsed || typeof parsed.contents !== 'string') throw new Error('relay returned no content');
    return parsed.contents;
  }

  /* Race a set of relays at once. The first body that looks like a feed wins.
   * A relay that is down, or was handed a web page instead of a feed, simply
   * loses the race — none of them holds up the others.
   *
   * Transient failures are treated differently. HTTP 429 means "you are asking
   * too often, come back shortly". HTTP 5xx from allorigins (500, 520, 522)
   * means the relay's own upstream stumbled — it was seen serving 520 for a
   * plain example.com while working fine a moment later. Neither is a reason
   * to give up, so both are retried with a pause. A cold Google News fetch
   * through allorigins legitimately takes up to about 25 seconds, which is
   * why its timeout is 26 and not 15.
   *
   * Every failure is recorded with its reason, so a failed search can say
   * what actually went wrong instead of "no relay answered". */
  function raceRelays(url, relayNames, reasons, notes) {
    var relays = relayNames.map(function (n) { return RELAYS[n]; });
    return new Promise(function (resolve) {
      var pending = relays.length;
      var settled = false;

      function lose() {
        pending -= 1;
        if (pending <= 0 && !settled) { settled = true; resolve(null); }
      }
      function win(text, name) {
        if (settled) return;
        settled = true;
        resolve({ text: text, relay: name });
      }
      function attempt(r, retriesLeft) {
        fetchText(r.url(url), r.timeout).then(function (txt) {
          var body = r.extract(txt);
          if (!/<rss|<feed/i.test(body)) throw new Error('did not return a feed');
          win(body, r.name);
        }).catch(function (err) {
          var msg = (err && err.message) || String(err);

          // A relay's ERROR response carries no Access-Control-Allow-Origin
          // header, so the browser never shows us its status code — it just
          // says "Failed to fetch". That single message covers HTTP 429, 500,
          // 520, 522 and a dead connection alike, and it is the common case.
          // So a generic fetch failure is treated as transient and retried,
          // which is the only way a 429 can ever be waited out: the status
          // that would have told us it was a rate limit is never visible.
          var rateLimited = /\b429\b/.test(msg);
          var upstreamError = /\b5\d\d\b/.test(msg);
          var hiddenStatus = /failed to fetch|networkerror|load failed/i.test(msg);

          if (retriesLeft > 0 && (rateLimited || upstreamError || hiddenStatus)) {
            var note = rateLimited
              ? r.name + ' is rate-limiting us; waiting for it to answer'
              : r.name + ' is having a moment; trying it again';
            if (notes.indexOf(note) === -1) notes.push(note);
            var waits = r.retryWaits || [];
            var wait = waits.length ? waits[waits.length - 1 - retriesLeft] : (r.retryWait || 8000);
            setTimeout(function () { attempt(r, retriesLeft - 1); }, wait);
            return;
          }
          reasons.push(r.name + ': ' + msg);
          lose();
        });
      }

      relays.forEach(function (r) { attempt(r, r.retries || 0); });
    });
  }

  function fetchFeed(url, relayNames, reasons, notes) {
    return raceRelays(url, relayNames, reasons, notes).then(function (hit) {
      if (hit) return hit.text;
      throw new Error('no relay answered');
    });
  }

  /* ---------------- feed URLs ---------------- */

  function googleUrl(query, region) {
    var r = region || DEFAULT_REGION;
    var p = r.split(':');
    var country = p[0] || 'US';
    var lang = p[1] || 'en';
    var hl = lang.indexOf('-') >= 0 ? lang : lang + '-' + country;
    return 'https://news.google.com/rss/search?q=' + enc(query) +
      '&hl=' + enc(hl) + '&gl=' + enc(country) + '&ceid=' + enc(r);
  }

  function bingUrl(query) {
    return 'https://www.bing.com/news/search?q=' + enc(query) + '&format=RSS';
  }

  /* ---------------- parsing ---------------- */

  function decode(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  function tagText(node, tag) {
    var e = node.querySelector(tag);
    return e ? decode(e.textContent) : '';
  }

  function parseRss(xml) {
    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('could not parse the feed');
    var out = [];
    var nodes = doc.querySelectorAll('item');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var title = tagText(n, 'title');
      var linkEl = n.querySelector('link');
      var link = linkEl ? linkEl.textContent.trim() : '';
      var date = tagText(n, 'pubDate');
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

  // Google appends the publisher to the headline: "Headline - Publisher". The
  // <source> element already carries the publisher, so the suffix is dropped
  // for display. It stays in the raw title, which is what gets matched.
  function stripPublisher(title) {
    return String(title || '')
      .replace(/\s+[-\u2013\u2014]\s+[^\u2013\u2014-]+$/, '')
      .trim();
  }

  function matchKey(title) {
    return stripPublisher(title).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 70);
  }

  // Bing wraps each link in apiclick.aspx, but the publisher's own URL sits
  // URL-encoded in the `url` parameter. No server round-trip needed.
  function unwrapBing(link) {
    try {
      var m = link.match(/[?&]url=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function googleItem(it) {
    return {
      title: stripPublisher(it.title),
      link: it.link,
      published: it.published,
      source: it.source,
      domain: hostOf(it.sourceUrl),
      direct: false
    };
  }

  function bingItem(it) {
    var real = unwrapBing(it.link);
    return {
      title: it.title,
      link: real || it.link,
      published: it.published,
      source: it.source || hostOf(real),
      domain: hostOf(real),
      direct: true
    };
  }

  /* ---------------- merge ---------------- */

  function merge(googleItems, bingItems) {
    var g = googleItems || [];
    var b = bingItems || [];

    var byKey = {};
    b.forEach(function (item) {
      var k = matchKey(item.title);
      if (k) byKey[k] = item;
    });

    var seen = {};
    var out = [];

    g.forEach(function (item) {
      var k = matchKey(item.title);
      if (!k || seen[k]) return;
      seen[k] = true;
      var twin = byKey[k];
      if (twin && twin.link) {
        // Bing carries the same headline and links straight to the publisher.
        out.push({
          title: twin.title || item.title,
          link: twin.link,
          published: twin.published || item.published,
          source: twin.source || item.source,
          domain: twin.domain || item.domain,
          direct: true
        });
      } else {
        out.push({
          title: item.title, link: item.link, published: item.published,
          source: item.source, domain: item.domain, direct: false
        });
      }
    });

    b.forEach(function (item) {
      var k = matchKey(item.title);
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push({
        title: item.title, link: item.link, published: item.published,
        source: item.source, domain: item.domain, direct: true
      });
    });

    out.sort(function (a, c) {
      var ta = a.published ? Date.parse(a.published) : 0;
      var tc = c.published ? Date.parse(c.published) : 0;
      if (ta === tc) return 0;
      return tc - ta;
    });

    return out;
  }

  /* ---------------- the Worker, if one is deployed ---------------- */

  var workerProbe = null;

  function detectWorker() {
    if (workerProbe) return workerProbe;
    // An EMPTY query: the Worker answers that with {"items":[]} straight away,
    // without going near a feed. A static host, meanwhile, answers the unknown
    // path /api/search with index.html and a 200 — so "the request succeeded"
    // proves nothing. Only a JSON body carrying an items array counts.
    workerProbe = fetch(WORKER_PATH + '?q=')
      .then(function (r) {
        if (!r.ok) return false;
        return r.text().then(function (txt) {
          var j;
          try { j = JSON.parse(txt); } catch (e) { return false; }
          return !!(j && Array.isArray(j.items));
        });
      })
      .catch(function () { return false; });
    return workerProbe;
  }

  function workerItem(it) {
    var url = it.url || it.link || '';
    return {
      title: it.title || '',
      link: url,
      published: it.published || null,
      source: it.source || hostOf(url),
      domain: it.domain || hostOf(url),
      direct: !/news\.google\.com/.test(url)
    };
  }

  function workerSearch(query, region, onUpdate) {
    var u = WORKER_PATH + '?q=' + enc(query) + '&region=' + enc(region || DEFAULT_REGION);
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('worker HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var items = (j.items || []).map(workerItem);
      if (onUpdate) onUpdate({ source: 'worker', items: items, pending: [], errors: [], notes: [] });
      return { items: items, errors: [] };
    });
  }

  /* ---------------- search ---------------- */

  /* search() resolves to { items: [...], errors: [{source, message}], notes: [...] }.
   *
   * onUpdate fires as each feed lands, with the merged list so far — so the
   * first answer can be put on screen without waiting for the second. */
  function search(query, region, onUpdate) {
    var g = { items: null, error: null };
    var b = { items: null, error: null };
    var errors = [];
    var notes = [];

    function pending() {
      var p = [];
      if (!g.items && !g.error) p.push('google');
      if (!b.items && !b.error) p.push('bing');
      return p;
    }

    function report(source) {
      if (!onUpdate) return;
      onUpdate({
        source: source,
        items: merge(g.items, b.items),
        pending: pending(),
        errors: errors.slice(),
        notes: notes.slice()
      });
    }

    var gReasons = [];
    var bReasons = [];

    var pg = fetchFeed(googleUrl(query, region), FEED_RELAYS.google, gReasons, notes)
      .then(function (xml) {
        g.items = parseRss(xml).map(googleItem);
        report('google');
      }, function (err) {
        g.error = err;
        errors.push({ source: 'google', message: gReasons.join('; ') || (err.message || String(err)) });
        report('google');
      });

    var pb = fetchFeed(bingUrl(query), FEED_RELAYS.bing, bReasons, notes)
      .then(function (xml) {
        b.items = parseRss(xml).map(bingItem);
        report('bing');
      }, function (err) {
        b.error = err;
        errors.push({ source: 'bing', message: bReasons.join('; ') || (err.message || String(err)) });
        report('bing');
      });

    var done = Promise.all([pg, pb]).then(function () {
      return { items: merge(g.items, b.items), errors: errors, notes: notes, timedOut: false };
    });

    // A hard ceiling, so a bad afternoon at the relay cannot hang the page
    // for ever. Whatever has arrived by then is what gets shown.
    var deadline = new Promise(function (resolve) {
      setTimeout(function () {
        resolve({
          items: merge(g.items, b.items),
          errors: errors.length ? errors : [{ source: 'feed', message: 'gave up waiting after 100 seconds' }],
          notes: notes,
          timedOut: true
        });
      }, 100000);
    });

    return Promise.race([done, deadline]);
  }

  /* The public entry point. A Worker on the same origin wins if there is one;
   * otherwise the relays do the work. */
  function run(query, region, onUpdate) {
    return detectWorker().then(function (hasWorker) {
      if (hasWorker) {
        return workerSearch(query, region, onUpdate).catch(function (err) {
          return { items: [], errors: [{ source: 'worker', message: err.message || String(err) }], notes: [] };
        });
      }
      return search(query, region, onUpdate);
    });
  }

  global.Api = {
    search: run,
    merge: merge,
    googleUrl: googleUrl,
    bingUrl: bingUrl
  };
})(window);
