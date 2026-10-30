/* ursift — data layer.
 *
 * One feed, one shape. The interface never has to know which relay answered.
 *
 *   Google News RSS — the only feed. It covers 84–100 items for most queries.
 *     Its links point at news.google.com, which bounces a browser straight on
 *     to the publisher (verified: a Google News item link lands on the
 *     publisher's own site in under two seconds).
 *
 * Bing was dropped from the browser path on purpose. It added two of the five
 * requests a search used to fire, brought its own failure states, and merged
 * only 1–14 items against Google's 84–100. Its real value — publisher URLs
 * that need no Google hop — is done properly by the Worker, which resolves
 * them server-side where a browser cannot.
 *
 * Neither feed sends CORS headers, so a browser cannot read one directly.
 * Everything goes through a public relay, and the relays are awkward in
 * different ways:
 *
 *   allorigins — no practical rate limit, but flaky. A cold target usually
 *     comes back in 5–7 seconds and sometimes not at all. Its ERROR responses
 *     carry no CORS header, so the browser reports them as a CORS failure
 *     rather than an HTTP error, and its status code is never visible.
 *
 *   cors.lol — the fast cold path (about 1.2 s for 100 items) and the
 *     strictest limit: roughly one request every few minutes, answering 429
 *     for the rest of the time.
 *
 * So allorigins is retried often and briefly, because it is flaking rather
 * than throttling; cors.lol is spent on exactly ONE request per search and
 * waited out patiently, because a rate limit is the one thing that clears on
 * its own.
 *
 * If a Cloudflare Worker is deployed on the same origin, it is used instead
 * and none of this applies. The Worker fetches from Cloudflare's edge, where
 * Google answers in 0.39 s, caches the result, and resolves publisher URLs
 * server-side. There is no third-party rate limit to trip over.
 *
 * Nothing here runs on page load. A fetch only happens when the user sifts,
 * and a new search cancels the one before it.
 */
