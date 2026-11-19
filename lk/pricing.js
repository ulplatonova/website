/*
 * CleanHub: движок расчёта стоимости.
 * Скопирован из калькулятора на cleanhub24.ru (блок «cleanhub-calc») без изменения логики.
 * Единый источник цен для кабинета (браузер) и для сервера (Node): при изменении прайса правьте только этот файл,
 * затем запустите `node lk/sync-pricing.js`, чтобы обновить встроенную копию в lk/cleanhub-lk.html.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CleanHubPricing = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    defaults: { service: 'general', area: 50, tariff: 'premium', freq: 0, months: 6 },
    areaMax: 5000,
    firstOrder: null
  };

  var TARIFFS = [
    { id: 'lite', title: 'Лайт' },
    { id: 'standard', title: 'Стандарт' },
    { id: 'premium', title: 'Премиум' }
  ];

  var SERVICES = {
    general: {
      title: 'Генеральная',
      full: 'Генеральная уборка',
      hint: 'Глубокая уборка всех помещений и труднодоступных мест: от потолка до пола. В среднем 4–6 часов.',
      tiers: [40, 60, 80, 100, 120],
      prices: {
        lite:     [8990, 13990, 18490, 23490, 27990],
        standard: [10990, 15990, 20490, 25490, 29990],
        premium:  [12990, 17990, 22490, 27490, 31990]
      },
      perM2: 265,
      perks: {
        lite: [],
        standard: ['СВЧ', 'духовка', 'посудомойка'],
        premium: ['СВЧ', 'духовка', 'посудомойка', 'вытяжка', 'холодильник', 'стиральная машина']
      },
      includes: {
        standard: { microwave: 1, oven: 1, dishwasher: 1 },
        premium: { microwave: 1, oven: 1, dishwasher: 1, fridge: 1, washer: 1 }
      }
    },
    support: {
      title: 'Поддерживающая',
      full: 'Поддерживающая уборка',
      hint: 'Регулярная уборка, чтобы дома всегда было чисто. От 2 часов.',
      tiers: [25, 40, 60, 80, 100, 120],
      prices: {
        lite:     [4990, 5490, 6990, 9490, 11490, 13490],
        standard: [5990, 6490, 7990, 10490, 12490, 14490],
        premium:  [7990, 8490, 9990, 12490, 14490, 16490]
      },
      perM2: 120,
      perks: {
        lite: [],
        standard: ['1 час глажки'],
        premium: ['1 час глажки', 'СВЧ', 'духовка', 'смена постельного белья']
      },
      includes: {
        standard: { hourly: 1 },
        premium: { hourly: 1, microwave: 1, oven: 1 }
      }
    },
    renovation: {
      title: 'После ремонта',
      full: 'Уборка после ремонта',
      hint: 'Удалим строительную пыль и следы ремонта со всех поверхностей, отмоем сантехнику, полы и плинтусы.',
      tiers: [40, 60, 80, 100, 120],
      prices: {
        lite:     [11990, 16490, 20990, 25490, 29990],
        standard: [14490, 18990, 23490, 27990, 32490],
        premium:  [16990, 21490, 25990, 30490, 34990]
      },
      perM2: 300,
      perks: {
        lite: [],
        standard: ['мойка всех шкафов внутри (пустых)'],
        premium: ['мойка всех шкафов внутри (пустых)', 'окна до {windows} створок']
      },
      includes: {
        standard: { wardrobe: Infinity },
        premium: { wardrobe: Infinity, windows: [4, 6, 8, 10, 12] }
      }
    }
  };

  /* Абонемент на поддерживающую уборку: скидка с каждой уборки по сроку, ₽.
     Сейчас абонементы не продаём (enabled: false) — в калькуляторе их нет.
     Чтобы вернуть: enabled: true и проверить скидки ниже. */
  var SUBSCRIPTION = {
    enabled: true,
    service: 'support',
    frequencies: [2, 4],
    discounts: { 3: 500, 6: 700, 12: 1000 }
  };

  /* ================================================================
     ДОПОЛНИТЕЛЬНЫЕ УСЛУГИ (из презентации «Дополнительные услуги»)
     price: null — стоимость по фото; from: true — цена «от»;
     toggle: true — услуга без количества.
     ================================================================ */
  var EXTRA_GROUPS = [
    { id: 'kitchen', title: 'Кухня и техника' },
    { id: 'windows', title: 'Окна и текстиль' },
    { id: 'home', title: 'Дом и особые задачи' }
  ];

  var UNITS = {
    pcs: { short: 'шт.', forms: ['шт.', 'шт.', 'шт.'] },
    sash: { short: 'створка', forms: ['створка', 'створки', 'створок'] },
    hour: { short: 'час', forms: ['час', 'часа', 'часов'] },
    m2: { short: 'м²', forms: ['м²', 'м²', 'м²'] }
  };

  var EXTRAS = [
    { id: 'oven', group: 'kitchen', title: 'Чистка духовки', short: 'духовка', desc: 'Внутри и снаружи', price: 1000, from: true, unit: 'pcs', max: 5 },
    { id: 'microwave', group: 'kitchen', title: 'Мойка СВЧ', short: 'СВЧ', desc: 'Внутри и снаружи', price: 500, from: true, unit: 'pcs', max: 5 },
    { id: 'dishwasher', group: 'kitchen', title: 'Посудомоечная машина', short: 'посудомойка', desc: 'Чистка внутри и снаружи', price: 1000, from: true, unit: 'pcs', max: 5 },
    { id: 'washer', group: 'kitchen', title: 'Стиральная машина', short: 'стиральная машина', desc: 'Уплотнитель, лоток, барабан', price: 1000, from: true, unit: 'pcs', max: 5 },
    { id: 'fridge', group: 'kitchen', title: 'Мойка холодильника', short: 'холодильник', desc: 'Полки, ящики, дверцы. Разморозка — до нашего приезда', price: 1500, from: true, unit: 'pcs', max: 5 },
    { id: 'wardrobe', group: 'kitchen', title: 'Шкафы пустые', short: 'пустые шкафы', desc: 'Мытьё внутри и снаружи: кухонные, купе, гардеробная', price: 2000, from: true, unit: 'pcs', max: 20 },
    { id: 'wardrobeFull', group: 'kitchen', title: 'Шкафы заполненные', short: 'заполненные шкафы', desc: 'Шкафы с вещами: мытьё внутри и снаружи', price: 4000, from: true, unit: 'pcs', max: 20 },

    // priceBy / titleBy / descBy — другое значение для вида уборки (ключ — id из SERVICES)
    { id: 'windows', group: 'windows', title: 'Мытьё окон', short: 'окна', desc: 'Створки изнутри и снаружи, рамы, подоконники', price: 550, from: false, unit: 'sash', max: 60,
      priceBy: { renovation: 750 },
      titleBy: { renovation: 'Мытьё окон после ремонта' },
      descBy: { renovation: 'Строительная пыль, краска, клей, плёнка' } },
    { id: 'blinds', group: 'windows', title: 'Мытьё жалюзи', short: 'жалюзи', desc: 'Вертикальные и горизонтальные', price: 300, from: true, unit: 'pcs', max: 30 },
    { id: 'screens', group: 'windows', title: 'Мытьё москитных сеток', short: 'москитные сетки', desc: 'Снимем, вымоем, установим обратно', price: 300, from: true, unit: 'pcs', max: 30 },
    { id: 'curtains', group: 'windows', title: 'Шторы и тюль', short: 'шторы', desc: 'Снятие, стирка, навеска, химчистка', price: 700, from: true, unit: 'pcs', max: 30 },

    { id: 'bathroom', group: 'home', title: 'Дополнительный санузел', short: 'доп. санузел', desc: 'Если санузлов больше одного: ванная, туалет, раковина или отдельный туалет', price: 1500, from: false, unit: 'pcs', max: 5,
      priceBy: { support: 1000, renovation: 2000 } },
    { id: 'hourly', group: 'home', title: 'Почасовая задача', short: 'час глажки', desc: 'Глажка, посуда, разбор вещей', price: 1250, from: true, unit: 'hour', max: 10 },
    { id: 'chandelier', group: 'home', title: 'Сложные люстры', short: 'люстры', desc: 'Плафоны, подвески, хрусталь', price: 1000, from: true, unit: 'pcs', max: 10 },
    { id: 'balcony', group: 'home', title: 'Уборка балкона', short: 'балкон', desc: 'Пыль с поверхностей, мытьё пола', price: 1000, from: true, unit: 'pcs', max: 5,
      priceBy: { renovation: 2000 },
      titleBy: { renovation: 'Уборка балкона после ремонта' },
      descBy: { renovation: 'Строительная пыль с поверхностей, мытьё пола' } },
    { id: 'grout', group: 'home', title: 'Чистка межплиточных швов', short: 'швы', desc: 'Стандартные швы плитки', price: 500, from: true, unit: 'm2', max: 100 },
    { id: 'steam', group: 'home', title: 'Пароочиститель', short: 'пароочиститель', desc: 'До 99% бактерий и грибков. Цена — за доставку и использование', price: 1500, from: false, toggle: true },
    { id: 'upholstery', group: 'home', title: 'Химчистка мебели', short: 'химчистка', desc: 'Диваны, кресла, матрасы, ковры; запахи, кровь, моча, сложные пятна. Расчёт по фото', price: null, toggle: true }
  ];

  /* ================================================================
     РАСЧЁТ
     ================================================================ */
  var TARIFF_IDS = TARIFFS.map(function (t) { return t.id; });
  var EXTRA_BY_ID = {};
  EXTRAS.forEach(function (x) { EXTRA_BY_ID[x.id] = x; });

  function plural(n, forms) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function money(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  }

  function tariffTitle(id) {
    for (var i = 0; i < TARIFFS.length; i++) if (TARIFFS[i].id === id) return TARIFFS[i].title;
    return id;
  }

  function tierIndexFor(svc, area) {
    for (var i = 0; i < svc.tiers.length; i++) if (area <= svc.tiers[i]) return i;
    return -1;
  }

  function tierLabelFor(svc, i) {
    if (i < 0) return 'больше ' + svc.tiers[svc.tiers.length - 1] + ' м²';
    if (i === 0) return 'до ' + svc.tiers[0] + ' м²';
    return (svc.tiers[i - 1] + 1) + '–' + svc.tiers[i] + ' м²';
  }

  function includedFor(svc, tariff, i) {
    var map = (svc.includes && svc.includes[tariff]) || {}, out = {};
    Object.keys(map).forEach(function (id) {
      out[id] = Array.isArray(map[id]) ? map[id][i] : map[id];
    });
    return out;
  }

  function perksFor(svc, tariff, included) {
    return (svc.perks[tariff] || []).map(function (p) {
      return p.replace('{windows}', included.windows);
    });
  }

  function pick(map, svcId, fallback) {
    return map && map[svcId] != null ? map[svcId] : fallback;
  }
  function priceOf(x, svcId) { return pick(x.priceBy, svcId, x.price); }
  function titleOf(x, svcId) { return pick(x.titleBy, svcId, x.title); }
  function descOf(x, svcId) { return pick(x.descBy, svcId, x.desc); }

  function clampQty(x, v) {
    var max = x.toggle ? 1 : (x.max || 99);
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(n, max);
  }

  function normalize(state) {
    state = state || {};
    var d = CONFIG.defaults, s = {};
    s.service = SERVICES[state.service] ? state.service : d.service;
    var area = Math.round(Number(state.area));
    s.area = isFinite(area) && area >= 1 ? Math.min(area, CONFIG.areaMax) : d.area;
    s.tariff = TARIFF_IDS.indexOf(state.tariff) >= 0 ? state.tariff : d.tariff;
    var freq = Number(state.freq);
    s.freq = SUBSCRIPTION.enabled && s.service === SUBSCRIPTION.service && SUBSCRIPTION.frequencies.indexOf(freq) >= 0 ? freq : 0;
    s.months = SUBSCRIPTION.discounts[state.months] != null ? Number(state.months) : d.months;
    s.extras = {};
    var src = state.extras || {};
    EXTRAS.forEach(function (x) {
      var q = clampQty(x, src[x.id]);
      if (q) s.extras[x.id] = q;
    });
    s.firstOrder = !!state.firstOrder;
    return s;
  }

  function firstOrderApplies(s) {
    var fo = CONFIG.firstOrder;
    return !!(fo && fo.percent && fo.services.indexOf(s.service) >= 0 && !s.freq);
  }

  /* Разовая стоимость при выбранном тарифе */
  function quote(s, tariff) {
    var svc = SERVICES[s.service];
    var i = tierIndexFor(svc, s.area);
    var individual = i < 0;
    var base = individual ? s.area * svc.perM2 : svc.prices[tariff][i];
    var included = individual ? {} : includedFor(svc, tariff, i);
    var lines = [], extrasTotal = 0, approx = individual, hasQuote = false;

    EXTRAS.forEach(function (x) {
      var qty = s.extras[x.id] || 0;
      if (!qty) return;
      var inc = Math.min(qty, included[x.id] || 0);
      var paid = qty - inc;
      var price = priceOf(x, s.service);
      var cost = price == null ? 0 : paid * price;
      if (price == null) hasQuote = true;
      if (x.from && paid > 0) approx = true;
      extrasTotal += cost;
      lines.push({ id: x.id, title: titleOf(x, s.service), qty: qty, included: inc, paid: paid, cost: cost, from: !!x.from && paid > 0, quote: price == null, toggle: !!x.toggle, unit: x.unit });
    });

    var discount = 0;
    if (s.firstOrder && firstOrderApplies(s)) {
      discount = Math.round(base * CONFIG.firstOrder.percent / 100);
      if (CONFIG.firstOrder.max) discount = Math.min(discount, CONFIG.firstOrder.max);
    }

    return {
      svc: svc, tierIndex: i, individual: individual, base: base, included: included,
      lines: lines, extrasTotal: extrasTotal, approx: approx, hasQuote: hasQuote,
      discount: discount, oneTime: base - discount + extrasTotal
    };
  }

  function compute(state) {
    var s = normalize(state);
    var q = quote(s, s.tariff);
    var svc = q.svc;
    var r = {
      state: s,
      service: s.service,
      serviceTitle: svc.full,
      area: s.area,
      tierIndex: q.tierIndex,
      tierLabel: tierLabelFor(svc, q.tierIndex),
      individual: q.individual,
      tariff: q.individual ? null : s.tariff,
      tariffTitle: q.individual ? 'Индивидуальный расчёт' : tariffTitle(s.tariff),
      perM2: svc.perM2,
      base: q.base,
      included: q.included,
      perks: q.individual ? [] : perksFor(svc, s.tariff, q.included),
      lines: q.lines,
      extrasTotal: q.extrasTotal,
      hasQuote: q.hasQuote,
      approx: q.approx,
      discount: q.discount ? { percent: CONFIG.firstOrder.percent, amount: q.discount } : null,
      firstOrderAvailable: firstOrderApplies(s),
      subscription: null,
      upsell: null,
      tariffPrices: {}
    };

    TARIFFS.forEach(function (t) {
      r.tariffPrices[t.id] = q.individual ? null : svc.prices[t.id][q.tierIndex];
    });

    if (s.freq) {
      var sub = { freq: s.freq, months: s.months, individual: q.individual };
      if (!q.individual) {
        var d = SUBSCRIPTION.discounts[s.months];
        sub.discountPerCleaning = d;
        sub.perCleaning = q.base - d;
        sub.perMonth = sub.perCleaning * s.freq;
        sub.savingMonth = d * s.freq;
        sub.periodTotal = sub.perMonth * s.months;
        sub.periodSaving = sub.savingMonth * s.months;
      }
      r.subscription = sub;
    }

    // Итог: за разовую уборку или за месяц абонемента (доп. услуги — отдельно, к уборке)
    r.total = r.subscription && !r.subscription.individual ? r.subscription.perMonth : q.oneTime;
    // «от» у итога: цена за м² или «от»-цены доп. услуг (в абонементе доп. услуги показаны отдельно)
    r.totalApprox = r.subscription && !r.subscription.individual ? false : q.approx;

    // Подсказка: более высокий тариф выходит не дороже, потому что включает выбранные услуги
    if (!q.individual) {
      var cur = TARIFF_IDS.indexOf(s.tariff), best = null;
      for (var k = cur + 1; k < TARIFF_IDS.length; k++) {
        var alt = quote(s, TARIFF_IDS[k]);
        if (alt.oneTime <= q.oneTime && (!best || alt.oneTime <= best.q.oneTime)) best = { id: TARIFF_IDS[k], q: alt };
      }
      if (best) {
        var covered = [];
        q.lines.forEach(function (l) {
          if ((best.q.included[l.id] || 0) > (q.included[l.id] || 0)) covered.push(EXTRA_BY_ID[l.id].short);
        });
        r.upsell = { tariff: best.id, title: tariffTitle(best.id), saving: q.oneTime - best.q.oneTime, covered: covered };
      }
    }
    return r;
  }

  function unitLabel(unit, n) {
    var u = UNITS[unit] || UNITS.pcs;
    return n + ' ' + plural(n, u.forms);
  }


  return {
    compute: compute,
    config: CONFIG,
    services: SERVICES,
    tariffs: TARIFFS,
    subscription: SUBSCRIPTION,
    extras: EXTRAS,
    extraGroups: EXTRA_GROUPS,
    units: UNITS,
    plural: plural,
    money: money,
    unitLabel: unitLabel,
    normalize: normalize
  };
}));
