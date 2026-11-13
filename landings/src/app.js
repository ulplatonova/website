/* CleanHub — логика лендинга: калькулятор, передача расчёта в форму Тильды, цели Метрики, слайдер «до/после», мобильная панель. */
(function () {
  'use strict';
  var C = window.CHL_CONFIG;
  var root = document.getElementById('chl');
  if (!C || !root || root.getAttribute('data-ready')) return;
  root.setAttribute('data-ready', '1');

  var S = C.service;
  var state = { area: C.defaults.area, tariff: C.defaults.tariff, x: {}, open: {}, touched: false, started: false };
  var refs = {};
  [].forEach.call(root.querySelectorAll('[data-ref]'), function (n) { refs[n.getAttribute('data-ref')] = n; });

  /* ---------- утилиты ---------- */
  function money(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plural(n, f) { var a = n % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2]; }
  function tariff(id) { for (var i = 0; i < C.tariffs.length; i++) if (C.tariffs[i].id === id) return C.tariffs[i]; return C.tariffs[0]; }
  function track(goal, params) {
    try { if (C.metrikaId && typeof window.ym === 'function') window.ym(C.metrikaId, 'reachGoal', C.page + '_' + goal, params || {}); } catch (e) { /* ignore */ }
  }
  function tierIdx(area) { for (var i = 0; i < S.tiers.length; i++) if (area <= S.tiers[i]) return i; return -1; }
  function tierLabel(i) { return i < 0 ? 'более ' + S.tiers[S.tiers.length - 1] + ' м²' : i === 0 ? 'до ' + S.tiers[0] + ' м²' : (S.tiers[i - 1] + 1) + '–' + S.tiers[i] + ' м²'; }
  function includedQty(tid, xid, i) {
    var m = (S.includes && S.includes[tid]) || {}, v = m[xid];
    if (v == null) return 0;
    if (Object.prototype.toString.call(v) === '[object Array]') return i < 0 ? v[v.length - 1] : v[i];
    return v;
  }
  function perksFor(tid, i) {
    return (S.perks[tid] || []).map(function (p) {
      var w = includedQty(tid, 'windows', i);
      return p.replace('{windows}', w || '');
    });
  }

  /* ---------- расчёт ---------- */
  function compute(tid) {
    var i = tierIdx(state.area), big = i < 0;
    var base = big ? Math.round(state.area * S.perM2) : S.prices[tid][i];
    var lines = [], extras = 0, quote = false, from = big;
    C.extras.forEach(function (x) {
      if (x.group) {   // химчистка: набор позиций со счётчиками, цена по фото
        x.group.forEach(function (g) {
          var gq = state.x[x.id + ':' + g.id] || 0;
          if (!gq) return;
          quote = true;
          lines.push({ x: { title: x.shortTitle + ': ' + g.title.toLowerCase(), quote: true, unit: g.unit || 'шт.' }, qty: gq, inc: 0, paid: gq, cost: 0 });
        });
        return;
      }
      var q = state.x[x.id] || 0;
      if (!q) return;
      var inc = includedQty(tid, x.id, i), paid = Math.max(0, q - inc);
      var cost = x.quote ? 0 : paid * x.price;
      if (x.quote && !inc) quote = true;
      if (paid && x.from) from = true;
      extras += cost;
      lines.push({ x: x, qty: q, inc: Math.min(inc, q), paid: paid, cost: cost });
    });
    var total = base + extras, disc = 0, fo = C.firstOrder;
    if (fo) disc = Math.min(Math.round(total * fo.percent / 100), fo.max);
    return { tid: tid, i: i, big: big, base: base, extras: extras, lines: lines, quote: quote, approx: from || quote, total: total, disc: disc, pay: total - disc };
  }
  function priceText(r, key) { return (r.approx ? 'от ' : '') + money(key === 'total' ? r.total : r.pay); }

  function summaryText(r, source) {
    var t = tariff(state.tariff), L = [];
    if (!state.touched) {
      L.push('Расчёт на странице не выполнялся.');
      L.push('Услуга: ' + S.title + ' (цены от ' + money(S.prices.lite[0]) + ')');
    } else {
      L.push(S.title + ', ' + (r.big ? '' : 'тариф «' + t.title + '», ') + state.area + ' м²');
      L.push('Итого: ' + priceText(r, 'pay') + (r.disc ? ' (с учётом скидки −' + money(r.disc) + ' на первую уборку)' : ''));
      if (r.big) L.push('Индивидуальный расчёт, от ' + S.perM2 + ' ₽ за м²');
      var pk = perksFor(state.tariff, r.i);
      if (pk.length && !r.big) L.push('В тарифе: ' + pk.join(', '));
      if (r.lines.length) {
        L.push('Доп. услуги:');
        r.lines.forEach(function (l) {
          L.push(' • ' + l.x.title + (l.x.toggle ? '' : ', ' + l.qty + ' ' + (l.x.unit || 'шт.')) +
            (l.x.quote ? ' — оценить по фото' : !l.paid ? ' — входит в тариф' : ' — ' + (l.x.from ? 'от ' : '') + money(l.cost)));
        });
      }
    }
    if (source && source.offer) L.push('Интересует акция: ' + source.offer);
    L.push('Кнопка: ' + ((source && source.name) || 'не указана'));
    return L.join('\n');
  }

  /* ---------- рендер ---------- */
  var result = compute(state.tariff);

  function renderTariffs() {
    var html = '';
    C.tariffs.forEach(function (t) {
      var r = compute(t.id), pk = perksFor(t.id, r.i);
      html += '<button type="button" class="tar" data-act="tariff" data-v="' + t.id + '" aria-pressed="' + (t.id === state.tariff) + '">' +
        '<span class="rd"></span><span class="tn">' + esc(t.title) + (t.hot ? '<span class="flag">' + esc(t.hot) + '</span>' : '') + '</span>' +
        '<span class="tp">' + (r.big ? 'от ' : '') + money(r.base) + '</span>' +
        '<span class="tl">' + esc(t.desc) + (pk.length ? ': ' + esc(pk.join(', ')) : '') + '</span></button>';
    });
    refs.tariffs.innerHTML = html;
  }

  function groupCount(x) { var n = 0; x.group.forEach(function (g) { n += state.x[x.id + ':' + g.id] || 0; }); return n; }
  function renderGroup(x) {
    var n = groupCount(x), open = !!state.open[x.id];
    var h = '<div class="x grp' + (n ? ' on' : '') + '"><div class="xt">' + esc(x.title) + '</div><div class="xd">' + esc(x.desc || '') + '</div><div class="xc">' +
      '<button type="button" class="sw" data-act="grp" data-id="' + x.id + '" aria-expanded="' + open + '">' + (open ? 'Свернуть' : n ? 'Выбрано: ' + n : 'Выбрать') + '</button></div>';
    if (open) {
      h += '<div class="xg">';
      x.group.forEach(function (g) {
        var q = state.x[x.id + ':' + g.id] || 0, gid = x.id + ':' + g.id;
        var m2 = g.unit === 'м²';
        h += '<div class="xr"><span>' + esc(g.title) + '</span><span class="xc">' +
          (m2
            ? '<input class="qi" type="text" inputmode="numeric" maxlength="3" data-qi="' + gid + '" value="' + (q || '') + '" placeholder="0" aria-label="' + esc(g.title) + ', м²"><span class="qu">м²</span>'
            : '<button type="button" class="qb" data-act="dec" data-id="' + gid + '" aria-label="Меньше: ' + esc(g.title) + '">−</button><span class="qn">' + q + '</span>' +
              '<button type="button" class="qb" data-act="inc" data-id="' + gid + '" aria-label="Больше: ' + esc(g.title) + '">+</button>') +
          '</span></div>';
      });
      h += '<p class="xnote">Стоимость зависит от материала и загрязнения, поэтому оценим её по фото. Пришлите фото менеджеру: ' +
        '<a href="' + esc(waLink('Здравствуйте! Хочу рассчитать химчистку по фото.')) + '" target="_blank" rel="noopener">WhatsApp</a> или ' +
        '<a href="https://t.me/' + esc(C.tg) + '" target="_blank" rel="noopener">Telegram</a>.</p></div>';
    }
    return h + '</div>';
  }

  function renderExtras() {
    var html = '', i = result.i;
    C.extras.forEach(function (x) {
      if (x.group) { html += renderGroup(x); return; }
      if (x.info) { html += '<div class="x info"><div class="xt">' + esc(x.title) + '</div><div class="xd">' + esc(x.desc || '') + '</div></div>'; return; }  // строка без кнопки: только пояснение
      var q = state.x[x.id] || 0, inc = includedQty(state.tariff, x.id, i), on = q > 0;
      var priceLbl = (x.quote || x.hidePrice) ? '' : (x.from ? 'от\u00a0' : '') + money(x.price) + (x.unitShort ? '\u00a0за\u00a0' + x.unitShort : '');  // у «по фото» цены нет
      var forms = x.unitForms || [x.unit || 'шт.', x.unit || 'шт.', x.unit || 'шт.'];
      var incLbl = inc ? '<i>' + (inc > 99 ? 'входит в тариф' : 'в тариф уже включено ' + inc + '\u00a0' + plural(inc, forms)) + '</i>' : '';
      var parts = [priceLbl, incLbl, x.desc ? esc(x.desc) : ''].filter(Boolean).join(' · ');
      html += '<div class="x' + (on ? ' on' : '') + '"><div class="xt">' + esc(x.title) + '</div>' +
        '<div class="xd">' + parts + '</div><div class="xc">' +
        (x.toggle
          ? '<button type="button" class="sw" data-act="toggle" data-id="' + x.id + '" aria-pressed="' + on + '">' + (on ? 'Добавлено' : 'Добавить') + '</button>'
          : '<button type="button" class="qb" data-act="dec" data-id="' + x.id + '" aria-label="Меньше">−</button><span class="qn">' + q + '</span>' +
            '<button type="button" class="qb" data-act="inc" data-id="' + x.id + '" aria-label="Больше">+</button>') +
        '</div></div>';
    });
    refs.extras.innerHTML = html;
  }

  function waLink(text) { return 'https://wa.me/' + C.wa + '?text=' + encodeURIComponent(text); }

  function renderSum() {
    var r = result, t = tariff(state.tariff), html = '';
    html += '<div class="lbl">' + (state.touched ? 'Ваш расчёт' : 'Ориентировочная стоимость') + '</div>';
    html += '<div class="tot">' + priceText(r, 'pay') + (r.disc ? '<span class="old">' + priceText(r, 'total') + '</span>' : '') + '</div>';
    if (r.disc) html += '<div class="disc">−' + money(r.disc) + ' · скидка ' + C.firstOrder.percent + '% на первую уборку</div>';
    html += '<div class="lines">' +
      '<div><span>' + esc(S.title) + (r.big ? '' : ', «' + esc(t.title) + '»') + '</span><span>' + money(r.base) + '</span></div>' +
      '<div><span>Площадь</span><span>' + state.area + ' м²' + (r.big ? ' (индивид.)' : '') + '</span></div>';
    r.lines.forEach(function (l) {
      html += '<div><span>' + esc(l.x.title) + (l.x.toggle ? '' : ' × ' + l.qty + (l.x.unit === 'м²' ? '\u00a0м²' : '')) + '</span><span>' +
        (l.x.quote ? 'по фото' : !l.paid ? 'в тарифе' : (l.x.from ? 'от ' : '') + money(l.cost)) + '</span></div>';
    });
    html += '</div>';
    html += '<a class="btn btn-p" href="' + esc(C.popupHook) + '" data-lead="calc">Зафиксировать цену</a>';
    html += '<div class="alt-row"><a href="' + esc(waLink(summaryText(r, { name: 'whatsapp' }))) + '" target="_blank" rel="noopener" data-msg="wa">WhatsApp</a>' +
      '<a href="https://t.me/' + esc(C.tg) + '" target="_blank" rel="noopener" data-msg="tg">Telegram</a></div>';
    html += '<div class="note">' + esc(C.note) + '</div>';
    // подсказка про более выгодный тариф
    var best = null, cur = -1;
    C.tariffs.forEach(function (tt, k) { if (tt.id === state.tariff) cur = k; });
    C.tariffs.forEach(function (tt, k) {
      if (k >= cur || r.big) return; // предлагаем только более высокий тариф (в списке он выше), в который входят выбранные услуги
      var rr = compute(tt.id);
      if (rr.pay < r.pay && (!best || rr.pay < best.r.pay)) best = { t: tt, r: rr };
    });
    if (best) html += '<div class="ups">С тарифом «' + esc(best.t.title) + '» выйдет на ' + money(r.pay - best.r.pay) + ' дешевле — доп. услуги уже входят. <button type="button" data-act="tariff" data-v="' + best.t.id + '">Выбрать</button></div>';
    refs.sum.innerHTML = html;
    refs.barLabel.textContent = state.touched ? 'Ваш расчёт' : 'Фиксированная цена';
    refs.barTotal.textContent = state.touched ? priceText(r, 'pay') : 'от ' + money(S.prices.lite[0]);
    refs.barBtn.textContent = state.touched ? 'Заказать' : 'Рассчитать';
    refs.barBtn.setAttribute('href', state.touched ? C.popupHook : '#chl-calc');
    if (state.touched) refs.barBtn.setAttribute('data-lead', 'bar'); else refs.barBtn.removeAttribute('data-lead');
  }

  function renderArea() {
    if (document.activeElement !== refs.areaInput) refs.areaInput.value = state.area;
  }

  function render() {
    result = compute(state.tariff);
    renderArea(); renderTariffs(); renderExtras(); renderSum();
    fillForms();
  }

  function touch() {
    state.touched = true;
    if (!state.started) { state.started = true; track('calc_start'); }
  }
  function set(patch) { for (var k in patch) state[k] = patch[k]; touch(); render(); }
  function setX(id, v) {
    var x = C.extras.filter(function (e) { return e.id === id; })[0];
    if (!x && id.indexOf(':') < 0) return;          // позиции химчистки имеют id вида «dryclean:sofa»
    v = Math.max(0, Math.min(x ? (x.toggle ? 1 : (x.max || 30)) : (/^dryclean:(curtains|carpet)$/.test(id) ? 200 : 30), v));
    state.x[id] = v; touch(); render();
  }

  /* ---------- передача расчёта в форму Тильды ---------- */
  function fillForms(source) {
    var text = summaryText(result, source), f = C.fields || {};
    [].concat(f.summary || []).forEach(function (name) {
      [].forEach.call(document.querySelectorAll('form [name="' + name + '"]'), function (input) { input.value = text; });
    });
    [].concat(f.total || []).forEach(function (name) {
      [].forEach.call(document.querySelectorAll('form [name="' + name + '"]'), function (input) { input.value = state.touched ? priceText(result, 'pay') : ''; });
    });
  }

  function popupExists() { return !!document.querySelector('[data-tooltip-hook="' + C.popupHook + '"]'); }

  function onLead(e, el) {
    var src = { name: el.getAttribute('data-lead'), offer: el.getAttribute('data-offer') || '' };
    fillForms(src);
    track('lead_click', { button: src.name });
    if (popupExists()) return; // попап откроет Тильда
    e.preventDefault();
    var t = document.getElementById('chl-contacts');
    if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.style.outline = '3px solid #5fe39a'; setTimeout(function () { t.style.outline = ''; }, 1800); }
    if (window.console) console.warn('CleanHub: на странице нет попапа ' + C.popupHook + ' — см. README, шаг 3');
  }

  /* ---------- события ---------- */
  root.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]');
    if (a && root.contains(a)) {
      var act = a.getAttribute('data-act'), v = a.getAttribute('data-v'), id = a.getAttribute('data-id');
      if (act === 'tariff') set({ tariff: v });
      else if (act === 'inc') setX(id, (state.x[id] || 0) + 1);
      else if (act === 'dec') setX(id, (state.x[id] || 0) - 1);
      else if (act === 'toggle') setX(id, state.x[id] ? 0 : 1);
      else if (act === 'grp') { state.open[id] = !state.open[id]; render(); }
      return;
    }
    var l = e.target.closest('[data-lead]');
    if (l && root.contains(l)) { onLead(e, l); return; }
    var c = e.target.closest('[data-goal]');
    if (c && root.contains(c)) track(c.getAttribute('data-goal'));
    var s = e.target.closest('a[href^="#chl-"]');
    if (s) {
      var tg = document.getElementById(s.getAttribute('href').slice(1));
      if (tg) { e.preventDefault(); tg.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
  });
  // Кнопки вне корня не бывают, но попап Тильды может открыться по якорю — подстрахуем заполнение формы
  root.addEventListener('change', function (e) {
    var t = e.target.closest ? e.target.closest('[data-qi]') : null;
    if (!t) return;
    setX(t.getAttribute('data-qi'), parseInt(t.value.replace(/\D+/g, ''), 10) || 0);
  });
  refs.areaInput.addEventListener('input', function () {
    var v = refs.areaInput.value.replace(/\D+/g, '');
    if (v !== refs.areaInput.value) refs.areaInput.value = v;
    var n = +v;
    if (n >= 10) { n = Math.min(n, 5000); state.area = n; touch(); result = compute(state.tariff); renderArea(); renderTariffs(); renderExtras(); renderSum(); fillForms(); }
  });
  refs.areaInput.addEventListener('blur', function () { refs.areaInput.value = state.area; });
  refs.areaInput.addEventListener('focus', function () { refs.areaInput.select(); });

  /* ---------- галерея «до/после»: переключатель примеров ---------- */
  [].forEach.call(root.querySelectorAll('.ba-gal'), function (g) {
    g.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ba]'); if (!b) return;
      var i = b.getAttribute('data-ba');
      [].forEach.call(g.querySelectorAll('[data-ba]'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      [].forEach.call(g.querySelectorAll('.ba-slide'), function (x) { x.hidden = x.getAttribute('data-i') !== i; });
      track('ba_tab');
    });
  });

  /* ---------- слайдер «до/после» ---------- */
  [].forEach.call(root.querySelectorAll('.ba'), function (ba) {
    var inp = ba.querySelector('input');
    function upd() { ba.style.setProperty('--x', inp.value + '%'); }
    inp.addEventListener('input', upd); upd();
  });

  /* ---------- мобильная панель ---------- */
  var heroEl = root.querySelector('.hero'), finalEl = root.querySelector('.final'), ticking = false;
  function updateBar() {
    ticking = false;
    var h = heroEl.getBoundingClientRect(), f = finalEl.getBoundingClientRect(), vh = window.innerHeight || 800;
    // показываем после первого экрана и прячем, когда виден финальный блок с формой
    refs.bar.classList.toggle('show', h.bottom < 0 && f.top > vh * 0.75);
  }
  function onScroll() { if (!ticking) { ticking = true; (window.requestAnimationFrame || setTimeout)(updateBar); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  updateBar();

  /* ---------- цели для звонков и мессенджеров ---------- */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('#chl a');
    if (!a) return;
    var h = a.getAttribute('href') || '';
    if (h.indexOf('tel:') === 0) track('call_click');
    else if (h.indexOf('wa.me') > -1) track('wa_click');
    else if (h.indexOf('t.me') > -1) track('tg_click');
  }, true);

  /* ---------- скидка на первую уборку: показать/скрыть тексты ---------- */
  [].forEach.call(root.querySelectorAll('[data-fo]'), function (n) { n.hidden = !C.firstOrder; });
  if (C.firstOrder) [].forEach.call(root.querySelectorAll('[data-fo-pct]'), function (n) { n.textContent = C.firstOrder.percent; });
  [].forEach.call(root.querySelectorAll('[data-fo-max]'), function (n) { if (C.firstOrder) n.textContent = money(C.firstOrder.max); });

  // отправка формы Тильды → цель Метрики (если Тильда отдаёт jQuery-событие)
  try {
    if (window.jQuery) window.jQuery(document).on('tildaform:aftersuccess', function () { track('lead_sent'); });
  } catch (e) { /* ignore */ }

  render();
})();
