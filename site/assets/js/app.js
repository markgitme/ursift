/* Watchlab — interface.
 *
 * The home screen is the watchlist, not a search box. The search bar is how
 * you add a question to the list; the list is what you come back to.
 *
 * Three states must never be confused with each other:
 *   not run yet  ·  the feed came back empty  ·  the feed could not be reached
 * An earlier version showed "no results, press refresh" for all three, which
 * is how a dead network looks like a working product.
 */
(function () {
  'use strict';

  var RESULTS_KEY = 'watchlab.results.v1';
  var S = window.Store;
  var Api = window.Api;

  var SAMPLES = [
    'BTC halving',
    'peso price today',
    'is there an ongoing war right now',
    'when is the new pokemon game gonna get released',
    'my chemical romance band concert'
  ];

  var results = loadResults();
  var expanded = {};
  var showAll = {};
  var view = 'watchlist';
  var busy = false;
  var queued = false;
  var queuedIds = [];

  function loadResults() {
    try {
      var raw = localStorage.getItem(RESULTS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveResults() {
    try { localStorage.setItem(RESULTS_KEY, JSON.stringify(results)); }
    catch (e) { /* quota — not fatal */ }
  }

  /* ---------------- small helpers ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function timeAgo(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 0) s = 0;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function plural(n, word, pluralWord) {
    if (n === 1) return n + ' ' + word;
    return n + ' ' + (pluralWord || word + 's');
  }

  function normTitle(t) {
    return String(t || '').toLowerCase()
      .replace(/\s+[-–—]\s+[^-–—]+$/, '')
      .replace(/[^a-z0-9]+/g, '').slice(0, 70);
  }

  /* ---------------- grouping ---------------- */
  // Priority cascade: Read > Published Today > Unread.
  function groupItems(items) {
    var period = S.state().settings.period;
    var ignored = S.ignoredUrls();
    var preferredDomains = S.sourceDomains();

    var today = [], unread = [], read = [];
    var kept = 0;

    items.forEach(function (it) {
      var u = S.normalizeUrl(it.url);
      if (ignored[u]) return;
      if (!S.inPeriod(it.published, period)) return;
      kept++;
      if (S.state().read[u]) read.push(it);
      else if (S.isPublishedToday(it.published)) today.push(it);
      else unread.push(it);
    });

    function byPrefThenDate(a, b) {
      var ap = Api.domainMatches(a.domain || '', preferredDomains) ? 0 : 1;
      var bp = Api.domainMatches(b.domain || '', preferredDomains) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      var at = a.published ? new Date(a.published).getTime() : 0;
      var bt = b.published ? new Date(b.published).getTime() : 0;
      return bt - at;
    }

    today.sort(byPrefThenDate);
    unread.sort(byPrefThenDate);
    read.sort(byPrefThenDate);

    return { today: today, unread: unread, read: read, total: kept };
  }

  /* ---------------- rendering ---------------- */

  function render() {
    S.purgeExpiredIgnored();
    renderNav();
    var main = document.getElementById('main');
    clear(main);
    if (view === 'watchlist') renderWatchlist(main);
    else if (view === 'sources') renderSources(main);
    else renderIgnored(main);
    renderStatus();
  }

  function renderStatus() {
    var st = document.getElementById('status');
    clear(st);
    var failed = S.state().queries.filter(function (q) {
      return results[q.id] && results[q.id].error;
    }).length;

    if (failed) {
      st.appendChild(el('span', 'status__err',
        plural(failed, 'watch') + ' could not be refreshed'));
      st.appendChild(el('span', 'status__sep', '·'));
    }

    var b = Api.backend();
    var label = b === 'worker' ? 'live · your Worker, publisher links'
      : b === 'relay' ? 'live · public relay'
        : b === 'snapshot' ? 'bundled snapshot · live feed unreachable'
          : 'checking…';
    st.appendChild(el('span', 'status__backend', label));

    var note = document.getElementById('link-note');
    if (note) {
      note.textContent = b === 'worker'
        ? 'Links resolve to the publisher\'s own address, not to a search page.'
        : b === 'relay'
          ? 'This host reaches Google News through a public relay, so links may open via Google before the article.'
          : b === 'snapshot'
            ? 'Showing a bundled copy of these results. Deploy the Worker for live, directly-resolved links.'
            : '';
    }
    st.appendChild(el('span', 'status__sep', '·'));
    st.appendChild(el('span', '', plural(S.state().queries.length, 'watch', 'watches') +
      ' · ' + plural(S.state().sources.length, 'source')));
  }

  function renderNav() {
    document.querySelectorAll('.nav__btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === view);
    });
  }

  /* ---- watchlist ---- */

  function renderWatchlist(main) {
    var qs = S.state().queries;
    if (!qs.length) { main.appendChild(renderEmptyState()); return; }

    var head = el('div', 'list__head');
    head.appendChild(el('h2', 'list__title', 'Your watchlist'));
    head.appendChild(el('span', 'list__hint', 'ordered by what is new, your sources first'));
    main.appendChild(head);

    qs.forEach(function (q) { main.appendChild(renderEntry(q)); });
  }

  function renderEmptyState() {
    var wrap = el('div', 'empty');
    wrap.appendChild(el('h2', 'empty__title', 'Nothing on the watch yet'));
    wrap.appendChild(el('p', 'empty__body',
      'Type a question you want to keep an eye on. It stays here, and every time you come back you see what is new about it.'));

    var form = el('form', 'empty__form');
    var input = el('input', 'empty__input');
    input.type = 'text';
    input.placeholder = 'e.g. btc halving';
    input.setAttribute('aria-label', 'New watch');
    var btn = el('button', 'btn btn--primary', 'Add watch');
    form.appendChild(input);
    form.appendChild(btn);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!input.value.trim()) return;
      var q = S.addQuery(input.value.trim(), 'all');
      expanded[q.id] = true;
      input.value = '';
      render();
      runQueries([q.id]);
    });
    wrap.appendChild(form);

    var ex = el('div', 'empty__examples');
    ex.appendChild(el('span', 'empty__examplesLabel', 'Or start with:'));
    SAMPLES.forEach(function (s) {
      var b = el('button', 'chip', s);
      b.type = 'button';
      b.addEventListener('click', function () {
        var q = S.addQuery(s, 'all');
        expanded[q.id] = true;
        render();
        runQueries([q.id]);
      });
      ex.appendChild(b);
    });
    wrap.appendChild(ex);
    return wrap;
  }

  function renderEntry(q) {
    var wrap = el('article', 'entry');
    var isOpen = !!expanded[q.id];
    wrap.classList.toggle('is-open', isOpen);

    var res = results[q.id];
    var g = groupItems(res ? res.items : []);

    var head = el('div', 'entry__head');

    var titleBtn = el('button', 'entry__toggle');
    titleBtn.type = 'button';
    titleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    titleBtn.appendChild(el('span', 'entry__caret', isOpen ? '▾' : '▸'));
    titleBtn.appendChild(el('span', 'entry__text', q.text));
    if (res) {
      var badge = el('span', 'entry__counts');
      badge.appendChild(el('span', 'count count--new', String(g.today.length)));
      badge.appendChild(el('span', 'count count--unread', String(g.unread.length)));
      if (g.read.length) badge.appendChild(el('span', 'count count--read', String(g.read.length)));
      badge.title = g.today.length + ' published today · ' + g.unread.length + ' unread · ' + g.read.length + ' read';
      titleBtn.appendChild(badge);
    }
    titleBtn.addEventListener('click', function () {
      expanded[q.id] = !expanded[q.id];
      render();
    });
    head.appendChild(titleBtn);

    var mode = el('select', 'entry__mode');
    mode.setAttribute('aria-label', 'Source mode for ' + q.text);
    [['all', 'All Sources'], ['first', 'My Sources First'], ['only', 'My Sources Only']]
      .forEach(function (pair) {
        var o = el('option', null, pair[1]);
        o.value = pair[0];
        if (q.mode === pair[0]) o.selected = true;
        mode.appendChild(o);
      });
    mode.addEventListener('change', function () {
      S.setQueryMode(q.id, mode.value);
      runQueries([q.id]);
    });
    head.appendChild(mode);

    var run = el('button', 'iconbtn', '⟳');
    run.type = 'button';
    run.title = 'Run this watch now';
    run.addEventListener('click', function () { runQueries([q.id]); });
    head.appendChild(run);

    var del = el('button', 'iconbtn iconbtn--danger', '✕');
    del.type = 'button';
    del.title = 'Remove this watch';
    del.addEventListener('click', function () {
      if (!confirm('Remove "' + q.text + '" from your watchlist?')) return;
      delete results[q.id];
      saveResults();
      S.removeQuery(q.id);
      render();
    });
    head.appendChild(del);

    wrap.appendChild(head);

    if (!isOpen) return wrap;

    var body = el('div', 'entry__body');

    // State 1 — the feed could not be reached. Say so, and keep what we had.
    if (res && res.error) {
      var err = el('div', 'notice notice--error');
      err.appendChild(el('span', 'notice__title', 'Could not reach the feed'));
      err.appendChild(el('span', 'notice__body', res.error));
      if (res.fetchedAt) {
        err.appendChild(el('span', 'notice__body',
          'Showing the last results from ' + timeAgo(res.fetchedAt) + '.'));
      }
      var retry = el('button', 'btn btn--ghost notice__btn', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', function () { runQueries([q.id]); });
      err.appendChild(retry);
      body.appendChild(err);
      // A failed fetch is not an empty result — never say the feed answered.
      if (!res.items.length) {
        body.appendChild(el('p', 'entry__empty', 'Nothing to show yet.'));
        wrap.appendChild(body);
        return wrap;
      }
    }

    // State 2 — never run.
    if (!res) {
      body.appendChild(el('p', 'entry__empty', 'Not run yet — press ⟳ to fetch this watch.'));
      wrap.appendChild(body);
      return wrap;
    }

    // State 3 — ran fine, nothing matched.
    if (!res.items.length) {
      body.appendChild(el('p', 'entry__empty',
        'The feed answered, but nothing matched this query.'));
      wrap.appendChild(body);
      return wrap;
    }

    // State 4 — ran fine, nothing in the chosen period.
    if (!g.today.length && !g.unread.length && !g.read.length) {
      body.appendChild(el('p', 'entry__empty',
        'Nothing in this period. Try a wider period in the filter above.'));
      wrap.appendChild(body);
      return wrap;
    }

    if (g.today.length) body.appendChild(renderGroup('Published Today', g.today, q, false));
    if (g.unread.length) body.appendChild(renderGroup('Unread', g.unread, q, false, 20));
    if (g.read.length) body.appendChild(renderGroup('Read', g.read, q, true));

    if (res.fetchedAt) {
      body.appendChild(el('p', 'entry__stamp', 'updated ' + timeAgo(res.fetchedAt)));
    }

    wrap.appendChild(body);
    return wrap;
  }

  function renderGroup(title, items, q, collapsed, cap) {
    var sec = el('section', 'group');
    var h = el('button', 'group__head');
    h.type = 'button';
    h.appendChild(el('span', 'group__title', title));
    h.appendChild(el('span', 'group__n', String(items.length)));
    if (collapsed) h.appendChild(el('span', 'group__caret', '▸'));
    sec.classList.toggle('is-collapsed', collapsed);
    h.addEventListener('click', function () {
      if (!collapsed) return;
      sec.classList.toggle('is-open');
    });
    sec.appendChild(h);

    var list = el('ul', 'links');
    var shown = items;
    var more = 0;
    if (cap && items.length > cap && !showAll[q.id]) {
      shown = items.slice(0, cap);
      more = items.length - cap;
    }
    shown.forEach(function (it) { list.appendChild(renderLink(it, q)); });

    if (more > 0) {
      var m = el('button', 'group__more', 'Show ' + more + ' more');
      m.type = 'button';
      m.addEventListener('click', function () { showAll[q.id] = true; render(); });
      list.appendChild(m);
    } else if (cap && items.length > cap && showAll[q.id]) {
      var lm = el('button', 'group__more', 'Show fewer');
      lm.type = 'button';
      lm.addEventListener('click', function () { showAll[q.id] = false; render(); });
      list.appendChild(lm);
    }

    sec.appendChild(list);
    return sec;
  }

  function renderLink(it, q) {
    var li = el('li', 'link');
    if (S.isRead(it.url)) li.classList.add('is-read');

    var a = el('a', 'link__title', it.title);
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (it.needsResolve) a.dataset.needsResolve = '1';
    a.addEventListener('click', function (e) {
      var wasRead = S.isRead(it.url);
      S.markRead(it.url);
      if (!wasRead) setTimeout(function () { render(); }, 0);
      // Only the Worker can resolve an opaque Google link into the publisher's
      // own URL — the browser cannot POST to Google's resolver. In relay mode
      // the Google link opens and redirects on its own.
      if (a.dataset.needsResolve === '1' && Api.backend() === 'worker') {
        e.preventDefault();
        window.open(it.url, '_blank', 'noopener');
        fetch('/api/resolve?u=' + encodeURIComponent(it.url)).then(function (r) {
          return r.json();
        }).then(function (j) {
          if (j && j.url) { a.href = j.url; delete a.dataset.needsResolve; a.title = j.url; }
          render();
        }).catch(function () { render(); });
      }
    });
    li.appendChild(a);

    var meta = el('span', 'link__meta');
    if (it.source) meta.appendChild(el('span', 'link__src', it.source));
    if (it.published) {
      var t = el('time', 'link__time', timeAgo(it.published));
      t.dateTime = it.published;
      t.title = new Date(it.published).toLocaleString();
      meta.appendChild(t);
    }
    li.appendChild(meta);

    var acts = el('span', 'link__acts');

    var add = el('button', 'link__act', '+ source');
    add.type = 'button';
    add.title = it.domain ? 'Add ' + it.domain + ' to My Sources' : 'Add this source';
    if (!it.domain || S.hasSource(it.domain)) {
      add.disabled = true;
      add.textContent = '✓ source';
    }
    add.addEventListener('click', function () {
      if (!it.domain) return;
      S.addSource(it.source || it.domain, it.domain);
      render();
    });
    acts.appendChild(add);

    var ig = el('button', 'link__act link__act--danger', '✕');
    ig.type = 'button';
    ig.title = 'Ignore this link for ' + (S.state().settings.ignoreDays || 0) + ' days';
    ig.addEventListener('click', function () {
      S.ignore({ url: it.url, title: it.title, source: it.source, domain: it.domain, query: q ? q.text : '' });
      render();
    });
    acts.appendChild(ig);

    li.appendChild(acts);
    return li;
  }

  /* ---- sources ---- */

  function renderSources(main) {
    var wrap = el('div', 'panel');
    wrap.appendChild(el('h2', 'panel__title', 'My Sources'));
    wrap.appendChild(el('p', 'panel__body',
      'The publishers you trust. In "My Sources First" they are fetched directly and shown above everything else. ' +
      'In "My Sources Only" nothing else appears at all.'));

    var srcs = S.state().sources;
    if (!srcs.length) {
      wrap.appendChild(el('p', 'panel__empty',
        'No sources yet. Open any watch and press "+ source" on an article to add its publisher here.'));
    } else {
      var ul = el('ul', 'sourcelist');
      srcs.forEach(function (s) {
        var li = el('li', 'sourcelist__item');
        li.appendChild(el('span', 'sourcelist__name', s.name || s.domain));
        li.appendChild(el('span', 'sourcelist__domain', s.domain));
        var rm = el('button', 'iconbtn iconbtn--danger', '✕');
        rm.type = 'button';
        rm.title = 'Remove';
        rm.addEventListener('click', function () { S.removeSource(s.domain); render(); });
        li.appendChild(rm);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    main.appendChild(wrap);
  }

  /* ---- ignored ---- */

  function renderIgnored(main) {
    var wrap = el('div', 'panel');
    wrap.appendChild(el('h2', 'panel__title', 'Ignored Links'));

    var days = S.state().settings.ignoreDays;
    var setWrap = el('div', 'field');
    setWrap.appendChild(el('label', 'field__label', 'Keep ignored links for'));
    var sel = el('select', 'field__select');
    [[7, '7 days'], [14, '14 days'], [30, '30 days'], [90, '90 days'], [0, 'indefinitely']]
      .forEach(function (p) {
        var o = el('option', null, p[1]);
        o.value = String(p[0]);
        if (days === p[0]) o.selected = true;
        sel.appendChild(o);
      });
    sel.addEventListener('change', function () {
      S.state().settings.ignoreDays = parseInt(sel.value, 10);
      S.save();
      render();
    });
    setWrap.appendChild(sel);
    wrap.appendChild(setWrap);

    var ig = S.state().ignored;
    if (!ig.length) {
      wrap.appendChild(el('p', 'panel__empty', 'Nothing ignored.'));
    } else {
      var ul = el('ul', 'ignorelist');
      ig.forEach(function (x) {
        var li = el('li', 'ignorelist__item');
        li.appendChild(el('span', 'ignorelist__title', x.title || x.url));
        var meta = el('span', 'ignorelist__meta');
        meta.appendChild(el('span', null, x.source || x.domain || ''));
        if (x.expiresAt) {
          meta.appendChild(el('span', null, ' · back in ' +
            Math.max(0, Math.ceil((x.expiresAt - Date.now()) / 86400000)) + 'd'));
        } else {
          meta.appendChild(el('span', null, ' · kept indefinitely'));
        }
        li.appendChild(meta);
        var un = el('button', 'link__act', 'restore');
        un.type = 'button';
        un.addEventListener('click', function () { S.unignore(x.url); render(); });
        li.appendChild(un);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    main.appendChild(wrap);
  }

  /* ---------------- running queries ---------------- */

  function runQueries(ids) {
    if (busy) {
      // A refresh is already running. Queue this one instead of dropping it —
      // otherwise changing a mode mid-refresh looks like it did nothing.
      queued = true;
      if (!ids) queuedIds = [];
      else ids.forEach(function (i) {
        if (queuedIds.indexOf(i) < 0) queuedIds.push(i);
      });
      return Promise.resolve();
    }
    busy = true;

    var targets = ids ? ids.map(function (i) { return S.findQuery(i); }).filter(Boolean)
      : S.state().queries.slice();
    if (!targets.length) { busy = false; render(); return Promise.resolve(); }

    var sources = S.sourceDomains();
    var chain = Promise.resolve();
    targets.forEach(function (q) {
      chain = chain.then(function () {
        return Api.search(q.text, q.mode, sources).then(function (items) {
          results[q.id] = { fetchedAt: new Date().toISOString(), items: items || [], error: null };
          S.setQueryRan(q.id);
          saveResults();
        }).catch(function (e) {
          // Keep the last good results. A failed refresh must not wipe the list,
          // and it must not look like "this query has no results".
          var prev = results[q.id] || {};
          results[q.id] = {
            fetchedAt: prev.fetchedAt || null,
            items: prev.items || [],
            error: (e && e.message) ? e.message : String(e)
          };
          saveResults();
        });
      });
    });

    return chain.then(function () {
      busy = false;
      render();
      if (queued) {
        queued = false;
        var next = queuedIds.length ? queuedIds.slice() : null;
        queuedIds = [];
        return runQueries(next);
      }
    });
  }

  /* ---------------- top bar ---------------- */

  function wireTopbar() {
    var form = document.getElementById('search-form');
    var input = document.getElementById('search-input');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      var q = S.addQuery(v, 'all');
      expanded[q.id] = true;
      input.value = '';
      view = 'watchlist';
      render();
      runQueries([q.id]);
    });

    document.getElementById('refresh-all').addEventListener('click', function () {
      expanded = {};
      S.state().queries.forEach(function (q) { expanded[q.id] = true; });
      render();
      runQueries(null);
    });

    var period = document.getElementById('period');
    var options = [
      ['latest', 'Latest'], ['week', 'This Week'], ['month', 'This Month'],
      ['year', 'This Year'], ['2025', '2025'], ['2024', '2024'], ['2023', '2023'],
      ['2022', '2022'], ['2021', '2021'], ['2020', '2020'], ['all', 'All Time']
    ];
    options.forEach(function (p) {
      var o = el('option', null, p[1]);
      o.value = p[0];
      if (S.state().settings.period === p[0]) o.selected = true;
      period.appendChild(o);
    });
    period.addEventListener('change', function () {
      S.state().settings.period = period.value;
      S.save();
      render();
    });

    document.querySelectorAll('.nav__btn').forEach(function (b) {
      b.addEventListener('click', function () {
        view = b.dataset.view;
        render();
      });
    });

    document.getElementById('export-btn').addEventListener('click', function () {
      var blob = new Blob([S.exportState()], { type: 'application/json' });
      var a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'watchlab-list.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    document.getElementById('import-btn').addEventListener('click', function () {
      document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          S.importState(String(fr.result));
          render();
          runQueries(null);
        } catch (err) {
          alert('That file could not be read: ' + err.message);
        }
      };
      fr.readAsText(f);
      e.target.value = '';
    });
  }

  /* ---------------- boot ---------------- */

  function boot() {
    wireTopbar();

    // When the live feed finally answers, swap it in over the bundled snapshot.
    // Keep any publisher URL we already resolved — the live path can only
    // produce Google redirect links, which are worse to click.
    Api.onLive(function (payload) {
      var q = S.state().queries.filter(function (x) { return x.text === payload.query; })[0];
      if (!q) return;
      var prev = results[q.id] ? results[q.id].items : [];
      var resolved = {};
      prev.forEach(function (it) {
        if (it.url && it.url.indexOf('news.google.com') !== 0) resolved[normTitle(it.title)] = it.url;
      });
      var merged = payload.items.map(function (it) {
        var r = resolved[normTitle(it.title)];
        return r ? Object.assign({}, it, { url: r, needsResolve: false }) : it;
      });
      results[q.id] = { fetchedAt: new Date().toISOString(), items: merged, error: null };
      saveResults();
      render();
    });

    render();
    if (S.state().queries.length) {
      S.state().queries.forEach(function (q) { expanded[q.id] = true; });
      render();
      runQueries(null);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
