/* ursift — the interface.
 *
 * One input, one button, one list. Nothing is fetched until the user asks,
 * and the page shows nothing at all until there is something to show.
 *
 * The three states are kept apart on purpose, because conflating them is what
 * makes a broken feed look like an empty one:
 *
 *   answered, no match — the feed came back and nothing matched the query
 *   could not reach    — the feed never answered
 */
(function () {
  'use strict';

  var form = document.getElementById('sift-form');
  var input = document.getElementById('sift-input');
  var statusEl = document.getElementById('status');
  var resultsEl = document.getElementById('results');

  var timer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setStatus(text, cls) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function elapsed(ms) {
    var s = Math.floor(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  function feedLabel(source) {
    return source === 'google' ? 'Google News' : 'Bing News';
  }

  function render(items) {
    clear(resultsEl);
    if (!items || !items.length) return;

    var list = el('ol', 'results');
    items.forEach(function (it) {
      var li = el('li', 'result');

      var a = el('a', 'result__link');
      a.href = it.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = it.title;
      li.appendChild(a);

      var meta = el('p', 'result__meta');
      if (it.source) meta.appendChild(el('span', 'result__source', it.source));
      if (it.published) {
        if (it.source) meta.appendChild(el('span', 'result__sep', '\u00b7'));
        var time = el('time', null, fmtDate(it.published));
        time.setAttribute('datetime', it.published);
        meta.appendChild(time);
      }
      li.appendChild(meta);

      list.appendChild(li);
    });
    resultsEl.appendChild(list);

    var direct = items.filter(function (i) { return i.direct; }).length;
    var note = el('p', 'results__note');
    note.textContent = items.length + (items.length === 1 ? ' result' : ' results') +
      (direct
        ? ' \u00b7 ' + direct + ' open straight on the publisher, ' +
          (items.length - direct) + ' via Google News'
        : ' \u00b7 all via Google News');
    resultsEl.appendChild(note);
  }

  function techBlock(errors) {
    var details = el('details', 'tech');
    details.appendChild(el('summary', null, 'Technical details'));
    details.appendChild(el('pre', null, errors.map(function (e) {
      return e.source + ': ' + e.message;
    }).join('\n')));
    return details;
  }

  function showError(errors, query) {
    clear(resultsEl);
    var panel = el('div', 'panel panel--err');
    panel.appendChild(el('h2', 'panel__title', 'Could not reach the news feeds.'));
    panel.appendChild(el('p', 'panel__body',
      'Nothing came back, so there is nothing to show. That is not the same as ' +
      '"no results" \u2014 the question was never answered.'));

    var actions = el('div', 'panel__actions');
    var again = el('button', 'btn', 'Try again');
    again.type = 'button';
    again.addEventListener('click', function () { run(query); });
    actions.appendChild(again);
    panel.appendChild(actions);

    panel.appendChild(techBlock(errors));
    resultsEl.appendChild(panel);
  }

  function showEmpty() {
    clear(resultsEl);
    var panel = el('div', 'panel panel--quiet');
    panel.appendChild(el('h2', 'panel__title', 'Nothing matched.'));
    panel.appendChild(el('p', 'panel__body',
      'The feed answered and there were no articles for that wording. Try fewer ' +
      'words, or a broader phrase.'));
    resultsEl.appendChild(panel);
  }

  function showPartial(errors) {
    var names = errors.map(function (e) { return feedLabel(e.source); }).join(' and ');
    var note = el('p', 'results__note results__note--warn',
      names + ' did not answer \u2014 these results came from the other feed.');
    resultsEl.appendChild(note);
    resultsEl.appendChild(techBlock(errors));
  }

  function run(query) {
    if (timer) { clearInterval(timer); timer = null; }
    clear(resultsEl);
    setStatus('Sifting\u2026', 'status__wait');

    var started = Date.now();
    var arrived = false;
    timer = setInterval(function () {
      // Once anything is on screen, stop claiming we are still sifting.
      if (arrived) return;
      setStatus('Sifting\u2026 ' + elapsed(Date.now() - started), 'status__wait');
    }, 200);

    Api.search(query, null, function (u) {
      // The first feed to answer gets the screen; the second merges into it.
      if (u.items && u.items.length) {
        arrived = true;
        render(u.items);
        setStatus(u.pending.length ? 'One feed answered, still waiting on the other\u2026' : '', '');
      }
    }).then(function (res) {
      if (timer) { clearInterval(timer); timer = null; }
      setStatus('', '');

      if (!res.items.length) {
        if (res.errors.length) showError(res.errors, query);
        else showEmpty();
        return;
      }
      render(res.items);
      if (res.errors.length) showPartial(res.errors);
    }).catch(function (err) {
      if (timer) { clearInterval(timer); timer = null; }
      setStatus('', '');
      showError([{ source: 'feed', message: (err && err.message) || String(err) }], query);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) { input.focus(); return; }
    run(q);
  });
})();
