// Проверка расчётов калькулятора по таблице цен (tests/fixtures/sheet.json — выгрузка Google-таблицы).
// Запуск: node --test calculator/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('.', import.meta.url);
const html = readFileSync(new URL('../cleanhub-calculator.html', here), 'utf8');
const prices = JSON.parse(readFileSync(new URL('fixtures/prices.json', here), 'utf8'));

function loadCalc() {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'в сниппете должен быть ровно один <script>');
  const sandbox = { window: {} };
  vm.runInNewContext(scripts[0], sandbox);
  return sandbox.window.CleanHubCalc;
}

const calc = loadCalc();
const TARIFFS = ['lite', 'standard', 'premium'];

for (const service of ['general', 'support', 'renovation']) {
  const p = prices[service];
  test(`${service}: цены тарифов совпадают с баннерами на границах площади`, () => {
    for (const tariff of TARIFFS) {
      p.tiers.forEach((upper, i) => {
        const from = i ? p.tiers[i - 1] + 1 : 1;
        for (const area of [from, upper]) {
          const res = calc.compute({ service, tariff, area });
          assert.equal(res.individual, false, `${service} ${area} м²`);
          assert.equal(res.base, p[tariff][i], `${service} · ${tariff} · ${area} м²`);
          assert.equal(res.total, p[tariff][i]);
        }
      });
    }
  });

  test(`${service}: свыше ${p.tiers.at(-1)} м² — индивидуальный расчёт по цене за м²`, () => {
    for (const area of [p.tiers.at(-1) + 1, 150, 300]) {
      const res = calc.compute({ service, tariff: 'premium', area });
      assert.equal(res.individual, true);
      assert.equal(res.base, area * p.perM2);
      assert.equal(res.approx, true, 'итог показывается как «от»');
    }
    assert.equal(calc.compute({ service, area: p.tiers.at(-1) }).individual, false);
  });
}

test('абонементы выключены: калькулятор их не считает', () => {
  assert.equal(calc.subscription.enabled, false);
  const res = calc.compute({ service: 'support', tariff: 'lite', area: 30, freq: 4, months: 12 });
  assert.equal(res.subscription, null);
  assert.equal(res.state.freq, 0);
  assert.equal(res.total, 5490);
  assert.ok(!/абонемент/i.test(calc.summaryLines(res).join('\n')));
});

test('доп. услуги считаются по прайсу, «от»-цены помечают итог', () => {
  const res = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { windows: 6 } });
  assert.equal(res.extrasTotal, 3300);
  assert.equal(res.total, 8990 + 3300);
  assert.equal(res.approx, false, 'мытьё окон — фиксированная цена');

  const res2 = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { windows: 2, curtains: 3, steam: 1 } });
  assert.equal(res2.extrasTotal, 2 * 550 + 3 * 700 + 1500);
  assert.equal(res2.approx, true);
});

test('услуги, входящие в тариф, не оплачиваются повторно', () => {
  const std = calc.compute({ service: 'general', tariff: 'standard', area: 40, extras: { oven: 1, microwave: 1, dishwasher: 1, fridge: 1 } });
  assert.equal(std.extrasTotal, 1500, 'в «Стандарт» входят СВЧ, духовка, посудомойка — платим только холодильник');
  const prem = calc.compute({ service: 'general', tariff: 'premium', area: 40, extras: { oven: 1, fridge: 1, washer: 1 } });
  assert.equal(prem.extrasTotal, 0);
  const twoOvens = calc.compute({ service: 'general', tariff: 'standard', area: 40, extras: { oven: 2 } });
  assert.equal(twoOvens.extrasTotal, 1000, 'вторая духовка оплачивается');
});

test('после ремонта «Премиум»: окна включены по числу створок для площади', () => {
  const expected = { 40: 4, 60: 6, 80: 8, 100: 10, 120: 12 };
  for (const [area, sashes] of Object.entries(expected)) {
    const res = calc.compute({ service: 'renovation', tariff: 'premium', area: Number(area), extras: { windows: sashes + 3 } });
    assert.equal(res.included.windows, sashes);
    assert.equal(res.extrasTotal, 3 * 750, `${area} м², окна после ремонта 750 ₽`);
  }
  const std = calc.compute({ service: 'renovation', tariff: 'standard', area: 50, extras: { wardrobe: 4, windows: 2 } });
  assert.equal(std.extrasTotal, 1500, 'шкафы входят в «Стандарт», окна — нет');
});

