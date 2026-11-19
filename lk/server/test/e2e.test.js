'use strict';
/* Сквозные тесты: сервер поднимается на случайном порту против эмуляторов Битрикс24 и Telegram.
   SMS-провайдер memory, база SQLite в памяти. */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { loadConfig } = require('../config');
const { createBitrix } = require('../bitrix');
const { createMockBitrix } = require('./mock-bitrix');
const { createMockTelegram } = require('./mock-telegram');
const { moscowDate, addDays, addMonths, weekdayOf } = require('../util');

const EVENT_TOKEN = 'evt-token-test';
const ADMIN = 'admin-key-test';
const TG_SECRET = 'tg-secret-test';
let mb, tg, app, base, offset = 0, ipN = 0, phoneN = 0;

const nextIp = () => `10.1.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const newPhone = () => '+7916' + String(10000000 + ++phoneN).slice(1);
const today = () => moscowDate(app.ctx.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(20); } return false; }

async function api(method, path, { body, token, ip, headers = {}, raw } = {}) {
  const h = { 'X-Forwarded-For': ip || nextIp(), ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

/* Вход/регистрация по SMS. Возвращает токен, id контакта и ответ /me */
async function login(phone, profile = null) {
  const ip = nextIp();
  let r = await api('POST', '/auth/code', { body: { phone, purpose: profile ? 'register' : 'login' }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = app.ctx.sms.lastCode(phone);
  assert.match(code, /^\d{4}$/);
  r = await api('POST', '/auth/verify', { body: { phone, code, profile }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = await api('GET', '/me', { token: r.body.token, ip });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  return { token: r.body.token, id: me.body.user.id, me: me.body, referralApplied: r.body.referralApplied, phone };
}

async function bitrixEvent(dealId, { token = EVENT_TOKEN, event = 'ONCRMDEALUPDATE' } = {}) {
  const body = new URLSearchParams({ event, 'data[FIELDS][ID]': String(dealId), 'auth[application_token]': token }).toString();
  return fetch(base + '/bitrix/events', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
}
async function tgUpdate(chatId, text, { secret = TG_SECRET, username = 'tg_user' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  const res = await fetch(base + '/telegram/webhook', { method: 'POST', headers, body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: chatId, username }, chat: { id: chatId, type: 'private' }, text } }) });
  return res.status;
}
const balanceOf = (id) => app.ctx.loyalty.balance(id);
const ledgerCount = (like) => app.ctx.db.get('SELECT COUNT(*) AS c FROM ledger WHERE ref_key LIKE ?', like).c;
const giveBonus = (token, id, amount) => {
  const code = 'GIFT' + Math.random().toString(36).slice(2, 8).toUpperCase();
  app.ctx.db.run('INSERT INTO promo_codes(code, bonus) VALUES (?, ?)', code, amount);
  return api('POST', '/loyalty/promo', { token, body: { code } });
};
const STATE = { service: 'general', area: 53, tariff: 'standard', extras: { windows: 4, oven: 2 } }; // 15990 + окна 2200 + духовка 1 из 2 платная 1000 = 19190
const ORDER = (over = {}) => ({ state: STATE, address: 'Москва, Тверская 1, кв. 5', date: addDays(today(), 3), slot: '11:00–13:00', comment: 'Домофон 15', bonusSpend: 0, ...over });

before(async () => {
  mb = await createMockBitrix().start();
  tg = await createMockTelegram().start();
  const config = loadConfig({
    NODE_ENV: 'test', PORT: '0', PUBLIC_URL: 'http://localhost', ALLOWED_ORIGINS: 'https://cleanhub24.ru', DB_PATH: ':memory:', TRUST_PROXY: '1',
    BITRIX_WEBHOOK_URL: mb.url, BITRIX_EVENT_TOKEN: EVENT_TOKEN, BITRIX_CATEGORY_ID: '2', BITRIX_RETRY_BASE_MS: '5',
    SMS_PROVIDER: 'memory', ADMIN_KEY: ADMIN, MATERIALIZE_INTERVAL_MIN: '0',
    TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN', TELEGRAM_BOT_USERNAME: 'cleanhub_test_bot', TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TELEGRAM_API_BASE: tg.url
  });
  app = createApp(config);
  app.ctx.now = () => Date.now() + offset;
  const port = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); await mb.stop(); await tg.stop(); });

describe('Конфигурация и служебное', () => {
  it('без BITRIX_WEBHOOK_URL сервер не стартует с понятным сообщением (кроме NODE_ENV=test)', () => {
    assert.throws(() => loadConfig({}), /BITRIX_WEBHOOK_URL/);
    assert.doesNotThrow(() => loadConfig({ NODE_ENV: 'test' }));
    assert.throws(() => loadConfig({ BITRIX_WEBHOOK_URL: 'https://x.bitrix24.ru/rest/1/t/', SMS_PROVIDER: 'smsru' }), /SMSRU_API_ID/);
  });
  it('GET /health', async () => {
    const r = await api('GET', '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
  it('CORS: preflight для разрешённого origin, чужой origin без заголовков', async () => {
    const ok = await fetch(base + '/orders', { method: 'OPTIONS', headers: { Origin: 'https://cleanhub24.ru', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://cleanhub24.ru');
    assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(ok.headers.get('access-control-allow-headers'), /Content-Type/);
    const evil = await fetch(base + '/orders', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(evil.status, 204);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const real = await fetch(base + '/health', { headers: { Origin: 'https://cleanhub24.ru' } });
    assert.equal(real.headers.get('access-control-allow-origin'), 'https://cleanhub24.ru');
  });
  it('без токена и с чужим токеном: 401 с сообщением по-русски', async () => {
    for (const path of ['/me', '/orders', '/subscriptions']) {
      const r = await api('GET', path);
      assert.equal(r.status, 401);
      assert.match(r.body.message, /вход/i);
    }
    assert.equal((await api('GET', '/me', { token: 'a'.repeat(64) })).status, 401);
    assert.equal((await api('GET', '/me', { headers: { Authorization: 'Bearer short' } })).status, 401);
  });
  it('неизвестный путь 404, неверный JSON 400, тело больше 100 КБ 413', async () => {
    assert.equal((await api('GET', '/nope')).status, 404);
    const bad = await api('POST', '/auth/code', { body: '{oops', raw: true, headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.message);
    const big = await api('POST', '/auth/code', { body: JSON.stringify({ phone: 'x'.repeat(150 * 1024) }), raw: true, headers: { 'Content-Type': 'application/json' } });
    assert.equal(big.status, 413);
  });
  it('util: addMonths обрезает по концу месяца', () => {
    assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonths('2026-12-02', 6), '2027-06-02');
    assert.equal(weekdayOf('2026-12-02'), 3);
  });
});

describe('Bitrix-клиент', () => {
  it('повторяет запрос при 503 QUERY_LIMIT_EXCEEDED', async () => {
    const bx = createBitrix(app.ctx.config);
    const before = mb.calls('crm.contact.list').length;
    mb.failNext(2, 503, 'QUERY_LIMIT_EXCEEDED');
    const res = await bx.call('crm.contact.list', { filter: { ID: '999999' } });
    assert.deepEqual(res, []);
    assert.equal(mb.calls('crm.contact.list').length - before, 3);
  });
  it('поиск по телефону пробует форматы +7 / 7 / 8', async () => {
    const id = mb.addContact({ name: 'Старый', phone: '89160009999' });
    const bx = createBitrix(app.ctx.config);
    const c = await bx.findContactByPhone('+79160009999');
    assert.equal(c.ID, id);
    const call = mb.calls('crm.duplicate.findbycomm').at(-1).params;
    assert.deepEqual(call.values, ['+79160009999', '79160009999', '89160009999']);
    assert.equal(await bx.findContactByPhone('+79160008888'), null);
  });
  it('batch режет команды на пачки по 50, getProductRowsBatch возвращает все ключи', async () => {
    const bx = createBitrix(app.ctx.config);
    const ids = Array.from({ length: 120 }, (_, i) => String(900000 + i));
    const before = mb.calls('batch').length;
    const rows = await bx.getProductRowsBatch(ids);
    assert.equal(Object.keys(rows).length, 120);
    assert.equal(mb.calls('batch').length - before, 3);
    assert.equal((await bx.getContact('424242')), null);
  });
  it('скрипт bitrix-setup: dry-run ничего не создаёт, повторный запуск идемпотентен', async () => {
    const { run } = require('../scripts/bitrix-setup');
    const m2 = await createMockBitrix({ userfields: false }).start();
    try {
      const cfg = loadConfig({ NODE_ENV: 'test', BITRIX_WEBHOOK_URL: m2.url });
      const bx = createBitrix(cfg);
      const logs = [];
      const dry = await run({ config: cfg, bitrix: bx, dryRun: true, log: (m) => logs.push(m) });
      assert.equal(dry.created.length, 10);
      assert.equal(m2.calls('crm.deal.userfield.add').length + m2.calls('crm.contact.userfield.add').length, 0);
      const first = await run({ config: cfg, bitrix: bx, log: () => {} });
      assert.equal(first.created.length, 10);
      assert.equal(m2.calls('crm.deal.userfield.add')[0].params.fields.FIELD_NAME, 'CH_SERVICE');
      assert.equal(m2.calls('crm.contact.userfield.add').length, 1);
      assert.ok(m2.state.userfields.deal.some((f) => f.FIELD_NAME === 'UF_CRM_CH_SERVICE'));
      const again = await run({ config: cfg, bitrix: bx, log: () => {} });
      assert.equal(again.created.length, 0);
      assert.equal(again.existing.length, 10);
    } finally { await m2.stop(); }
  });
});

describe('Вход и регистрация по SMS', () => {
  it('валидация телефона и цели', async () => {
    assert.equal((await api('POST', '/auth/code', { body: { phone: '123', purpose: 'login' } })).status, 400);
    assert.equal((await api('POST', '/auth/code', { body: { phone: '+79160000000', purpose: 'hack' } })).status, 400);
    assert.equal((await api('POST', '/auth/code', { body: { phone: ['+79160000000'], purpose: 'login' } })).status, 400);
    assert.equal((await api('POST', '/auth/code', { body: 'str', raw: false })).status, 400);
  });
  it('нет перебора клиентов: одинаковый ответ для известного и неизвестного номера', async () => {
    const known = newPhone();
    mb.addContact({ name: 'Известный', phone: known });
    const a = await api('POST', '/auth/code', { body: { phone: known, purpose: 'login' } });
    const b = await api('POST', '/auth/code', { body: { phone: newPhone(), purpose: 'login' } });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
    assert.deepEqual(a.body, { ok: true });
    // и при проверке кода ответ на неверный код одинаков для любых номеров
    const w1 = await api('POST', '/auth/verify', { body: { phone: known, code: '0000', profile: null } });
    const w2 = await api('POST', '/auth/verify', { body: { phone: newPhone(), code: '0000', profile: null } });
    assert.equal(w1.status, 400);
    assert.deepEqual(w1.body, w2.body);
  });
  it('регистрация: создаётся контакт в Битриксе, код одноразовый, в БД только хэши', async () => {
    const phone = newPhone();
    const before = mb.state.contacts.size;
    const ip = nextIp();
    await api('POST', '/auth/code', { body: { phone, purpose: 'register' }, ip });
    const code = app.ctx.sms.lastCode(phone);
    const row = app.ctx.db.get('SELECT * FROM sms_codes WHERE phone = ?', phone);
    assert.ok(row.code_hash && !JSON.stringify(row).includes(`"${code}"`));
    const v = await api('POST', '/auth/verify', { body: { phone, code, profile: { name: 'Анна Иванова', email: 'anna@example.com' } }, ip });
    assert.equal(v.status, 200);
    assert.match(v.body.token, /^[0-9a-f]{64}$/);
    assert.equal(v.body.referralApplied, false);
    assert.equal(mb.state.contacts.size, before + 1);
    const c = [...mb.state.contacts.values()].at(-1);
    assert.equal(c.NAME, 'Анна');
    assert.equal(c.LAST_NAME, 'Иванова');
    assert.equal(c.PHONE[0].VALUE, phone);
    assert.equal(c.EMAIL[0].VALUE, 'anna@example.com');
    assert.match(c.UF_CRM_CH_REFCODE, /^CH-[A-HJ-NP-Z2-9]{5}$/);
    assert.equal(app.ctx.db.get('SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?', v.body.token).c, 0); // токен хранится хэшем
    // повтор кода невозможен
    const again = await api('POST', '/auth/verify', { body: { phone, code, profile: null }, ip });
    assert.equal(again.status, 400);
    // профиль
    const me = await api('GET', '/me', { token: v.body.token });
    assert.equal(me.body.user.name, 'Анна Иванова');
    assert.equal(me.body.user.phone, `+7 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}`);
    assert.equal(me.body.user.email, 'anna@example.com');
    assert.equal(me.body.loyalty.clientNo, 'CH-' + me.body.user.id.padStart(6, '0'));
    assert.deepEqual(me.body.loyalty.levels.map((l) => [l.name, l.from, l.pct]), [['Гость', 0, 3], ['Постоянный клиент', 15000, 5], ['Премиум-клиент', 40000, 7]]);
    assert.equal(me.body.loyalty.maxPay, 30);
    assert.equal(me.body.referral.ownerBonus, 500);
  });
  it('повторный вход не создаёт второй контакт; контакт с телефоном «8…» находится', async () => {
    const phone = newPhone();
    const first = await login(phone, { name: 'Пётр', email: '' });
    const n = mb.state.contacts.size;
    offset += 61000;
    const second = await login(phone);
    assert.equal(mb.state.contacts.size, n);
    assert.equal(second.id, first.id);
    const id = mb.addContact({ name: 'Из CRM', phone: '89165550000' });
    const viaCrm = await login('+79165550000');
    assert.equal(viaCrm.id, id);
    assert.equal(viaCrm.me.user.name, 'Из CRM');
    offset = 0;
  });
  it('неверный код: 5 попыток, затем даже верный код не работает', async () => {
    const phone = newPhone();
    const ip = nextIp();
    await api('POST', '/auth/code', { body: { phone, purpose: 'login' }, ip });
    const good = app.ctx.sms.lastCode(phone);
    const wrong = good === '1111' ? '2222' : '1111';
    for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/auth/verify', { body: { phone, code: wrong, profile: null }, ip })).status, 400);
    const r = await api('POST', '/auth/verify', { body: { phone, code: good, profile: null }, ip });
    assert.equal(r.status, 400);
  });
  it('код живёт 5 минут', async () => {
    const phone = newPhone();
    const ip = nextIp();
    await api('POST', '/auth/code', { body: { phone, purpose: 'login' }, ip });
    const code = app.ctx.sms.lastCode(phone);
    offset += 5 * 60 * 1000 + 1000;
    const r = await api('POST', '/auth/verify', { body: { phone, code, profile: null }, ip });
    offset = 0;
    assert.equal(r.status, 400);
  });
  it('лимиты: 1 код в 60 с, 5 в час на номер', async () => {
    const phone = newPhone();
    assert.equal((await api('POST', '/auth/code', { body: { phone, purpose: 'login' } })).status, 200);
    const fast = await api('POST', '/auth/code', { body: { phone, purpose: 'login' } });
    assert.equal(fast.status, 429);
    assert.ok(fast.body.message);
    for (let i = 0; i < 4; i++) { offset += 61000; assert.equal((await api('POST', '/auth/code', { body: { phone, purpose: 'login' } })).status, 200); }
    offset += 61000;
    assert.equal((await api('POST', '/auth/code', { body: { phone, purpose: 'login' } })).status, 429);
    offset = 0;
  });
  it('лимит 20 кодов в час с одного IP', async () => {
    const ip = '172.16.5.5';
    for (let i = 0; i < 20; i++) assert.equal((await api('POST', '/auth/code', { body: { phone: newPhone(), purpose: 'login' }, ip })).status, 200);
    assert.equal((await api('POST', '/auth/code', { body: { phone: newPhone(), purpose: 'login' }, ip })).status, 429);
  });
  it('профиль проверяется: плохой email — 400', async () => {
    const phone = newPhone();
    const ip = nextIp();
    await api('POST', '/auth/code', { body: { phone, purpose: 'register' }, ip });
    const r = await api('POST', '/auth/verify', { body: { phone, code: app.ctx.sms.lastCode(phone), profile: { name: 'Аня', email: 'не-почта' } }, ip });
    assert.equal(r.status, 400);
  });
});

describe('Профиль, адреса, промокоды', () => {
  it('PATCH /me обновляет контакт в Битриксе и локальные данные', async () => {
    const u = await login(newPhone(), { name: 'Олег Смирнов', email: '' });
    const r = await api('PATCH', '/me', { token: u.token, body: { name: 'Олег Петров', email: 'oleg@example.com', birthday: '1990-05-17', addresses: [{ label: 'Дом', text: 'Москва, Арбат 1' }], notify: { tgOrders: true, tgPromo: true } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.name, 'Олег Петров');
    assert.equal(r.body.user.email, 'oleg@example.com');
    assert.equal(r.body.user.birthday, '1990-05-17');
    assert.equal(r.body.user.addresses[0].text, 'Москва, Арбат 1');
    assert.ok(r.body.user.addresses[0].id);
    assert.equal(r.body.user.notify.tgPromo, true);
    const c = mb.state.contacts.get(u.id);
    assert.equal(c.LAST_NAME, 'Петров');
    assert.equal(c.EMAIL[0].VALUE, 'oleg@example.com');
    assert.match(c.BIRTHDATE, /^1990-05-17/);
    assert.equal((await api('PATCH', '/me', { token: u.token, body: { email: 'bad' } })).status, 400);
    assert.equal((await api('PATCH', '/me', { token: u.token, body: { birthday: '2999-01-01' } })).status, 400);
    assert.equal((await api('PATCH', '/me', { token: u.token, body: { notify: { tgOrders: 'yes' } } })).status, 400);
    const fresh = await api('GET', '/me', { token: u.token });
    assert.equal(fresh.body.user.name, 'Олег Петров');
  });
  it('промокод: разовый бонус, повтор запрещён, неизвестный и свой реферальный код — 400', async () => {
    const u = await login(newPhone(), { name: 'Промо Тест', email: '' });
    app.ctx.db.run("INSERT INTO promo_codes(code, bonus, max_uses) VALUES ('SPRING300', 300, 1)");
    assert.equal((await api('POST', '/loyalty/promo', { token: u.token, body: { code: 'nope' } })).status, 400);
    assert.equal((await api('POST', '/loyalty/promo', { token: u.token, body: { code: u.me.referral.code } })).status, 400);
    const ok = await api('POST', '/loyalty/promo', { token: u.token, body: { code: ' spring300 ' } });
    assert.deepEqual(ok.body, { ok: true });
    assert.equal(balanceOf(u.id), 300);
    assert.equal((await api('POST', '/loyalty/promo', { token: u.token, body: { code: 'SPRING300' } })).status, 400);
    const other = await login(newPhone(), { name: 'Другой', email: '' });
    assert.equal((await api('POST', '/loyalty/promo', { token: other.token, body: { code: 'SPRING300' } })).status, 400); // max_uses=1
    const me = await api('GET', '/me', { token: u.token });
    assert.deepEqual(me.body.loyalty.history.map((h) => h.delta), [300]);
  });
});

describe('Рефералы', () => {
  it('A приглашает B: по 500 бонусов обоим ровно один раз, даже при повторе события', async () => {
    const A = await login(newPhone(), { name: 'Алиса Королёва', email: '' });
    assert.match(A.me.referral.code, /^CH-[A-HJ-NP-Z2-9]{5}$/);
    assert.equal(A.me.referral.link, 'https://cleanhub24.ru/?ref=' + A.me.referral.code);
    const B = await login(newPhone(), { name: 'Борис Кузнецов', email: '', refCode: A.me.referral.code });
    assert.equal(B.referralApplied, true);
    const unknown = await login(newPhone(), { name: 'Вера', email: '', refCode: 'CH-AAAAA' });
    assert.equal(unknown.referralApplied, false);

    let meA = (await api('GET', '/me', { token: A.token })).body;
    assert.deepEqual(meA.referral.invited.map((i) => [i.name, i.status, i.reward]), [['Борис К.', 'registered', 0]]);
    assert.ok(!JSON.stringify(meA.referral).includes('+7916'));

    // B оформляет заказ
    const o = await api('POST', '/orders', { token: B.token, body: ORDER({ state: { service: 'general', area: 53, tariff: 'standard', extras: {} } }) });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    meA = (await api('GET', '/me', { token: A.token })).body;
    assert.equal(meA.referral.invited[0].status, 'ordered');
    assert.equal(balanceOf(A.id), 0);

    // менеджер закрывает сделку успешно, Битрикс шлёт событие (дважды и параллельно)
    mb.setStage(o.body.order.dealId, 'C2:WON');
    const results = await Promise.all([bitrixEvent(o.body.order.dealId), bitrixEvent(o.body.order.dealId), bitrixEvent(o.body.order.dealId)]);
    assert.ok(results.every((r) => r.status === 200));
    await bitrixEvent(o.body.order.dealId);
    assert.equal(balanceOf(A.id), 500);
    assert.equal(balanceOf(B.id), 500 + 480); // бонус другу + кешбэк 3% от 15990
    // и сверка при GET /me не начисляет повторно
    await api('GET', '/me', { token: B.token });
    await api('GET', '/orders', { token: B.token });
    assert.equal(balanceOf(A.id), 500);
    assert.equal(balanceOf(B.id), 980);
    assert.equal(ledgerCount(`ref:${B.id}:%`), 2);

    meA = (await api('GET', '/me', { token: A.token })).body;
    assert.equal(meA.referral.invited[0].status, 'rewarded');
    assert.deepEqual(meA.referral.totals, { invited: 1, rewarded: 1, earned: 500 });
    assert.equal(meA.loyalty.balance, 500);
    assert.equal(meA.loyalty.history[0].title, 'Бонус за друга');
    const meB = (await api('GET', '/me', { token: B.token })).body;
    assert.equal(meB.loyalty.spent, 15990);
    assert.ok(meB.loyalty.history.some((h) => h.title === 'Бонус за первый заказ по рекомендации' && h.delta === 500));
    assert.ok(meB.loyalty.history.some((h) => h.title === `Начисление за заказ CH-${o.body.order.dealId}` && h.delta === 480));
  });
  it('код друга через /loyalty/promo: только один раз и до первого выполненного заказа', async () => {
    const A = await login(newPhone(), { name: 'Анна', email: '' });
    const X = await login(newPhone(), { name: 'Иксов Игорь', email: '' });
    const r = await api('POST', '/loyalty/promo', { token: X.token, body: { code: A.me.referral.code } });
    assert.deepEqual(r.body, { ok: true });
    assert.equal((await api('POST', '/loyalty/promo', { token: X.token, body: { code: A.me.referral.code } })).status, 400);
    const meA = (await api('GET', '/me', { token: A.token })).body;
    assert.equal(meA.referral.invited[0].name, 'Иксов И.');
    // клиент с выполненным заказом применить код уже не может
    const Y = await login(newPhone(), { name: 'Игрек', email: '' });
    mb.addDeal({ CONTACT_ID: Y.id, STAGE_ID: 'C2:WON', OPPORTUNITY: 1000, TITLE: 'старый' });
    assert.equal((await api('POST', '/loyalty/promo', { token: Y.token, body: { code: A.me.referral.code } })).status, 400);
  });
  it('событие Битрикса с неверным или отсутствующим токеном — 403', async () => {
    assert.equal((await bitrixEvent(1, { token: 'wrong' })).status, 403);
    assert.equal((await bitrixEvent(1, { token: '' })).status, 403);
    const noAuth = await fetch(base + '/bitrix/events', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'event=ONCRMDEALUPDATE&data[FIELDS][ID]=1' });
    assert.equal(noAuth.status, 403);
    assert.equal((await bitrixEvent(999999)).status, 200); // неизвестная сделка — тихо 200
  });
});

describe('GET /orders: сделки в заказы', () => {
  it('статусы по семантике и суффиксу стадии, позиции, прогноз бонусов', async () => {
    const u = await login(newPhone(), { name: 'Мария Орлова', email: '' });
    const mk = (stage, opp, extra = {}, rows) => mb.addDeal({ CONTACT_ID: u.id, STAGE_ID: stage, OPPORTUNITY: opp, TITLE: 'Сделка ' + stage, ...extra }, rows);
    const dWon = mk('C2:WON', 10000, { UF_CRM_CH_SERVICE: 'general', UF_CRM_CH_TARIFF: 'standard', UF_CRM_CH_AREA: 53, UF_CRM_CH_ADDRESS: 'Москва, Ленина 1', UF_CRM_CH_SLOT: '09:00–11:00', UF_CRM_CH_VISIT_DATE: '2026-10-01' },
      [{ PRODUCT_NAME: 'Генеральная уборка, 53 м²', PRICE: 8000, QUANTITY: 1 }, { PRODUCT_NAME: 'Мытьё окон', PRICE: 500, QUANTITY: 4 }]);
    const dNew = mk('C2:NEW', 15990, { UF_CRM_CH_SERVICE: 'general', UF_CRM_CH_TARIFF: 'standard', UF_CRM_CH_AREA: 53, UF_CRM_CH_EXTRAS: JSON.stringify({ windows: 4 }) });
    const dWork = mk('C2:EXECUTING', 5000);
    const dPrep = mk('C2:PREPARATION', 5000);
    const dLose = mk('C2:LOSE', 7000);
    const dBare = mk('EXECUTING', 3000);
    const dOther = mk('C2:PREPAYMENT_INVOICE', 3000);
    const dOtherPipe = mk('C7:WON', 2000);
    mk('C2:NEW', 1, {}); // сделка другого клиента не должна попасть в список
    mb.state.deals.get(String(Number(dOtherPipe) + 1)).CONTACT_ID = '1';

    const r = await api('GET', '/orders', { token: u.token });
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.orders.map((o) => [o.dealId, o]));
    assert.equal(r.body.orders.length, 8);
    assert.deepEqual(r.body.orders.map((o) => o.dealId), [...r.body.orders.map((o) => o.dealId)].sort((a, b) => b - a)); // новые сверху
    assert.equal(byId[dWon].status, 'done');
    assert.equal(byId[dNew].status, 'new');
    assert.equal(byId[dWork].status, 'work');
    assert.equal(byId[dPrep].status, 'work');
    assert.equal(byId[dLose].status, 'cancel');
    assert.equal(byId[dBare].status, 'work');       // стадия без префикса воронки
    assert.equal(byId[dOther].status, 'new');
    assert.equal(byId[dOtherPipe].status, 'done');   // C7:WON, воронка не важна
    const w = byId[dWon];
    assert.equal(w.id, 'CH-' + dWon);
    assert.equal(w.title, 'Генеральная уборка');
    assert.equal(w.tariff, 'Стандарт');
    assert.equal(w.area, 53);
    assert.equal(w.svc, 'general');
    assert.equal(w.total, 10000);
    assert.equal(w.address, 'Москва, Ленина 1');
    assert.equal(w.slot, '09:00–11:00');
    assert.equal(w.date, '2026-10-01');
    assert.deepEqual(w.items, [{ name: 'Генеральная уборка, 53 м²', qty: 1, price: 8000 }, { name: 'Мытьё окон', qty: 4, price: 500 }]);
    assert.equal(w.sub, null);
    // бонусы: выполненные — из реестра (3% от 10000 и 2000), проигранные — 0, остальные — прогноз
    assert.equal(w.bonusEarned, 300);
    assert.equal(byId[dLose].bonusEarned, 0);
    const spent = 10000 + 2000;
    assert.equal(byId[dWork].bonusEarned, Math.round(5000 * 3 / 100));
    assert.equal(spent < 15000, true);
    // позиции восстановлены из UF-полей, если товарных строк нет
    assert.deepEqual(byId[dNew].items, [{ name: 'Генеральная уборка, 53 м²', qty: 1, price: 15990 }, { name: 'Мытьё окон', qty: 4, price: 550 }]);
    assert.deepEqual(byId[dNew].extras, { windows: 4 });
    // все позиции читаются одним batch
    assert.ok(mb.calls('batch').length >= 1);
  });
  it('уровни лояльности считаются по сумме выполненных сделок (кешбэк по уровню до сделки)', async () => {
    const u = await login(newPhone(), { name: 'Лев Уровнев', email: '' });
    for (const amount of [10000, 6000, 20000, 10000, 10000]) mb.addDeal({ CONTACT_ID: u.id, STAGE_ID: 'C2:WON', OPPORTUNITY: amount, TITLE: 'выполнено' });
    await api('GET', '/orders', { token: u.token });
    // 3% от 10000, 3% от 6000 (до неё 10000), 5% от 20000 (до неё 16000), 5% от 10000 (36000), 7% от 10000 (46000)
    assert.equal(balanceOf(u.id), 300 + 180 + 1000 + 500 + 700);
    const me = (await api('GET', '/me', { token: u.token })).body;
    assert.equal(me.loyalty.spent, 56000);
    assert.equal(me.loyalty.balance, 2680);
    assert.equal(me.loyalty.history.length, 5);
    const dates = me.loyalty.history.map((h) => Date.parse(h.date));
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
    // новая сделка клиента 7%-го уровня: прогноз 7%
    const d = mb.addDeal({ CONTACT_ID: u.id, STAGE_ID: 'C2:NEW', OPPORTUNITY: 10000, TITLE: 'новая' });
    const orders = (await api('GET', '/orders', { token: u.token })).body.orders;
    assert.equal(orders.find((o) => o.dealId === Number(d)).bonusEarned, 700);
  });
});

describe('POST /orders', () => {
  let user;
  before(async () => { user = await login(newPhone(), { name: 'Заказчик Первый', email: '' }); });

  it('валидация входных данных', async () => {
    const t = user.token;
    const bad = async (over) => { const r = await api('POST', '/orders', { token: t, body: ORDER(over) }); assert.equal(r.status, 400, JSON.stringify(over)); assert.ok(r.body.message); };
    await bad({ address: '' });
    await bad({ address: '   ' });
    await bad({ date: addDays(today(), -1) });
    await bad({ date: '2026-02-30' });
    await bad({ date: 'завтра' });
    await bad({ slot: '03:00–04:00' });
    await bad({ state: { ...STATE, service: 'nope' } });
    await bad({ state: { ...STATE, tariff: 'gold' } });
    await bad({ state: { ...STATE, area: 'много' } });
    await bad({ state: { ...STATE, area: 0 } });
    await bad({ state: { ...STATE, extras: { hacked: 1 } } });
    await bad({ state: { ...STATE, extras: { windows: -1 } } });
    await bad({ state: { ...STATE, extras: { windows: 1000 } } });
    await bad({ state: { ...STATE, extras: { windows: 1.5 } } });
    await bad({ bonusSpend: -5 });
    await bad({ bonusSpend: 1.5 });
    await bad({ bonusSpend: '100' });
    await bad({ comment: 123 });
    assert.equal((await api('POST', '/orders', { token: t, body: null, raw: false })).status, 400);
  });

  it('сервер сам считает цену, игнорируя числа клиента; сделка и позиции заполнены', async () => {
    const before = mb.calls('crm.deal.add').length;
    const body = ORDER({ total: 1, price: 1, amount: 1, state: { ...STATE, total: 1, base: 1, perM2: 1 } });
    const r = await api('POST', '/orders', { token: user.token, body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = r.body.order;
    assert.equal(mb.calls('crm.deal.add').length, before + 1);
    assert.equal(o.total, 19190);
    assert.equal(o.status, 'new');
    assert.equal(o.id, 'CH-' + o.dealId);
    assert.equal(o.bonusSpent, 0);
    assert.equal(o.slot, '11:00–13:00');
    assert.equal(o.date, body.date);
    assert.equal(o.svc, 'general');
    assert.deepEqual(o.items, [{ name: 'Генеральная уборка, 53 м²', qty: 1, price: 15990 }, { name: 'Чистка духовки', qty: 1, price: 1000 }, { name: 'Мытьё окон', qty: 4, price: 550 }]);
    assert.equal(o.bonusEarned, Math.round(19190 * 0.03));
    const d = mb.deal(o.dealId);
    assert.equal(d.TITLE, 'Заказ из кабинета: Генеральная уборка, 53 м²');
    assert.equal(d.CONTACT_ID, user.id);
    assert.equal(d.CATEGORY_ID, '2');
    assert.equal(d.STAGE_ID, 'C2:NEW');
    assert.equal(d.SOURCE_ID, 'WEB');
    assert.equal(d.OPPORTUNITY, '19190.00');
    assert.equal(d.UF_CRM_CH_SERVICE, 'general');
    assert.equal(d.UF_CRM_CH_TARIFF, 'standard');
    assert.equal(d.UF_CRM_CH_AREA, '53');
    assert.equal(d.UF_CRM_CH_ADDRESS, body.address);
    assert.equal(d.UF_CRM_CH_SLOT, '11:00–13:00');
    assert.equal(d.UF_CRM_CH_VISIT_DATE, body.date);
    assert.equal(d.UF_CRM_CH_BONUS_SPENT, '0');
    assert.deepEqual(JSON.parse(d.UF_CRM_CH_EXTRAS), { windows: 4, oven: 2 });
    assert.match(d.COMMENTS, /К оплате: 19\s190\s₽/);
    assert.match(d.COMMENTS, /Комментарий клиента: Домофон 15/);
    assert.match(d.COMMENTS, /Мытьё окон × 4/);
    const rows = mb.rows(o.dealId);
    assert.deepEqual(rows.map((x) => [x.PRODUCT_NAME, Number(x.PRICE), Number(x.QUANTITY)]), [['Генеральная уборка, 53 м²', 15990, 1], ['Чистка духовки', 1000, 1], ['Мытьё окон', 550, 4]]);
    assert.equal(d.OPPORTUNITY, '19190.00'); // товарные позиции не перезаписали сумму
    // и этот заказ виден в списке
    const list = (await api('GET', '/orders', { token: user.token })).body.orders;
    assert.equal(list.find((x) => x.dealId === o.dealId).total, 19190);
  });

  it('бонусы: не больше 30% суммы и не больше баланса; списание сразу в реестре', async () => {
    assert.equal((await giveBonus(user.token, user.id, 2000)).status, 200);
    assert.equal(balanceOf(user.id), 2000);
    const tooMuch = await api('POST', '/orders', { token: user.token, body: ORDER({ bonusSpend: 5758 }) }); // 30% от 19190 = 5757
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.message, /30%/);
    const noMoney = await api('POST', '/orders', { token: user.token, body: ORDER({ bonusSpend: 2001 }) });
    assert.equal(noMoney.status, 400);
    assert.match(noMoney.body.message, /Недостаточно бонусов/);
    assert.equal(balanceOf(user.id), 2000);
    const ok = await api('POST', '/orders', { token: user.token, body: ORDER({ bonusSpend: 1500 }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const o = ok.body.order;
    assert.equal(o.bonusSpent, 1500);
    assert.equal(o.total, 17690);
    const d = mb.deal(o.dealId);
    assert.equal(d.OPPORTUNITY, '17690.00');
    assert.equal(d.UF_CRM_CH_BONUS_SPENT, '1500');
    assert.match(d.COMMENTS, /Бонусами: 1\s500\s₽/);
    assert.match(d.COMMENTS, /К оплате: 17\s690\s₽/);
    assert.equal(balanceOf(user.id), 500);
    const entry = app.ctx.db.get('SELECT * FROM ledger WHERE ref_key = ?', `deal:${o.dealId}:spend`);
    assert.equal(entry.delta, -1500);
    assert.equal(entry.title, `Списание в заказе CH-${o.dealId}`);
    user.spendDeal = o.dealId;
  });

  it('параллельные заказы не могут потратить один баланс дважды', async () => {
    const u = await login(newPhone(), { name: 'Гонка Данных', email: '' });
    await giveBonus(u.token, u.id, 2000);
    const rs = await Promise.all([1, 2].map(() => api('POST', '/orders', { token: u.token, body: ORDER({ bonusSpend: 1500 }) })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);
    assert.equal(balanceOf(u.id), 500);
  });

  it('проигранная сделка возвращает списанные бонусы ровно один раз', async () => {
    assert.ok(user.spendDeal);
    const before = balanceOf(user.id);
    mb.setStage(user.spendDeal, 'C2:LOSE');
    await bitrixEvent(user.spendDeal);
    await bitrixEvent(user.spendDeal);
    assert.equal(balanceOf(user.id), before + 1500);
    await api('GET', '/orders', { token: user.token });
    await api('GET', '/me', { token: user.token });
    assert.equal(balanceOf(user.id), before + 1500);
    assert.equal(ledgerCount(`deal:${user.spendDeal}:refund`), 1);
    const me = (await api('GET', '/me', { token: user.token })).body;
    assert.ok(me.loyalty.history.some((h) => h.delta === 1500 && /Возврат/.test(h.title)));
    const o = (await api('GET', '/orders', { token: user.token })).body.orders.find((x) => x.dealId === Number(user.spendDeal));
    assert.equal(o.status, 'cancel');
    assert.equal(o.bonusEarned, 0);
  });

  it('индивидуальный расчёт и допуслуги «по фото» отражаются в комментарии', async () => {
    const r = await api('POST', '/orders', { token: user.token, body: ORDER({ state: { service: 'general', area: 200, tariff: 'premium', extras: { upholstery: 1 } } }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = mb.deal(r.body.order.dealId);
    assert.match(d.COMMENTS, /ИНДИВИДУАЛЬНЫЙ РАСЧЁТ, менеджеру уточнить цену/);
    assert.match(d.COMMENTS, /Оценить по фото: Химчистка мебели/);
    assert.equal(d.OPPORTUNITY, String(200 * 265) + '.00');
  });

  it('если Битрикс недоступен — 502, а резерв бонусов снимается', async () => {
    const u = await login(newPhone(), { name: 'Сбой Битрикса', email: '' });
    await giveBonus(u.token, u.id, 1000);
    mb.failNext(10, 500, 'INTERNAL_SERVER_ERROR');
    const r = await api('POST', '/orders', { token: u.token, body: ORDER({ bonusSpend: 500 }) });
    mb.failNext(0);
    assert.equal(r.status, 502);
    assert.ok(r.body.message);
    assert.equal(balanceOf(u.id), 1000);
  });
});

describe('Подписки', () => {
  let u, s1, s2, start, weekday, first;
  const SUBST = { service: 'support', area: 53, tariff: 'standard', freq: 2, months: 6 };
  const body = (over = {}) => ({ state: SUBST, weekday, slot: '11:00–13:00', startDate: start, address: 'Москва, Садовая 7', comment: 'ключ у консьержа', ...over });
  const visitsFor = (subId) => [...mb.state.deals.values()].filter((d) => d.UF_CRM_CH_SUB_ID === subId);

  before(async () => {
    u = await login(newPhone(), { name: 'Подписчик Первый', email: '' });
    start = addDays(today(), 1);
    first = addDays(start, 2);
    weekday = weekdayOf(first);
  });

  it('создание: платежи выключены -> active, цены из pricing, даты визитов по правилу дня недели', async () => {
    const r = await api('POST', '/subscriptions', { token: u.token, body: body() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s1 = r.body.subscription;
    assert.equal(r.body.paymentUrl, null);
    assert.match(s1.id, /^s_[0-9a-f]{8}$/);
    assert.equal(s1.status, 'active');
    assert.equal(s1.base, 7990);
    assert.equal(s1.discountPerCleaning, 700);
    assert.equal(s1.perCleaning, 7290);
    assert.equal(s1.perMonth, 14580);
    assert.equal(s1.periodTotal, 87480);
    assert.equal(s1.startDate, start);
    assert.equal(s1.endDate, addMonths(start, 6));
    assert.equal(s1.weekday, weekday);
    assert.deepEqual(s1.nextVisits, [first, addDays(first, 14), addDays(first, 28), addDays(first, 42)]); // freq=2: раз в 2 недели
    assert.ok(s1.nextVisits.every((d) => weekdayOf(d) === weekday));
    assert.equal(s1.paymentUrl, null);
    const list = await api('GET', '/subscriptions', { token: u.token });
    assert.equal(list.body.subscriptions.length, 1);
  });

  it('freq=4: визиты каждые 7 дней, первый — первая подходящая дата не раньше startDate', async () => {
    const wd = weekdayOf(start); // совпадает с днём старта: первый визит в сам startDate
    const r = await api('POST', '/subscriptions', { token: u.token, body: body({ weekday: wd, state: { ...SUBST, freq: 4, months: 3 } }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s2 = r.body.subscription;
    assert.equal(s2.discountPerCleaning, 500);
    assert.equal(s2.perCleaning, 7490);
    assert.equal(s2.perMonth, 29960);
    assert.equal(s2.periodTotal, 89880);
    assert.deepEqual(s2.nextVisits, [0, 7, 14, 21].map((n) => addDays(start, n)));
    // график целиком: ни одного визита раньше старта и позже конца
    const all = app.ctx.subs.visitDates(s2.startDate, s2.weekday, 4, 3);
    assert.ok(all.every((d) => d >= s2.startDate && d < s2.endDate));
    assert.ok(all.slice(1).every((d, i) => d === addDays(all[i], 7)));
  });

  it('валидация: индивидуальная площадь, другая услуга, дата, частота, день недели', async () => {
    const t = u.token;
    const bad = async (b, re) => { const r = await api('POST', '/subscriptions', { token: t, body: b }); assert.equal(r.status, 400, JSON.stringify(r.body)); if (re) assert.match(r.body.message, re); };
    await bad(body({ state: { ...SUBST, area: 300 } }), /индивидуально/);
    await bad(body({ state: { ...SUBST, service: 'general' } }));
    await bad(body({ state: { ...SUBST, freq: 3 } }));
    await bad(body({ state: { ...SUBST, months: 5 } }));
    await bad(body({ startDate: today() }));
    await bad(body({ startDate: '2020-01-01' }));
    await bad(body({ startDate: 'завтра' }));
    await bad(body({ weekday: 0 }));
    await bad(body({ weekday: 8 }));
    await bad(body({ slot: '23:00–24:00' }));
    await bad(body({ address: '' }));
    await bad(body({ state: { ...SUBST, tariff: 'x' } }));
  });

  it('materializeVisits: нужна авторизация администратора', async () => {
    assert.equal((await api('POST', '/internal/materialize', { body: {} })).status, 403);
    assert.equal((await api('POST', '/internal/materialize', { body: {}, headers: { 'X-Admin-Key': 'wrong' } })).status, 403);
    assert.equal((await api('POST', '/internal/materialize', { body: { daysAhead: 500 }, headers: { 'X-Admin-Key': ADMIN } })).status, 400);
  });

  it('создаёт сделки на визиты в окне ровно один раз', async () => {
    const dealsBefore = mb.state.deals.size;
    const r1 = await api('POST', '/internal/materialize', { body: { daysAhead: 30 }, headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const until = addDays(today(), 30);
    const expected1 = app.ctx.subs.visitDates(s1.startDate, s1.weekday, 2, 6).filter((d) => d >= today() && d <= until);
    const expected2 = app.ctx.subs.visitDates(s2.startDate, s2.weekday, 4, 3).filter((d) => d >= today() && d <= until);
    assert.ok(expected1.length >= 2 && expected2.length >= 4);
    assert.equal(visitsFor(s1.id).length, expected1.length);
    assert.equal(visitsFor(s2.id).length, expected2.length);
    assert.equal(r1.body.created, expected1.length + expected2.length);
    assert.equal(mb.state.deals.size - dealsBefore, r1.body.created);
    const d = visitsFor(s1.id).sort((a, b) => a.UF_CRM_CH_VISIT_DATE.localeCompare(b.UF_CRM_CH_VISIT_DATE))[0];
    assert.equal(d.UF_CRM_CH_VISIT_DATE, expected1[0]);
    assert.equal(d.TITLE, 'Подписка: поддерживающая уборка, 53 м²');
    assert.equal(d.OPPORTUNITY, '7290.00');
    assert.equal(d.CONTACT_ID, u.id);
    assert.equal(d.UF_CRM_CH_SLOT, '11:00–13:00');
    assert.equal(d.UF_CRM_CH_ADDRESS, 'Москва, Садовая 7');
    assert.equal(mb.rows(d.ID).length, 1);
    assert.equal(Number(mb.rows(d.ID)[0].PRICE), 7290);
    // второй запуск ничего не создаёт
    const r2 = await api('POST', '/internal/materialize', { body: { daysAhead: 30 }, headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(r2.body.created, 0);
    assert.equal(mb.state.deals.size - dealsBefore, r1.body.created);
    assert.equal(app.ctx.db.get('SELECT COUNT(*) AS c FROM sub_visits WHERE sub_id = ?', s1.id).c, expected1.length);
    // прямая вставка дубля невозможна (UNIQUE)
    assert.throws(() => app.ctx.db.run('INSERT INTO sub_visits(sub_id, date, created_at) VALUES (?, ?, 0)', s1.id, expected1[0]));
    // в списке заказов у таких сделок есть sub
    const orders = (await api('GET', '/orders', { token: u.token })).body.orders;
    assert.equal(orders.filter((o) => o.sub === s1.id).length, expected1.length);
  });

  it('пауза останавливает материализацию, возобновление и отмена работают', async () => {
    const v = await api('POST', '/subscriptions', { token: u.token, body: body({ state: { ...SUBST, freq: 4, months: 12 }, weekday: weekdayOf(addDays(start, 1)) }) });
    assert.equal(v.status, 200);
    const s3 = v.body.subscription;
    assert.equal((await api('PATCH', `/subscriptions/${s3.id}`, { token: u.token, body: { action: 'resume' } })).status, 400); // active -> resume нельзя
    const paused = await api('PATCH', `/subscriptions/${s3.id}`, { token: u.token, body: { action: 'pause' } });
    assert.equal(paused.body.subscription.status, 'paused');
    await api('POST', '/internal/materialize', { body: { daysAhead: 30 }, headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(visitsFor(s3.id).length, 0);
    assert.equal((await api('PATCH', `/subscriptions/${s3.id}`, { token: u.token, body: { action: 'pause' } })).status, 400);
    const resumed = await api('PATCH', `/subscriptions/${s3.id}`, { token: u.token, body: { action: 'resume' } });
    assert.equal(resumed.body.subscription.status, 'active');
    await api('POST', '/internal/materialize', { body: { daysAhead: 30 }, headers: { 'X-Admin-Key': ADMIN } });
    const n = visitsFor(s3.id).length;
    assert.ok(n >= 4);
    const cancelled = await api('PATCH', `/subscriptions/${s3.id}`, { token: u.token, body: { action: 'cancel' } });
    assert.equal(cancelled.body.subscription.status, 'cancelled');
    assert.deepEqual(cancelled.body.subscription.nextVisits, []);
    await api('POST', '/internal/materialize', { body: { daysAhead: 60 }, headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(visitsFor(s3.id).length, n);
    assert.equal((await api('PATCH', `/subscriptions/${s3.id}`, { token: u.token, body: { action: 'pause' } })).status, 400);
    assert.equal((await api('PATCH', `/subscriptions/${s3.id}`, { token: u.token, body: { action: 'dance' } })).status, 400);
  });

  it('чужая, выдуманная или подделанная подписка — 404', async () => {
    const other = await login(newPhone(), { name: 'Чужой Человек', email: '' });
    for (const id of [s1.id, 's_00000000', 's_zzzzzzzz', '../etc/passwd', "s_1' OR '1'='1", 'x'.repeat(200)]) {
      const r = await api('PATCH', `/subscriptions/${encodeURIComponent(id)}`, { token: other.token, body: { action: 'cancel' } });
      assert.equal(r.status, 404, id);
    }
    const mine = (await api('GET', '/subscriptions', { token: u.token })).body.subscriptions.find((s) => s.id === s1.id);
    assert.equal(mine.status, 'active');
    assert.equal((await api('GET', '/subscriptions', { token: other.token })).body.subscriptions.length, 0);
    assert.equal((await api('PATCH', `/subscriptions/${s1.id}`, { body: { action: 'cancel' } })).status, 401);
  });
});

describe('Telegram', () => {
  let u, chat = 777001;
  before(async () => { u = await login(newPhone(), { name: 'Тимур Телеграмов', email: '' }); });

  it('вебхук требует секрет', async () => {
    assert.equal(await tgUpdate(chat, '/start', { secret: 'wrong' }), 403);
    assert.equal(await tgUpdate(chat, '/start', { secret: null }), 403);
    assert.equal(await tgUpdate(chat, '/start'), 200);
    assert.ok(tg.to(chat).at(-1).text.includes('бот CleanHub'));
    assert.equal(tg.messages.at(-1).token, '123456:TESTTOKEN');
  });

  it('привязка: токен одноразовый, чужой чат не может использовать повторно', async () => {
    assert.equal((await api('POST', '/telegram/link')).status, 401);
    const l = await api('POST', '/telegram/link', { token: u.token });
    assert.equal(l.status, 200);
    assert.match(l.body.url, /^https:\/\/t\.me\/cleanhub_test_bot\?start=link_[0-9a-f]{32}$/);
    assert.equal(l.body.url.endsWith(l.body.token), true);
    assert.deepEqual((await api('GET', `/telegram/status?token=${l.body.token}`, { token: u.token })).body, { connected: false, username: '' });
    await tgUpdate(chat, `/start link_${l.body.token}`, { username: 'timur_tg' });
    assert.deepEqual((await api('GET', `/telegram/status?token=${l.body.token}`, { token: u.token })).body, { connected: true, username: 'timur_tg' });
    assert.match(tg.to(chat).at(-1).text, /подключён/);
    const me = (await api('GET', '/me', { token: u.token })).body;
    assert.deepEqual(me.user.tg, { connected: true, username: 'timur_tg' });
    // повторное использование токена другим чатом
    await tgUpdate(888, `/start link_${l.body.token}`);
    assert.match(tg.to(888).at(-1).text, /устарела/);
    assert.equal(app.ctx.db.get('SELECT COUNT(*) AS c FROM contacts_local WHERE tg_chat_id = ?', '888').c, 0);
    assert.equal((await api('GET', '/telegram/status?token=bad!', { token: u.token })).status, 400);
  });

  it('вход через бота: привязанный чат получает сессию один раз, непривязанный — подсказку', async () => {
    const s = await api('POST', '/auth/telegram/start', {});
    assert.equal(s.status, 200);
    assert.match(s.body.url, /^https:\/\/t\.me\/cleanhub_test_bot\?start=login_[0-9a-f]{32}$/);
    assert.deepEqual((await api('GET', `/auth/telegram/status?token=${s.body.token}`)).body, { done: false });
    // непривязанный чат
    await tgUpdate(999001, `/start login_${s.body.token}`);
    assert.match(tg.to(999001).at(-1).text, /Сначала войдите по SMS и подключите Telegram в профиле/);
    assert.deepEqual((await api('GET', `/auth/telegram/status?token=${s.body.token}`)).body, { done: false });
    // привязанный чат
    await tgUpdate(chat, `/start login_${s.body.token}`);
    const st = await api('GET', `/auth/telegram/status?token=${s.body.token}`);
    assert.equal(st.body.done, true);
    const me = await api('GET', '/me', { token: st.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, u.id);
    assert.equal((await api('GET', `/auth/telegram/status?token=${s.body.token}`)).status, 404); // токен входа уже использован
    assert.equal((await api('GET', '/auth/telegram/status?token=zzz')).status, 400);
  });

  it('уведомления о смене статуса приходят один раз на статус', async () => {
    const o = await api('POST', '/orders', { token: u.token, body: ORDER() });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const id = o.body.order.dealId;
    assert.ok(await waitFor(() => tg.to(chat).some((m) => m.text.includes(`Заказ CH-${id} принят`))));
    await bitrixEvent(id, { event: 'ONCRMDEALADD' }); // событие добавления не дублирует «принят»
    assert.equal(tg.to(chat).filter((m) => m.text.includes(`CH-${id} принят`)).length, 1);
    mb.setStage(id, 'C2:EXECUTING');
    await Promise.all([bitrixEvent(id), bitrixEvent(id)]);
    await bitrixEvent(id);
    assert.equal(tg.to(chat).filter((m) => m.text === `Мастер приступил к заказу CH-${id}.`).length, 1);
    mb.setStage(id, 'C2:WON');
    await bitrixEvent(id);
    await bitrixEvent(id);
    assert.equal(tg.to(chat).filter((m) => m.text.includes(`Заказ CH-${id} выполнен`)).length, 1);
    assert.ok(tg.to(chat).at(-1).reply_markup.inline_keyboard[0][0].url);
  });

  it('уведомления можно отключить в профиле и отвязкой', async () => {
    await api('PATCH', '/me', { token: u.token, body: { notify: { tgOrders: false, tgPromo: false } } });
    const o = await api('POST', '/orders', { token: u.token, body: ORDER() });
    const id = o.body.order.dealId;
    const n = tg.to(chat).length;
    mb.setStage(id, 'C2:EXECUTING');
    await bitrixEvent(id);
    assert.equal(tg.to(chat).length, n);
    await api('PATCH', '/me', { token: u.token, body: { notify: { tgOrders: true, tgPromo: false } } });
    mb.setStage(id, 'C2:LOSE');
    await bitrixEvent(id);
    assert.equal(tg.to(chat).filter((m) => m.text.includes(`Заказ CH-${id} отменён`)).length, 1);
    // отвязка
    assert.deepEqual((await api('DELETE', '/telegram', { token: u.token })).body, { ok: true });
    assert.equal((await api('GET', '/telegram/status', { token: u.token })).body.connected, false);
    const o2 = await api('POST', '/orders', { token: u.token, body: ORDER() });
    mb.setStage(o2.body.order.dealId, 'C2:WON');
    const n2 = tg.to(chat).length;
    await bitrixEvent(o2.body.order.dealId);
    assert.equal(tg.to(chat).length, n2);
  });
});
