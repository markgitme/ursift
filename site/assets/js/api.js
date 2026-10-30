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
 *     fourteen for others. It earns its place for two reasons. Its links are
 *     the publisher's own URL, so a headline it also carries opens directly
 *     instead of bouncing. And it is a second opinion, so one feed answering
 *     is enough to show something rather than nothing.
 *
 * Neither feed sends CORS headers, so a browser cannot read either one
 * directly. Everything goes through a public relay. allorigins needs up to
 * about twenty seconds on a cold cache, which is why the timeout below sits
 * well above that — an earlier version used nine seconds, aborted before the
 * relay could answer, and every typed search failed.
 *
 * Nothing here runs on page load. A fetch only happens when the user sifts.
 */
(function (global) {
  'use strict';

  /* Relays, raced rather than tried in sequence.
   *
   * All of these are flaky free services, and they fail differently:
   *
   *   allorigins /get  — the workhorse. Answers with ACAO even when it is
   *     failing, which matters: its plain error pages carry NO
   *     Access-Control-Allow-Origin header at all, so the browser reports
   *     them as a CORS failure rather than an HTTP error.
   *   allorigins /raw  — the same service, a different path, and therefore a
   *     DIFFERENT CACHE KEY. When /raw is cold and 522s, /get is often warm
   *     and answering. Racing both is cheaper than it sounds: only one of
   *     them can win, and the loser costs nothing but a request.
   *   cors.lol         — answers in about a second when it works, and
   *     rate-limits the rest of the time (HTTP 429).
   *
   * Racing them means a dead relay costs nothing while a working one answers.
   */
  var RELAYS = [
    { name: 'allorigins.get',
      url: function (u) { return 'https://api.allorigins.win/get?url=' + enc(u); },
      extract: jsonContents,
      timeout: 15000 },
    { name: 'allorigins.raw',
      url: function (u) { return 'https://api.allorigins.win/raw?url=' + enc(u); },
      extract: identity,
      timeout: 15000 },
    { name: 'cors.lol',
      url: function (u) { return 'https://api.cors.lol/?url=' + enc(u); },
      extract: identity,
      timeout: 12000 }
  ];

  var RELAY_RETRY_DELAY = 2500;
  var RATE_LIMIT_WAIT = 7000;

  var DEFAULT_REGION = 'PH:en';

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
  // The plain error pages are not JSON at all — those are passed through and
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
   * A relay that is down, rate-limited, or was handed a web page instead of a
   * feed simply loses the race — none of them holds up the others.
   *
   * One case is treated differently: HTTP 429 means "you are asking too
   * often, come back shortly", not "this service is broken". Those get one
   * retry after a pause instead of being dropped, because a rate limit is
   * the most likely thing to clear on its own. */
  function raceRelays(url, relays) {
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
          if (!/<rss|<feed/i.test(body)) throw new Error(r.name + ' did not return a feed');
          win(body, r.name);
        }).catch(function (err) {
          if (retriesLeft > 0 && /\b429\b/.test(err.message || '')) {
            setTimeout(function () { attempt(r, retriesLeft - 1); }, RATE_LIMIT_WAIT);
            return;
          }
          lose();
        });
      }

      relays.forEach(function (r) { attempt(r, 1); });
    });
  }

  function fetchViaRelay(url) {
    return raceRelays(url, RELAYS).then(function (hit) {
      if (hit) return hit.text;
      // All of them were down or rate-limited. Give them a moment and race
      // the two allorigins paths again — measured over a morning of testing,
      // roughly a third of searches lose the first round entirely.
      return new Promise(function (r) { setTimeout(r, RELAY_RETRY_DELAY); })
        .then(function () { return raceRelays(url, [RELAYS[0], RELAYS[1]]); })
        .then(function (hit2) {
          if (hit2) return hit2.text;
          throw new Error('no relay answered');
        });
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

  /* ---------------- backends ---------------- */

  function fetchGoogle(query, region) {
    return fetchViaRelay(googleUrl(query, region)).then(function (xml) {
      return parseRss(xml).map(googleItem);
    });
  }

  function fetchBing(query) {
    return fetchViaRelay(bingUrl(query)).then(function (xml) {
      return parseRss(xml).map(bingItem);
    });
  }

  /* search() resolves to { items: [...], errors: [{source, message}] }.
   *
   * onUpdate fires as each feed lands, with the merged list so far — so the
   * first answer can be put on screen without waiting for the second. */
  function search(query, region, onUpdate) {
    var g = { items: null, error: null };
    var b = { items: null, error: null };
    var errors = [];

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
        errors: errors.slice()
      });
    }

    var pg = fetchGoogle(query, region).then(function (items) {
      g.items = items; report('google');
    }, function (err) {
      g.error = err;
      errors.push({ source: 'google', message: err.message || String(err) });
      report('google');
    });

    var pb = fetchBing(query).then(function (items) {
      b.items = items; report('bing');
    }, function (err) {
      b.error = err;
      errors.push({ source: 'bing', message: err.message || String(err) });
      report('bing');
    });

    return Promise.all([pg, pb]).then(function () {
      return { items: merge(g.items, b.items), errors: errors };
    });
  }

  global.Api = {
    search: search,
    merge: merge,
    googleUrl: googleUrl,
    bingUrl: bingUrl
  };
})(window);
