// Проверка расчётов калькулятора по таблице цен (tests/fixtures/sheet.json — выгрузка Google-таблицы).
// Запуск: node --test calculator/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('.', import.meta.url);
const html = readFileSync(new URL('../cleanhub-calculator.html', here), 'utf8');
const sheet = JSON.parse(readFileSync(new URL('fixtures/sheet.json', here), 'utf8'));

function loadCalc() {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'в сниппете должен быть ровно один <script>');
  const sandbox = { window: {} };
  vm.runInNewContext(scripts[0], sandbox);
  return sandbox.window.CleanHubCalc;
}

const calc = loadCalc();
const TARIFF = { 'лайт': 'lite', 'стандарт': 'standard', 'премиум': 'premium' };
const SHEETS = { 'ГЕНЕРАЛЬНАЯ': 'general', 'ПОСЛЕ РЕМОНТА': 'renovation', 'ПОДДЕРЖИВАЮЩАЯ': 'support' };

// «до 40м2» → 40, «41-60м2» / «41–60 м²» → 60
const upper = (label) => Number(label.match(/(\d+)\s*(?:м2|м²)/)[1]);

for (const [sheetName, service] of Object.entries(SHEETS)) {
  test(`${sheetName}: цены тарифов совпадают с таблицей на границах площади`, () => {
    const rows = sheet[sheetName].filter((r) => TARIFF[r['категория уборки']]);
    assert.ok(rows.length >= 15);
    rows.forEach((r, i) => {
      const tariff = TARIFF[r['категория уборки']];
      // нижняя граница — следующий метр после предыдущей строки того же тарифа («до 40» после «до 25» = 26–40)
      const prev = rows[i - 1];
      const from = prev && prev['категория уборки'] === r['категория уборки'] ? upper(prev['площадь']) + 1 : 1;
      for (const area of [from, upper(r['площадь'])]) {
        const res = calc.compute({ service, tariff, area });
        assert.equal(res.individual, false, `${sheetName} ${area} м²`);
        assert.equal(res.base, r['цена'], `${sheetName} · ${tariff} · ${area} м²`);
        assert.equal(res.total, r['цена']);
      }
    });
  });

  test(`${sheetName}: свыше 120 м² — индивидуальный расчёт по цене за м²`, () => {
    const row = sheet[sheetName].find((r) => r['категория уборки'] === 'индивидуальный расчет');
    const perM2 = Number(String(row['цена']).match(/\d+/)[0]);
    for (const area of [121, 150, 300]) {
      const res = calc.compute({ service, tariff: 'premium', area });
      assert.equal(res.individual, true);
      assert.equal(res.base, area * perM2);
      assert.equal(res.approx, true, 'итог показывается как «от»');
    }
    assert.equal(calc.compute({ service, area: 120 }).individual, false);
  });
}

for (const [sheetName, freq] of [['Абонемент 4 раза в месяц', 4], ['Абонемент 2 раза в месяц', 2]]) {
  test(`${sheetName}: все строки таблицы`, () => {
    const rows = sheet[sheetName];
    assert.equal(rows.length, 54);
    for (const r of rows) {
      const tariff = TARIFF[r['Тариф'].toLowerCase()];
      const months = Number(r['Срок'].match(/\d+/)[0]);
      const area = upper(r['Площадь']);
      const res = calc.compute({ service: 'support', tariff, area, freq, months });
      const sub = res.subscription;
      const ctx = `${r['Площадь']} · ${r['Тариф']} · ${r['Срок']}`;
      assert.equal(res.base, r['Разовая цена'], ctx);
      assert.equal(sub.freq, r['Уборок в месяц'], ctx);
      assert.equal(sub.perCleaning, r['Цена за уборку'], ctx);
      assert.equal(sub.perMonth, r['Стоимость в месяц'], ctx);
      assert.equal(sub.savingMonth, r['Экономия в месяц'], ctx);
      assert.equal(sub.periodTotal, r['Итого за период'], ctx);
      assert.equal(sub.periodSaving, r['Экономия за период'], ctx);
      assert.equal(res.total, r['Стоимость в месяц'], ctx);
    }
  });
}

test('абонемент доступен только для поддерживающей уборки', () => {
  assert.equal(calc.compute({ service: 'general', freq: 4, months: 6 }).subscription, null);
  assert.ok(calc.compute({ service: 'support', freq: 4, months: 6 }).subscription);
});