test('поддерживающая: 1 час глажки входит в «Стандарт» и «Премиум»', () => {
  assert.equal(calc.compute({ service: 'support', tariff: 'lite', area: 40, extras: { hourly: 2 } }).extrasTotal, 2500);
  assert.equal(calc.compute({ service: 'support', tariff: 'standard', area: 40, extras: { hourly: 2 } }).extrasTotal, 1250);
  assert.equal(calc.compute({ service: 'support', tariff: 'premium', area: 40, extras: { hourly: 1, oven: 1, microwave: 1 } }).extrasTotal, 0);
});

test('подсказка о более выгодном тарифе', () => {
  // Лайт 8 990 + духовка 1 000 + СВЧ 500 + посудомойка 1 000 = 11 490 > Стандарт 10 990
  const res = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { oven: 1, microwave: 1, dishwasher: 1 } });
  assert.equal(res.upsell.tariff, 'standard');
  assert.equal(res.upsell.saving, 500);
  assert.deepEqual([...res.upsell.covered], ['духовка', 'СВЧ', 'посудомойка']);
  assert.equal(calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { oven: 1 } }).upsell, null);
  assert.equal(calc.compute({ service: 'general', tariff: 'lite', area: 40 }).upsell, null);
});

// Скидка на первый заказ сейчас выключена (CONFIG.firstOrder = null). Механизм оставлен —
// проверяем его, временно включив настройку.
function withFirstOrder(fn) {
  const saved = calc.config.firstOrder;
  calc.config.firstOrder = { percent: 10, max: 6000, services: ['general', 'renovation'] };
  try { fn(); } finally { calc.config.firstOrder = saved; }
}

test('скидка на первый заказ выключена', () => {
  assert.equal(calc.config.firstOrder, null);
  const res = calc.compute({ service: 'general', tariff: 'standard', area: 60, firstOrder: true });
  assert.equal(res.discount, null);
  assert.equal(res.firstOrderAvailable, false);
  assert.equal(res.total, 15990);
});

test('если включить скидку: 10% от тарифа, только генеральная и после ремонта', () => withFirstOrder(() => {
  const g = calc.compute({ service: 'general', tariff: 'standard', area: 60, firstOrder: true, extras: { windows: 4 } });
  assert.equal(g.discount.amount, 1599);
  assert.equal(g.total, 15990 - 1599 + 2200);
  assert.equal(calc.compute({ service: 'support', tariff: 'standard', area: 60, firstOrder: true }).discount, null);
  const big = calc.compute({ service: 'renovation', area: 300, firstOrder: true });
  assert.equal(big.discount.amount, 6000, 'не больше 6 000 ₽');
}));

test('по умолчанию выбран тариф «Премиум»', () => {
  assert.equal(calc.compute({}).tariff, 'premium');
});

test('некорректный ввод не ломает расчёт', () => {
  const res = calc.compute({ service: 'nope', tariff: 'x', area: 'abc', extras: { windows: -5, oven: 999, unknown: 3 } });
  assert.equal(res.service, 'general');
  assert.equal(res.area, 50);
  assert.equal(res.state.extras.windows, undefined);
  assert.equal(res.state.extras.oven, 5, 'количество ограничено максимумом');
});

test('текст заявки: сначала главное, затем по строке на пункт, всё по-русски', () => {
  const res = calc.compute({ service: 'general', tariff: 'standard', area: 55, extras: { windows: 6, oven: 1, upholstery: 1 } });
  const lines = [...calc.summaryLines(res)];
  assert.equal(lines[0], 'Генеральная уборка, тариф «Стандарт», 55 м²');
  assert.equal(lines[1], 'Итого: 19\u00a0290\u00a0₽');
  assert.ok(lines.includes('Тариф «Стандарт» (41–60 м²): 15\u00a0990\u00a0₽'));
  assert.ok(lines.includes('Входит: СВЧ, духовка, посудомойка'));
  assert.ok(lines.includes('• Мытьё окон, 6\u00a0створок — 3\u00a0300\u00a0₽'));
  assert.ok(lines.includes('• Чистка духовки, 1\u00a0шт. — входит в тариф'));
  assert.ok(lines.includes('• Химчистка мебели — оценить по фото'));
  const text = lines.join('\n');
  assert.doesNotMatch(text, /[A-Za-z]/, 'в тексте заявки нет латиницы');
  assert.doesNotMatch(text, /;$/m, 'строки без точек с запятой в конце');
});

