/* Ревью лендингов: правка текста на странице + комментарии слева. Данные хранятся в db: comments/*, edits/*. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var PAGES = { general: { title: 'Генеральная уборка', tpl: 'tpl-general', cfg: 'cfg-general' }, reno: { title: 'После ремонта', tpl: 'tpl-reno', cfg: 'cfg-reno' } };
  var NARROW = window.matchMedia('(max-width:860px)').matches;
  var S = { page: 'general', device: NARROW ? 'mobile' : 'desktop', mode: 'view', tab: 'comments', filter: 'open', comments: [], edits: {}, draft: null, sel: null,
            db: null, user: null, me: { id: 'local', name: 'Вы' }, canWrite: true, canEdit: true, names: {}, local: true };
  var stage = $('#stage'), canvas = $('#canvas'), sheet = $('#sheet'), pinsEl = $('#pins'), panelBody = $('#p-body'), panel = $('#panel');
  var saveTimers = {};

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function sel(eid) { return stage.querySelector('[data-eid="' + eid.replace(/"/g, '') + '"]'); }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function plain(s) { return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function when(t) { try { return new Date(t).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  /* безопасный HTML для чужих правок: только текстовые теги и иконка-svg */
  var OK_TAGS = { B: 1, STRONG: 1, EM: 1, I: 1, BR: 1, SPAN: 1, SMALL: 1, SVG: 1, PATH: 1 }, OK_ATTR = { class: 1, viewbox: 1, d: 1, 'aria-hidden': 1 };
  function clean(html) {
    var t = document.createElement('template'); t.innerHTML = String(html).slice(0, 5000);
    (function walk(n) {
      Array.prototype.slice.call(n.childNodes).forEach(function (c) {
        if (c.nodeType === 3) return;
        if (c.nodeType !== 1 || !OK_TAGS[c.tagName.toUpperCase()]) { c.remove(); return; }
        Array.prototype.slice.call(c.attributes).forEach(function (a) { if (!OK_ATTR[a.name.toLowerCase()]) c.removeAttribute(a.name); });
        walk(c);
      });
    })(t.content);
    return t.innerHTML;
  }

  /* ---------- разметка лендинга ---------- */
  var TEXT_SEL = 'h1,h2,h3,p,li,summary,td,th,.btn,.ba-cap,.chip,.eyebrow,.tag,.fact b,.fact span,.badge b,.cap,.who b,.who span,.cnt,.pct,.top-time,.foot .w > div';
  var BLOCK_SEL = 'header.top,.facts,section,footer.foot,.ba,.hero-pic';

  function annotate() {
    var seen = {}, els = Array.prototype.filter.call(stage.querySelectorAll(TEXT_SEL), function (el) {
      return !el.closest('[data-ref]') && !el.closest('.mbar') && !el.matches('.top-phone,.logo');
    });
    els = els.filter(function (el) { return !els.some(function (o) { return o !== el && el.contains(o); }); });
    els.forEach(function (el) {
      var key = el.tagName.toLowerCase() + hash(plain(el.textContent)); seen[key] = (seen[key] || 0) + 1;
      el.setAttribute('data-eid', key + '-' + seen[key]); el.setAttribute('data-kind', 'text'); el.dataset.orig = el.innerHTML;
    });
    var bi = 0;
    Array.prototype.forEach.call(stage.querySelectorAll(BLOCK_SEL), function (el) {
      var label = (el.querySelector('h1,h2') || {}).textContent;
      el.setAttribute('data-eid', 'blk' + (++bi) + '-' + hash(plain(label || el.className || el.tagName)));
      el.setAttribute('data-kind', 'block'); el.dataset.label = plain(label || (el.matches('.ba') ? 'Фото до/после' : el.matches('.hero-pic') ? 'Фото в первом экране' : el.matches('.top') ? 'Шапка' : el.matches('.facts') ? 'Цифры доверия' : el.matches('.foot') ? 'Подвал' : 'Блок'));
    });
  }

  function labelOf(el) { return el.getAttribute('data-kind') === 'block' ? 'Блок: ' + el.dataset.label : plain(el.textContent).slice(0, 160); }

  /* ---------- правки текста ---------- */
  function editId(eid) { return S.page + '__' + eid; }
  function applyEdits() {
    Array.prototype.forEach.call(stage.querySelectorAll('[data-kind=text]'), function (el) {
      var e = S.edits[editId(el.getAttribute('data-eid'))];
      if (document.activeElement === el) return;
      var want = e ? clean(e.html) : el.dataset.orig;
      if (el.innerHTML !== want) el.innerHTML = want;
      if (e) el.setAttribute('data-edited', ''); else el.removeAttribute('data-edited');
    });
  }
  function queueSave(el) {
    var eid = el.getAttribute('data-eid'); clearTimeout(saveTimers[eid]);
    saveTimers[eid] = setTimeout(function () {
      var html = el.innerHTML.trim(), id = editId(eid);
      if (html === el.dataset.orig.trim()) { delete S.edits[id]; el.removeAttribute('data-edited'); dbDelete('edits', id); }
      else {
        var doc = { page: S.page, eid: eid, html: html, orig: el.dataset.orig, text: plain(html), origText: plain(el.dataset.orig), by: S.me.id, byName: S.me.name, at: Date.now() };
        S.edits[id] = doc; el.setAttribute('data-edited', ''); dbSet('edits', id, doc);
      }
      renderPanel(); renderTabs();
    }, 500);
  }
  function revert(id) {
    var e = S.edits[id]; if (!e) return; delete S.edits[id]; dbDelete('edits', id);
    if (e.page === S.page) applyEdits(); renderPanel(); renderTabs(); place();
  }

  /* ---------- db ---------- */
  function dbSet(col, id, doc) { if (S.db) S.db.doc(col + '/' + id).set(doc).catch(function (e) { toast('Не удалось сохранить: ' + (e && e.code || 'ошибка')); }); }
  function dbDelete(col, id) { if (S.db) S.db.doc(col + '/' + id).delete().catch(function () {}); }
  var toastT;
  function toast(m) { var n = $('#toast'); n.textContent = m; n.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { n.hidden = true; }, 3500); }

  /* ---------- комментарии ---------- */
  function pageComments() { return S.comments.filter(function (c) { return c.page === S.page; }).sort(function (a, b) { return a.at - b.at; }); }
  function numOf(c) { return pageComments().indexOf(c) + 1; }
  function addComment(text) {
    var d = S.draft; if (!d || !text.trim()) return;
    var id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var doc = { page: S.page, eid: d.eid, quote: d.quote, text: text.trim(), by: S.me.id, byName: S.me.name, at: Date.now(), resolved: false };
    S.comments.push(Object.assign({ id: id }, doc)); S.draft = null; S.sel = id; dbSet('comments', id, doc); S.filter = 'open';
    renderAll();
  }
  function toggleResolved(c) { c.resolved = !c.resolved; if (S.db) S.db.doc('comments/' + c.id).update({ resolved: c.resolved }).catch(function () {}); renderAll(); }
  function removeComment(c) { S.comments = S.comments.filter(function (x) { return x !== c; }); dbDelete('comments', c.id); renderAll(); }

  function focusEl(eid, id) {
    var el = sel(eid); if (!el) { toast('Элемент не найден: текст на странице изменился'); return; }
    var d = el.closest('details'); if (d) d.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('rv-flash'); void el.offsetWidth; el.classList.add('rv-flash');
    S.sel = id || null; renderPanel(); place();
  }

  /* ---------- отрисовка панели ---------- */
  function renderTabs() {
    var cn = pageComments().filter(function (c) { return !c.resolved; }).length, en = Object.keys(S.edits).filter(function (k) { return S.edits[k].page === S.page; }).length;
    $('#tab-comments .n').textContent = cn; $('#tab-edits .n').textContent = en;
    $('#tab-comments').setAttribute('aria-selected', S.tab === 'comments'); $('#tab-edits').setAttribute('aria-selected', S.tab === 'edits');
    $('#tp-count').textContent = cn;
  }
  function who(c) { return esc((S.names[c.by] || c.byName || 'Участник')); }
  function renderPanel() {
    var h = '';
    if (S.local) h += '<div class="notice">Хранилище недоступно: комментарии и правки видны только в этой вкладке и пропадут после перезагрузки.</div>';
    else if (!S.canWrite) h += '<div class="notice">У вас доступ только для чтения: комментировать и править могут участники с правом «Contributor» и выше.</div>';
    if (S.tab === 'comments') {
      if (S.draft) {
        h += '<div class="composer"><div class="q">' + esc(S.draft.quote) + '</div><textarea id="draft-text" placeholder="Что поправить или спросить?" rows="3"></textarea>' +
             '<div class="row"><button class="btn" id="draft-cancel" type="button">Отмена</button><button class="btn pri" id="draft-ok" type="button">Добавить комментарий</button></div></div>';
      }
      h += '<div class="filters" role="group" aria-label="Фильтр">' + [['open', 'Открытые'], ['done', 'Решённые'], ['all', 'Все']].map(function (f) {
        return '<button type="button" class="chip" data-filter="' + f[0] + '" aria-pressed="' + (S.filter === f[0]) + '">' + f[1] + '</button>'; }).join('') + '</div>';
      var list = pageComments().filter(function (c) { return S.filter === 'all' || (S.filter === 'done') === !!c.resolved; });
      if (!list.length) {
        h += '<div class="empty">' + (S.comments.length ? 'Здесь пока ничего нет.' : '<b>Комментариев пока нет.</b><br>Включите режим «Комментарий» вверху и нажмите на любой текст или блок лендинга: он подсветится, а здесь появится поле для заметки.') + '</div>';
      }
      list.forEach(function (c) {
        var mine = c.by === S.me.id || S.canEdit;
        h += '<div class="card' + (c.resolved ? ' done' : '') + (S.sel === c.id ? ' sel' : '') + '" data-cid="' + esc(c.id) + '"><div class="top"><span class="num">' + numOf(c) + '</span><b>' + who(c) + '</b><span>' + when(c.at) + '</span></div>' +
             '<div class="quote" data-go="' + esc(c.eid) + '" title="Показать на странице">' + esc(c.quote) + '</div><div class="txt">' + esc(c.text) + '</div>' +
             '<div class="acts"><button class="btn sm" type="button" data-act="go">Показать</button>' + (S.canWrite ? '<button class="btn sm" type="button" data-act="res">' + (c.resolved ? 'Открыть снова' : 'Решено') + '</button>' : '') +
             (mine && S.canWrite ? '<button class="btn sm" type="button" data-act="del">Удалить</button>' : '') + '</div></div>';
      });
    } else {
      var keys = Object.keys(S.edits).filter(function (k) { return S.edits[k].page === S.page; });
      if (!keys.length) h += '<div class="empty"><b>Правок пока нет.</b><br>Включите режим «Правка» вверху и измените текст прямо на лендинге. Изменения сохраняются сами, а Claude увидит их и перенесёт в настоящие файлы.</div>';
      keys.forEach(function (k) {
        var e = S.edits[k];
        h += '<div class="card" data-eidcard="' + esc(e.eid) + '"><div class="top"><b>' + esc(e.byName || 'Участник') + '</b><span>' + when(e.at) + '</span></div><div class="diff"><div class="o">' + esc(e.origText) + '</div><div class="n">' + esc(e.text) + '</div></div>' +
             '<div class="acts"><button class="btn sm" type="button" data-act="goedit">Показать</button>' + (S.canWrite ? '<button class="btn sm" type="button" data-act="rev" data-id="' + esc(k) + '">Вернуть как было</button>' : '') + '</div></div>';
      });
    }
    h += '<div class="row"><button class="btn sm" type="button" id="copy-all">Скопировать всё текстом</button></div>';
    panelBody.innerHTML = h;
    var ta = $('#draft-text'); if (ta) ta.focus({ preventScroll: true });
  }

  function summaryText() {
    var L = ['Лендинг: ' + PAGES[S.page].title, ''];
    pageComments().forEach(function (c) { L.push((c.resolved ? '[решено] ' : '') + numOf(c) + '. «' + c.quote + '» — ' + c.text); });
    Object.keys(S.edits).forEach(function (k) { var e = S.edits[k]; if (e.page === S.page) L.push('Правка: «' + e.origText + '» → «' + e.text + '»'); });
    return L.join('\n');
  }

  /* ---------- булавки поверх лендинга ---------- */
  function place() {
    pinsEl.innerHTML = '';
    var sr = sheet.getBoundingClientRect();
    pageComments().forEach(function (c) {
      if (c.resolved) return;
      var el = sel(c.eid); if (!el) return;
      var r = el.getBoundingClientRect(); if (!r.width && !r.height) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'pin' + (S.sel === c.id ? ' sel' : ''); b.textContent = numOf(c);
      b.style.left = Math.max(2, Math.min(sr.width - 26, r.right - sr.left - 14)) + 'px'; b.style.top = Math.max(2, r.top - sr.top - 12) + 'px';
      b.setAttribute('aria-label', 'Комментарий ' + numOf(c)); b.dataset.cid = c.id; pinsEl.appendChild(b);
    });
  }

  /* ---------- размеры, режимы ---------- */
  function layout() {
    var w = S.device === 'mobile' ? 390 : 1280, avail = canvas.clientWidth - (NARROW ? 20 : 36), z = Math.min(1, avail / w);
    stage.style.width = w + 'px'; stage.style.zoom = z; sheet.className = 'sheet device-' + S.device;
    place();
  }
  function setMode(m) {
    S.mode = m; document.body.className = 'mode-' + m;
    Array.prototype.forEach.call(document.querySelectorAll('#mode button'), function (b) { b.setAttribute('aria-pressed', b.dataset.v === m); });
    Array.prototype.forEach.call(stage.querySelectorAll('[data-kind=text]'), function (el) { if (m === 'edit' && S.canWrite) el.setAttribute('contenteditable', 'true'); else el.removeAttribute('contenteditable'); });
    Array.prototype.forEach.call(stage.querySelectorAll('details'), function (d) { d.open = m === 'edit'; });
    $('#hint').textContent = m === 'edit' ? 'Нажмите на текст и правьте. Сохраняется само.' : m === 'comment' ? 'Нажмите на текст или блок, чтобы оставить комментарий.' : 'Просмотр: калькулятор и кнопки работают как на сайте.';
    place();
  }
  function renderAll() { renderTabs(); renderPanel(); place(); }

  function mount() {
    var p = PAGES[S.page], t = document.getElementById(p.tpl);
    stage.innerHTML = ''; stage.appendChild(t.content.cloneNode(true));
    window.CHL_CONFIG = JSON.parse(document.getElementById(p.cfg).textContent);
    try { window.__chlInit(); } catch (e) { toast('Не удалось запустить калькулятор'); }
    annotate(); applyEdits(); setMode(S.mode); layout(); S.draft = null; S.sel = null; renderAll();
    Array.prototype.forEach.call(document.querySelectorAll('#page button'), function (b) { b.setAttribute('aria-pressed', b.dataset.v === S.page); });
    Array.prototype.forEach.call(document.querySelectorAll('#device button'), function (b) { b.setAttribute('aria-pressed', b.dataset.v === S.device); });
  }

  /* ---------- события ---------- */
  var mock = $('#mock');
  function openMock() { var v = $('#mock-calc'); $('#mock-view').textContent = v ? v.value : ''; $('#mock-ok').hidden = true; mock.hidden = false; }
  $('#mock-close').onclick = function () { mock.hidden = true; };
  mock.addEventListener('click', function (e) { if (e.target === mock) mock.hidden = true; });
  $('#mock-form').addEventListener('submit', function (e) { e.preventDefault(); $('#mock-ok').hidden = false; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !mock.hidden) mock.hidden = true; });
  stage.addEventListener('click', function (e) {   // в режиме просмотра кнопки заявки открывают пример окна
    if (S.mode !== 'view') return;
    var l = e.target.closest('[data-lead]'); if (l) { e.preventDefault(); openMock(); }
  });
  stage.addEventListener('click', function (e) {
    if (e.target.closest('[data-ba]')) return;   // переключатель примеров «до/после» работает во всех режимах
    if (S.mode === 'view') return;
    if (e.target.closest('a,button,summary,label,input')) e.preventDefault();
    e.stopPropagation();
    if (S.mode === 'comment') {
      var el = e.target.closest('[data-eid]'); if (!el) return;
      S.tab = 'comments'; S.draft = { eid: el.getAttribute('data-eid'), quote: labelOf(el) }; if (NARROW) panel.classList.add('open');
      renderAll();
    }
  }, true);
  stage.addEventListener('keydown', function (e) {
    if (S.mode !== 'edit') return;
    if (e.key === 'Enter') e.preventDefault();
    if (e.key === ' ' && e.target.closest('summary')) { e.preventDefault(); document.execCommand('insertText', false, ' '); }
  }, true);
  stage.addEventListener('keyup', function (e) { if (S.mode === 'edit' && e.key === ' ' && e.target.closest('summary')) e.preventDefault(); }, true);
  stage.addEventListener('input', function (e) { if (S.mode === 'edit') { var el = e.target.closest('[data-kind=text]'); if (el) queueSave(el); } });
  stage.addEventListener('paste', function (e) { if (S.mode !== 'edit') return; e.preventDefault(); var t = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, t.replace(/\s+/g, ' ')); });
  stage.addEventListener('toggle', function (e) { if (S.mode === 'edit' && e.target.tagName === 'DETAILS' && !e.target.open) e.target.open = true; }, true);

  panel.addEventListener('click', function (e) {
    var t = e.target.closest('button,[data-go]'); if (!t) return;
    if (t.id === 'draft-cancel') { S.draft = null; renderPanel(); return; }
    if (t.id === 'draft-ok') { addComment($('#draft-text').value); return; }
    if (t.id === 'copy-all') { var s = summaryText(); (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(function () { toast('Скопировано'); }, function () { toast('Не удалось скопировать: выделите текст вручную'); }); return; }
    if (t.dataset.filter) { S.filter = t.dataset.filter; renderPanel(); return; }
    if (t.dataset.go) { var c0 = S.comments.filter(function (c) { return c.eid === t.dataset.go; })[0]; focusEl(t.dataset.go, c0 && c0.id); return; }
    var card = t.closest('[data-cid]'), c = card && S.comments.filter(function (x) { return x.id === card.dataset.cid; })[0];
    if (t.dataset.act === 'go' && c) focusEl(c.eid, c.id);
    else if (t.dataset.act === 'res' && c) toggleResolved(c);
    else if (t.dataset.act === 'del' && c) removeComment(c);
    else if (t.dataset.act === 'goedit') focusEl(t.closest('[data-eidcard]').dataset.eidcard);
    else if (t.dataset.act === 'rev') revert(t.dataset.id);
  });
  panel.addEventListener('keydown', function (e) { if (e.target.id === 'draft-text') { if (e.key === 'Escape') { S.draft = null; renderPanel(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addComment(e.target.value); } });
  $('#tab-comments').onclick = function () { S.tab = 'comments'; renderAll(); };
  $('#tab-edits').onclick = function () { S.tab = 'edits'; renderAll(); };
  $('#mode').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setMode(b.dataset.v); });
  $('#device').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { S.device = b.dataset.v; mount(); } });
  $('#page').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && b.dataset.v !== S.page) { S.page = b.dataset.v; canvas.scrollTop = 0; mount(); } });
  $('#toggle-panel').onclick = function () { panel.classList.toggle('open'); };
  $('#close-panel').onclick = function () { panel.classList.remove('open'); };
  pinsEl.addEventListener('click', function (e) { var b = e.target.closest('.pin'); if (!b) return; var c = S.comments.filter(function (x) { return x.id === b.dataset.cid; })[0]; if (c) { S.tab = 'comments'; S.filter = 'open'; S.sel = c.id; if (NARROW) panel.classList.add('open'); renderAll(); var card = panelBody.querySelector('[data-cid="' + c.id + '"]'); if (card) card.scrollIntoView({ block: 'center' }); } });
  window.addEventListener('resize', layout);
  if (window.ResizeObserver) new ResizeObserver(function () { place(); }).observe(stage);
  canvas.addEventListener('scroll', function () { }, { passive: true });

  /* ---------- запуск: сначала страница, потом хранилище ---------- */
  mount();
  (async function () {
    var c = window.claude; if (!c || !c.use) return;
    try {
      var results = await Promise.all([c.use('db'), c.use('user')]), db = results[0], user = results[1];
      if (!db) return;
      S.db = db; S.local = false; S.user = user;
      if (user) {
        try { var me = await user.me(); S.me = { id: me.id || 'anon', name: me.name || 'Участник' }; S.canEdit = !!me.canEdit || !!me.isOwner; } catch (e) { }
        try { var cw = await user.can('data.write'); if (cw === false) S.canWrite = false; } catch (e) { }
      }
      if (!S.canWrite && S.mode !== 'view') setMode('view');
      db.collection('comments').onSnapshot(function (snap) {
        S.comments = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        var ids = S.comments.map(function (x) { return x.by; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
        if (user && user.profiles && ids.length) user.profiles(ids).then(function (p) { ids.forEach(function (i) { if (p[i] && p[i].name) S.names[i] = p[i].name; }); renderPanel(); }, function () { });
        if (!(S.draft && document.activeElement && document.activeElement.id === 'draft-text')) renderAll(); else { renderTabs(); place(); }
      }, function () { toast('Нет доступа к комментариям'); });
      db.collection('edits').onSnapshot(function (snap) {
        var m = {}; snap.docs.forEach(function (d) { m[d.id] = d.data(); }); S.edits = m; applyEdits(); renderTabs(); if (S.tab === 'edits') renderPanel(); place();
      }, function () { toast('Нет доступа к правкам'); });
      renderPanel();
    } catch (e) { S.local = true; renderPanel(); }
  })();
})();