test('доп. услуги считаются по прайсу, «от»-цены помечают итог', () => {
  const res = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { windows: 6 } });
  assert.equal(res.extrasTotal, 3000);
  assert.equal(res.total, 8490 + 3000);
  assert.equal(res.approx, false, 'мытьё окон — фиксированная цена');

  const res2 = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { windows: 2, curtains: 3, steam: 1 } });
  assert.equal(res2.extrasTotal, 2 * 500 + 3 * 700 + 1500);
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
    assert.equal(res.extrasTotal, 3 * 500, `${area} м²`);
  }
  const std = calc.compute({ service: 'renovation', tariff: 'standard', area: 50, extras: { wardrobe: 4, windows: 2 } });
  assert.equal(std.extrasTotal, 1000, 'шкафы входят в «Стандарт», окна — нет');
});

test('поддерживающая: 1 час глажки входит в «Стандарт» и «Премиум»', () => {
  assert.equal(calc.compute({ service: 'support', tariff: 'lite', area: 40, extras: { hourly: 2 } }).extrasTotal, 2500);
  assert.equal(calc.compute({ service: 'support', tariff: 'standard', area: 40, extras: { hourly: 2 } }).extrasTotal, 1250);
  assert.equal(calc.compute({ service: 'support', tariff: 'premium', area: 40, extras: { hourly: 1, oven: 1, microwave: 1 } }).extrasTotal, 0);
});

test('подсказка о более выгодном тарифе', () => {
  // Лайт 8 490 + духовка 1 000 + СВЧ 500 + посудомойка 1 000 = 10 990 > Стандарт 10 490
  const res = calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { oven: 1, microwave: 1, dishwasher: 1 } });
  assert.equal(res.upsell.tariff, 'standard');
  assert.equal(res.upsell.saving, 500);
  assert.deepEqual([...res.upsell.covered], ['духовка', 'СВЧ', 'посудомойка']);
  assert.equal(calc.compute({ service: 'general', tariff: 'lite', area: 40, extras: { oven: 1 } }).upsell, null);
  assert.equal(calc.compute({ service: 'general', tariff: 'lite', area: 40 }).upsell, null);
});

test('скидка на первый заказ: 10% от тарифа, только генеральная и после ремонта', () => {
  const g = calc.compute({ service: 'general', tariff: 'standard', area: 60, firstOrder: true, extras: { windows: 4 } });
  assert.equal(g.discount.amount, 1499);
  assert.equal(g.total, 14990 - 1499 + 2000);
  assert.equal(calc.compute({ service: 'support', tariff: 'standard', area: 60, firstOrder: true }).discount, null);
  const big = calc.compute({ service: 'renovation', area: 300, firstOrder: true });
  assert.equal(big.discount.amount, 6000, 'не больше 6 000 ₽');
});

test('некорректный ввод не ломает расчёт', () => {
  const res = calc.compute({ service: 'nope', tariff: 'x', area: 'abc', extras: { windows: -5, oven: 999, unknown: 3 } });
  assert.equal(res.service, 'general');
  assert.equal(res.area, 50);
  assert.equal(res.state.extras.windows, undefined);
  assert.equal(res.state.extras.oven, 5, 'количество ограничено максимумом');
});

test('текст заявки содержит ключевые параметры', () => {
  const res = calc.compute({ service: 'general', tariff: 'standard', area: 55, extras: { windows: 6, oven: 1, upholstery: 1 } });
  const text = calc.summaryLines(res).join('\n');
  assert.match(text, /Генеральная уборка/);
  assert.match(text, /Стандарт \(41–60 м²\)/);
  assert.match(text, /Мытьё окон — 6 створок: 3 000 ₽/);
  assert.match(text, /Чистка духовки — 1 шт\.: в тарифе/);
  assert.match(text, /Химчистка мебели: по фото/);
  assert.match(text, /Итого: 17 990 ₽/);
});

test('абонемент: цена в месяц точная, «от» относится только к доп. услугам', () => {
  const res = calc.compute({ service: 'support', tariff: 'lite', area: 45, freq: 4, months: 12, extras: { curtains: 2 } });
  assert.equal(res.total, 21960);
  assert.equal(res.totalApprox, false);
  assert.equal(calc.totalText(res), '21 960 ₽ в месяц');
  assert.match(calc.summaryLines(res).at(-1), /\+ доп\. услуги от 1 400 ₽$/);
});

test('demo.html собран из актуальной версии калькулятора', () => {
  const demo = readFileSync(new URL('../demo.html', here), 'utf8');
  assert.ok(demo.includes(html), 'запустите: node calculator/tools/build-demo.mjs');
});