test('заявка из примера менеджеров: итог совпадает, каждая услуга — отдельной строкой', () => {
  const res = calc.compute({
    service: 'general', tariff: 'premium', area: 35, firstOrder: true,
    extras: { wardrobe: 1, windows: 4, curtains: 2, balcony: 1, grout: 1, steam: 1, upholstery: 1 }
  });
  assert.equal(res.total, 12990 + 2000 + 2200 + 1400 + 1000 + 500 + 1500, 'без скидки на первый заказ');
  const lines = [...calc.summaryLines(res)];
  assert.equal(lines[1], 'Итого: от 21\u00a0590\u00a0₽');
  assert.equal(lines.filter((l) => l.startsWith('• ')).length, 7);
  assert.ok(!lines.some((l) => /Скидка/.test(l)));
  withFirstOrder(() => {
    const withDiscount = [...calc.summaryLines(calc.compute({ service: 'general', tariff: 'premium', area: 35, firstOrder: true }))];
    assert.equal(withDiscount.at(-1), 'Скидка на первый заказ 10%: −1\u00a0299\u00a0₽');
  });
});

test('demo.html собран из актуальной версии калькулятора', () => {
  const demo = readFileSync(new URL('../demo.html', here), 'utf8');
  assert.ok(demo.includes(html), 'запустите: node calculator/tools/build-demo.mjs');
});

test('шкафы: пустые от 2 000 ₽, заполненные от 4 000 ₽', () => {
  const res = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { wardrobe: 1, wardrobeFull: 2 } });
  assert.equal(res.extrasTotal, 2000 + 2 * 4000);
  assert.equal(res.approx, true, 'обе цены «от»');
  const lines = [...calc.summaryLines(res)];
  assert.ok(lines.includes('• Шкафы пустые, 1 шт. — от 2 000 ₽'));
  assert.ok(lines.includes('• Шкафы заполненные, 2 шт. — от 8 000 ₽'));
  // после ремонта в «Стандарт» и «Премиум» входят только пустые шкафы
  const reno = calc.compute({ service: 'renovation', tariff: 'standard', area: 50, extras: { wardrobe: 3, wardrobeFull: 1 } });
  assert.equal(reno.extrasTotal, 4000);
});

test('по умолчанию заполняется только поле «Расчёт»', () => {
  assert.deepEqual(Object.keys(calc.config.fields), ['summary']);
  assert.deepEqual([...calc.config.fields.summary], ['Расчёт', 'Расчет', 'calc']);
});

test('окна и балкон после ремонта дороже: 750 ₽ за створку, от 2 000 ₽ за балкон', () => {
  const reno = calc.compute({ service: 'renovation', tariff: 'lite', area: 40, extras: { windows: 2, balcony: 1 } });
  assert.equal(reno.extrasTotal, 2 * 750 + 2000);
  const lines = [...calc.summaryLines(reno)];
  assert.ok(lines.includes('• Мытьё окон после ремонта, 2\u00a0створки — 1\u00a0500\u00a0₽'));
  assert.ok(lines.includes('• Уборка балкона после ремонта, 1\u00a0шт. — от 2\u00a0000\u00a0₽'));
  const gen = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { windows: 2, balcony: 1 } });
  assert.equal(gen.extrasTotal, 2 * 550 + 1000);
});

test('дополнительный санузел: 1 000 ₽ в поддержке, 1 500 ₽ в генеральной, 2 000 ₽ после ремонта', () => {
  for (const [service, price] of [['support', 1000], ['general', 1500], ['renovation', 2000]]) {
    const res = calc.compute({ service, tariff: 'lite', area: 40, extras: { bathroom: 2 } });
    assert.equal(res.extrasTotal, 2 * price, service);
    assert.equal(res.approx, false, 'цена фиксированная');
  }
});

test('жалюзи и москитные сетки — две отдельные услуги по 300 ₽', () => {
  const res = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { blinds: 2, screens: 3 } });
  assert.equal(res.extrasTotal, 5 * 300);
  const lines = [...calc.summaryLines(res)];
  assert.ok(lines.includes('• Мытьё жалюзи, 2\u00a0шт. — от 600\u00a0₽'));
  assert.ok(lines.includes('• Мытьё москитных сеток, 3\u00a0шт. — от 900\u00a0₽'));
});
