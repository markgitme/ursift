/* Watchlab — local state.
 * Everything the user owns lives here: queries, sources, read marks, ignored
 * links, settings. No account, no server. One JSON blob in localStorage.
 *
 * Grouping rule (Read > Published Today > Unread) is decided at render time
 * from two facts we already have: is the URL in `read`, and is the article's
 * publish date the user's local today?
 */
(function (global) {
  'use strict';

  var KEY = 'watchlab.state.v1';

  var DEFAULTS = {
    version: 1,
    queries: [],          // [{ id, text, mode, createdAt, lastRunAt }]
    sources: [],          // [{ name, domain, addedAt }]
    read: {},             // { url: firstReadTimestamp }
    ignored: [],          // [{ url, title, source, domain, query, ignoredAt, expiresAt }]
    settings: {
      period: 'latest',   // latest | week | month | year | YYYY | all
      ignoreDays: 30,     // 7 | 14 | 30 | 90 | 0 (keep indefinitely)
      region: 'US:en'
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function blank() { return clone(DEFAULTS); }

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (!raw) return blank();
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return blank();
      // merge forward so a new field never breaks an old saved state
      var out = blank();
      out.queries = Array.isArray(s.queries) ? s.queries : [];
      out.sources = Array.isArray(s.sources) ? s.sources : [];
      out.read = (s.read && typeof s.read === 'object') ? s.read : {};
      out.ignored = Array.isArray(s.ignored) ? s.ignored : [];
      if (s.settings && typeof s.settings === 'object') {
        for (var k in out.settings) {
          if (Object.prototype.hasOwnProperty.call(s.settings, k)) out.settings[k] = s.settings[k];
        }
      }
      return out;
    } catch (e) {
      return blank();
    }
  }

  var state = load();

  function save() {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      // private mode or quota — the app still works, it just forgets.
      if (global.console && console.warn) console.warn('[watchlab] could not save state:', e && e.message);
    }
  }

  /* ---------- url helpers ---------- */

  // Strip tracking noise so the same article from two feeds collapses to one.
  function normalizeUrl(u) {
    if (!u) return '';
    try {
      var p = new URL(u);
      p.hash = '';
      p.protocol = 'https:';
      p.hostname = p.hostname.toLowerCase().replace(/^www\./, '');
      var drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'fbclid', 'gclid', 'oc', 'ved', 'usg', 'sa', 'ref', 'cmpid', 'CMP', 'ncid', 'spm'];
      drop.forEach(function (k) { p.searchParams.delete(k); });
      p.pathname = p.pathname.replace(/\/+$/, '');
      return p.toString();
    } catch (e) {
      return String(u);
    }
  }

  function domainOf(u) {
    try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  /* ---------- queries ---------- */

  function addQuery(text, mode) {
    text = String(text || '').trim();
    if (!text) return null;
    var q = {
      id: 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      text: text,
      mode: mode || 'all',
      createdAt: new Date().toISOString(),
      lastRunAt: null
    };
    state.queries.unshift(q);
    save();
    return q;
  }

  function findQuery(id) {
    for (var i = 0; i < state.queries.length; i++) {
      if (state.queries[i].id === id) return state.queries[i];
    }
    return null;
  }

  function removeQuery(id) {
    state.queries = state.queries.filter(function (q) { return q.id !== id; });
    save();
  }

  function setQueryMode(id, mode) {
    var q = findQuery(id);
    if (q) { q.mode = mode; save(); }
  }

  function setQueryRan(id) {
    var q = findQuery(id);
    if (q) { q.lastRunAt = new Date().toISOString(); save(); }
  }

  /* ---------- sources ---------- */

  function addSource(name, domain) {
    domain = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (!domain) return null;
    for (var i = 0; i < state.sources.length; i++) {
      if (state.sources[i].domain === domain) return state.sources[i];
    }
    var s = { name: name || domain, domain: domain, addedAt: new Date().toISOString() };
    state.sources.push(s);
    save();
    return s;
  }

  function removeSource(domain) {
    state.sources = state.sources.filter(function (s) { return s.domain !== domain; });
    save();
  }

  function sourceDomains() {
    return state.sources.map(function (s) { return s.domain; }).filter(Boolean);
  }

  function hasSource(domain) {
    domain = String(domain || '').toLowerCase().replace(/^www\./, '');
    return state.sources.some(function (s) { return s.domain === domain; });
  }

  /* ---------- read / ignored ---------- */

  function markRead(url) {
    var k = normalizeUrl(url);
    if (!k) return;
    if (!state.read[k]) { state.read[k] = new Date().toISOString(); save(); }
  }

  function isRead(url) {
    return !!state.read[normalizeUrl(url)];
  }

  function ignore(item, days) {
    var k = normalizeUrl(item.url);
    if (!k) return;
    state.ignored = state.ignored.filter(function (x) { return normalizeUrl(x.url) !== k; });
    var d = (typeof days === 'number') ? days : state.settings.ignoreDays;
    state.ignored.push({
      url: k,
      title: item.title || '',
      source: item.source || '',
      domain: item.domain || domainOf(k),
      query: item.query || '',
      ignoredAt: new Date().toISOString(),
      expiresAt: d > 0 ? (Date.now() + d * 86400000) : null
    });
    save();
  }

  function unignore(url) {
    var k = normalizeUrl(url);
    state.ignored = state.ignored.filter(function (x) { return normalizeUrl(x.url) !== k; });
    save();
  }

  // Expiry is checked on every load, not only on refresh — an item ignored
  // yesterday with a 7-day window must be back the moment the window passes.
  function purgeExpiredIgnored() {
    var now = Date.now();
    var before = state.ignored.length;
    state.ignored = state.ignored.filter(function (x) {
      return !x.expiresAt || x.expiresAt > now;
    });
    if (state.ignored.length !== before) save();
  }

  function ignoredUrls() {
    var set = {};
    state.ignored.forEach(function (x) { set[normalizeUrl(x.url)] = true; });
    return set;
  }

  /* ---------- period ---------- */

  function localDayString(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function periodStart(period) {
    var now = new Date();
    switch (period) {
      case 'today': {
        var t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return t;
      }
      case 'week': return new Date(now.getTime() - 7 * 86400000);
      case 'month': return new Date(now.getTime() - 30 * 86400000);
      case 'year': return new Date(now.getFullYear(), 0, 1);
      case 'all': case 'latest': return null;
      default:
        if (/^\d{4}$/.test(period)) return new Date(parseInt(period, 10), 0, 1);
        return null;
    }
  }

  function inPeriod(publishedIso, period) {
    if (period === 'all' || period === 'latest') return true;
    var start = periodStart(period);
    if (!start) return true;
    var d = new Date(publishedIso);
    if (isNaN(d.getTime())) return true; // unknown date → don't hide it
    if (/^\d{4}$/.test(period)) {
      return d.getFullYear() === parseInt(period, 10);
    }
    return d.getTime() >= start.getTime();
  }

  function isPublishedToday(publishedIso) {
    var d = new Date(publishedIso);
    if (isNaN(d.getTime())) return false;
    return localDayString(d) === localDayString(new Date());
  }

  /* ---------- export / import ---------- */

  function exportState() {
    return JSON.stringify({
      version: state.version,
      exportedAt: new Date().toISOString(),
      queries: state.queries,
      sources: state.sources,
      read: state.read,
      ignored: state.ignored,
      settings: state.settings
    }, null, 2);
  }

  function importState(text) {
    var s = JSON.parse(text);
    if (!s || typeof s !== 'object') throw new Error('Not a Watchlab file');
    if (!Array.isArray(s.queries)) throw new Error('No queries in file');
    state.queries = s.queries;
    state.sources = Array.isArray(s.sources) ? s.sources : [];
    state.read = (s.read && typeof s.read === 'object') ? s.read : {};
    state.ignored = Array.isArray(s.ignored) ? s.ignored : [];
    if (s.settings && typeof s.settings === 'object') {
      for (var k in state.settings) {
        if (Object.prototype.hasOwnProperty.call(state.settings, k) &&
            Object.prototype.hasOwnProperty.call(s.settings, k)) {
          state.settings[k] = s.settings[k];
        }
      }
    }
    save();
    return true;
  }

  function reset() {
    state = blank();
    save();
  }

  global.Store = {
    KEY: KEY,
    state: function () { return state; },
    save: save,
    reset: reset,
    normalizeUrl: normalizeUrl,
    domainOf: domainOf,
    addQuery: addQuery,
    findQuery: findQuery,
    removeQuery: removeQuery,
    setQueryMode: setQueryMode,
    setQueryRan: setQueryRan,
    addSource: addSource,
    removeSource: removeSource,
    sourceDomains: sourceDomains,
    hasSource: hasSource,
    markRead: markRead,
    isRead: isRead,
    ignore: ignore,
    unignore: unignore,
    purgeExpiredIgnored: purgeExpiredIgnored,
    ignoredUrls: ignoredUrls,
    inPeriod: inPeriod,
    isPublishedToday: isPublishedToday,
    localDayString: localDayString,
    exportState: exportState,
    importState: importState
  };
})(window);