(function (global) {
  'use strict';

  var RELAYS = {
    'allorigins.get': {
      name: 'allorigins.get',
      url: function (u) { return 'https://api.allorigins.win/get?url=' + enc(u); },
      extract: jsonContents,
      timeout: 12000,
      retries: 3,
      retryWait: 2500
    },
    'allorigins.raw': {
      name: 'allorigins.raw',
      url: function (u) { return 'https://api.allorigins.win/raw?url=' + enc(u); },
      extract: identity,
      timeout: 12000,
      retries: 3,
      retryWait: 2500
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

  // Which relays the feed may spend. cors.lol gets exactly one request per
  // search: asking it twice is what used to burn its window.
  var FEED_RELAYS = ['allorigins.get', 'allorigins.raw', 'cors.lol'];

  var DEFAULT_REGION = 'PH:en';
  var WORKER_PATH = '/api/search';
  var SEARCH_DEADLINE = 45000;

  function enc(u) { return encodeURIComponent(u); }

  function hostOf(u) {
    try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  /* ---------------- signals ---------------- */

  // One signal that aborts when either of its parents does.
  function linkSignals(a, b) {
    if (!b) return a;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      return AbortSignal.any([a, b]);
    }
    var c = new AbortController();
    function abort() { try { c.abort(); } catch (e) { /* ignore */ } }
    if (a.aborted) abort(); else a.addEventListener('abort', abort);
    if (b.aborted) abort(); else b.addEventListener('abort', abort);
    return c.signal;
  }

  /* ---------------- fetching ---------------- */

  function fetchText(url, timeoutMs, signal) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (ctrl) ctrl.abort();
    }, timeoutMs);

    var combined = ctrl ? linkSignals(ctrl.signal, signal) : null;

    var req = fetch(url, combined ? { signal: combined } : undefined).then(function (resp) {
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
      if (signal && signal.aborted) throw new Error('cancelled');
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

  /* Race a set of relays at once. The first body that looks like a feed wins,
   * and the losers are aborted immediately — there is no point keeping a
   * retrying request alive once its answer is on screen.
   *
   * A relay's error response carries no Access-Control-Allow-Origin header,
   * so the browser never shows us its status code: a 429, a 500 and a dead
   * connection all arrive as the same generic "Failed to fetch". That single
   * message is treated as transient and retried, because it is the common
   * case and because the status that would have identified a rate limit is
   * never visible to the browser in the first place. */
  function raceRelays(url, relayNames, reasons, notes, signal) {
    var relays = relayNames.map(function (n) { return RELAYS[n]; });
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;

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
        if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
        resolve({ text: text, relay: name });
      }
      function attempt(r, retriesLeft) {
        fetchText(r.url(url), r.timeout, ctl ? linkSignals(ctl.signal, signal) : signal).then(function (txt) {
          var body = r.extract(txt);
          if (!/<rss|<feed/i.test(body)) throw new Error('did not return a feed');
          win(body, r.name);
        }).catch(function (err) {
          var msg = (err && err.message) || String(err);

          // Cancelled? Then stop. Not "stop when the request fails" — stop
          // the RETRY CHAIN as well, or an abandoned search keeps firing
          // requests and keeps competing for the relay.
          if ((ctl && ctl.signal.aborted) || (signal && signal.aborted) || /cancelled/i.test(msg)) {
            lose();
            return;
          }

          var tries = (r.retries || 0) - retriesLeft + 1;
          var total = (r.retries || 0) + 1;
          if (retriesLeft > 0) {
            var note = r.name + ' didn\'t answer \u2014 trying again (' + tries + ' of ' + total + ')';
            if (notes.indexOf(note) === -1) notes.push(note);
            setTimeout(function () {
              if ((ctl && ctl.signal.aborted) || (signal && signal.aborted)) { lose(); return; }
              attempt(r, retriesLeft - 1);
            }, r.retryWait || 8000);
            return;
          }
          reasons.push(r.name + ': ' + msg);
          lose();
        });
      }

      relays.forEach(function (r) { attempt(r, r.retries || 0); });
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
  // for display.
  function stripPublisher(title) {
    return String(title || '')
      .replace(/\s+[-\u2013\u2014]\s+[^\u2013\u2014-]+$/, '')
      .trim();
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
    var isGoogle = /news\.google\.com/.test(url);
    return {
      title: it.via === 'google' ? stripPublisher(it.title || '') : (it.title || ''),
      link: url,
      published: it.published || null,
      source: it.source || hostOf(url),
      domain: it.domain || hostOf(url),
      direct: !isGoogle
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
      return { items: items, errors: [], notes: [], timedOut: false };
    });
  }

  /* ---------------- search ---------------- */

  /* search() resolves to { items, errors: [{source, message}], notes: [], timedOut }.
   *
   * onUpdate fires as the feed lands, with the items so far. `signal` cancels
   * the search: the requests are aborted, not merely ignored. */
  function search(query, region, onUpdate, signal) {
    var reasons = [];
    var notes = [];
    var items = null;

    function report(source) {
      if (!onUpdate) return;
      onUpdate({ source: source, items: items || [], pending: [], errors: [], notes: notes.slice() });
    }

    var pg = raceRelays(googleUrl(query, region), FEED_RELAYS, reasons, notes, signal)
      .then(function (hit) {
        if (!hit) throw new Error('no relay answered');
        items = parseRss(hit.text).map(googleItem);
        report('google');
      }, function (err) {
        if (signal && signal.aborted) throw err;
        var errors = [{ source: 'google', message: reasons.join('; ') || (err.message || String(err)) }];
        if (onUpdate) onUpdate({ source: 'google', items: [], pending: [], errors: errors, notes: notes.slice() });
        return { errors: errors };
      });

    var done = pg.then(function (extra) {
      var errors = (extra && extra.errors) || [];
      return { items: items || [], errors: errors, notes: notes, timedOut: false };
    });

    // A hard ceiling, and this one actually aborts the requests rather than
    // just stopping the interface from waiting.
    var deadline = new Promise(function (resolve) {
      setTimeout(function () {
        if (signal) { try { signal.abort(); } catch (e) { /* ignore */ } }
        resolve({
          items: items || [],
          errors: [{ source: 'google', message: reasons.join('; ') || 'gave up waiting after ' + (SEARCH_DEADLINE / 1000) + ' seconds' }],
          notes: notes,
          timedOut: true
        });
      }, SEARCH_DEADLINE);
    });

    return Promise.race([done, deadline]);
  }

  /* The public entry point. A Worker on the same origin wins if there is one;
   * otherwise the relays do the work. */
  function run(query, region, onUpdate, signal) {
    return detectWorker().then(function (hasWorker) {
      if (hasWorker) {
        return workerSearch(query, region, onUpdate).catch(function (err) {
          return {
            items: [],
            errors: [{ source: 'worker', message: err.message || String(err) }],
            notes: [],
            timedOut: false
          };
        });
      }
      return search(query, region, onUpdate, signal);
    });
  }

  global.Api = {
    search: run,
    googleUrl: googleUrl,
    stripPublisher: stripPublisher
  };
})(window);
