'use strict';
/* HTTP-сервер личного кабинета CleanHub. Только встроенные модули Node.js. */
const http = require('node:http');
const crypto = require('node:crypto');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createBitrix, BitrixError } = require('./bitrix');
const { createSms } = require('./sms');
const { createPayments } = require('./payments');
const { createLoyalty } = require('./loyalty');
const { createAuth, normalizePhone } = require('./auth');
const { createTelegram } = require('./telegram');
const { createOrders } = require('./orders');
const { createSubscriptions } = require('./subscriptions');
const { HttpError, bad, safeEqual, parseNested, makeLogger, isValidDate, moscowDate, plainObject } = require('./util');

const BODY_LIMIT = 100 * 1024;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function formatPhone(p) {
  const n = normalizePhone(p || '');
  return n ? `+7 (${n.slice(2, 5)}) ${n.slice(5, 8)}-${n.slice(8, 10)}-${n.slice(10, 12)}` : String(p || '');
}

function createApp(config, overrides = {}) {
  const logger = overrides.logger || makeLogger(config.logLevel);
  const db = openDb(config.dbPath);
  const ctx = { config, db, logger, now: overrides.now || (() => Date.now()) };
  ctx.bitrix = createBitrix(config, { fetchImpl: overrides.fetchImpl, logger });
  ctx.sms = createSms(config, { fetchImpl: overrides.fetchImpl, logger });
  ctx.payments = createPayments(config, { fetchImpl: overrides.fetchImpl });
  ctx.loyalty = createLoyalty(ctx);
  ctx.auth = createAuth(ctx);
  ctx.telegram = createTelegram(ctx, { fetchImpl: overrides.fetchImpl });
  ctx.orders = createOrders(ctx);
  ctx.subs = createSubscriptions(ctx);
  const { bitrix, loyalty, auth, orders, subs, telegram } = ctx;

  if (config.smsProvider === 'console' && config.env === 'production') logger.warn('SMS_PROVIDER=console в продакшене: коды пишутся в лог. Используйте smsru.');

  /* ---- профиль ---- */
  function userView(contact, local) {
    const c = bitrix.normalizeContact(contact);
    let addresses = [], notify = { tgOrders: true, tgPromo: false };
    try { addresses = JSON.parse(local.addresses); } catch { /* пусто */ }
    try { notify = { ...notify, ...JSON.parse(local.notify) }; } catch { /* по умолчанию */ }
    return {
      id: c.id, name: c.name, phone: formatPhone(c.phone), email: c.email, birthday: c.birthday,
      tg: { connected: !!local.tg_chat_id, username: local.tg_username || '' }, notify, addresses
    };
  }

  async function getMe(contactId) {
    const contact = await bitrix.getContact(contactId);
    if (!contact) throw new HttpError(404, 'Профиль не найден.');
    const local = loyalty.ensureLocal(contactId, { name: bitrix.normalizeContact(contact).name });
    const deals = await orders.loadClientDeals(contactId);
    return { user: userView(contact, local), loyalty: loyalty.loyaltyView(contactId, deals), referral: loyalty.referralView(contactId) };
  }

  async function patchMe(contactId, body) {
    if (!plainObject(body)) throw bad('Некорректный запрос.');
    const contact = await bitrix.getContact(contactId);
    if (!contact) throw new HttpError(404, 'Профиль не найден.');
    const fields = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw bad('Укажите имя (до 100 символов).');
      const [first, ...rest] = body.name.trim().split(/\s+/);
      fields.NAME = first; fields.LAST_NAME = rest.join(' ');
    }
    if (body.email !== undefined) {
      if (typeof body.email !== 'string' || (body.email && (body.email.length > 254 || !EMAIL_RE.test(body.email.trim())))) throw bad('Проверьте адрес электронной почты.');
      const old = Array.isArray(contact.EMAIL) && contact.EMAIL[0];
      const value = body.email.trim();
      if (old) fields.EMAIL = [{ ID: old.ID, VALUE: value }]; else if (value) fields.EMAIL = [{ VALUE: value, VALUE_TYPE: 'WORK' }];
    }
    if (body.birthday !== undefined) {
      if (typeof body.birthday !== 'string' || (body.birthday && (!isValidDate(body.birthday) || body.birthday < '1900-01-01' || body.birthday > moscowDate(ctx.now())))) throw bad('Проверьте дату рождения.');
      fields.BIRTHDATE = body.birthday;
    }
    let addresses, notify;
    if (body.addresses !== undefined) {
      if (!Array.isArray(body.addresses) || body.addresses.length > 10) throw bad('Можно сохранить до 10 адресов.');
      addresses = body.addresses.map((a) => {
        if (!plainObject(a) || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 300) throw bad('Проверьте адрес.');
        if (a.label !== undefined && (typeof a.label !== 'string' || a.label.length > 40)) throw bad('Название адреса слишком длинное.');
        const id = typeof a.id === 'string' && /^[\w-]{1,24}$/.test(a.id) ? a.id : 'a' + crypto.randomBytes(3).toString('hex');
        return { id, label: (a.label || '').trim(), text: a.text.trim() };
      });
    }
    if (body.notify !== undefined) {
      if (!plainObject(body.notify) || ['tgOrders', 'tgPromo'].some((k) => body.notify[k] !== undefined && typeof body.notify[k] !== 'boolean')) throw bad('Некорректные настройки уведомлений.');
      notify = { tgOrders: body.notify.tgOrders !== false, tgPromo: body.notify.tgPromo === true };
    }
    const local = loyalty.ensureLocal(contactId);
    if (Object.keys(fields).length) await bitrix.updateContact(contactId, fields);
    if (addresses) db.run('UPDATE contacts_local SET addresses = ? WHERE bitrix_contact_id = ?', JSON.stringify(addresses), String(contactId));
    if (notify) db.run('UPDATE contacts_local SET notify = ? WHERE bitrix_contact_id = ?', JSON.stringify(notify), String(contactId));
    const fresh = await bitrix.getContact(contactId);
    const name = bitrix.normalizeContact(fresh).name;
    if (name !== local.name) loyalty.ensureLocal(contactId, { name });
    return { user: userView(fresh, loyalty.getLocal(contactId)) };
  }

  /* ---- маршруты ---- */
  const routes = [];
  const route = (method, pattern, opts, handler) => routes.push({ method, pattern, opts, handler });
  const OPEN = { auth: false }, AUTH = { auth: true };

  route('GET', /^\/health$/, OPEN, async () => ({ ok: true }));
  route('POST', /^\/auth\/code$/, OPEN, (r) => auth.requestCode(r.body, r.ip));
  route('POST', /^\/auth\/verify$/, OPEN, (r) => auth.verify(r.body, r.ip));
  route('POST', /^\/auth\/telegram\/start$/, OPEN, async (r) => {
    if (!telegram.enabled) throw new HttpError(503, 'Вход через Telegram временно недоступен.');
    const token = auth.tgLoginStart(r.ip);
    return { url: `https://t.me/${config.telegramBotUsername}?start=login_${token}`, token };
  });
  route('GET', /^\/auth\/telegram\/status$/, OPEN, async (r) => auth.tgLoginStatus(r.query.token));

  route('GET', /^\/me$/, AUTH, (r) => getMe(r.contactId));
  route('PATCH', /^\/me$/, AUTH, (r) => patchMe(r.contactId, r.body));
  route('POST', /^\/loyalty\/promo$/, AUTH, async (r) => loyalty.redeemPromo(r.contactId, plainObject(r.body) ? r.body.code : undefined));
  route('GET', /^\/orders$/, AUTH, (r) => orders.listOrders(r.contactId));
  route('POST', /^\/orders$/, AUTH, (r) => orders.createOrder(r.contactId, r.body));
  route('GET', /^\/subscriptions$/, AUTH, async (r) => subs.list(r.contactId));
  route('POST', /^\/subscriptions$/, AUTH, (r) => subs.create(r.contactId, r.body));
  route('PATCH', /^\/subscriptions\/([^/]+)$/, AUTH, async (r) => subs.act(r.contactId, r.params[0], r.body));

  route('POST', /^\/telegram\/link$/, AUTH, async (r) => telegram.createLinkToken(r.contactId));
  route('GET', /^\/telegram\/status$/, AUTH, async (r) => telegram.status(r.contactId, r.query.token));
  route('DELETE', /^\/telegram$/, AUTH, async (r) => telegram.unlink(r.contactId));
  route('POST', /^\/telegram\/webhook$/, OPEN, async (r) => {
    if (!telegram.verifySecret(r.headers['x-telegram-bot-api-secret-token'])) throw new HttpError(403, 'Доступ запрещён.');
    try { await telegram.handleUpdate(r.body); } catch (e) { logger.error('Telegram webhook:', e.message); }
    return { ok: true };
  });

  route('POST', /^\/bitrix\/events$/, { auth: false, form: true }, async (r) => {
    const b = r.body || {};
    const token = b.auth && b.auth.application_token;
    if (!config.bitrixEventToken || !safeEqual(config.bitrixEventToken, typeof token === 'string' ? token : '')) throw new HttpError(403, 'Доступ запрещён.');
    const id = b.data && b.data.FIELDS && b.data.FIELDS.ID;
    if (['ONCRMDEALUPDATE', 'ONCRMDEALADD'].includes(String(b.event || '').toUpperCase()) && /^\d{1,12}$/.test(String(id))) {
      // Отвечаем 200 при любых внутренних ошибках: повторы Битрикса не нужны, сверка есть в GET /me и /orders
      try {
        await Promise.race([orders.handleDealEvent(String(id)), new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут обработки события')), 8000).unref())]);
      } catch (e) { logger.error('Событие Битрикса:', e.message); }
    }
    return { ok: true };
  });

  route('POST', /^\/yookassa\/webhook$/, OPEN, async (r) => {
    if (!ctx.payments.enabled) throw new HttpError(404, 'Не найдено.');
    try {
      const res = await ctx.payments.handleWebhook(r.body);
      if (res && res.event === 'succeeded' && res.subscriptionId) {
        const sub = subs.findByPaymentId(res.paymentId);
        // платёж должен принадлежать именно этой подписке и совпадать по сумме
        if (sub && sub.id === res.subscriptionId && Number(res.amount) === sub.per_month) subs.activatePaid(sub.id, res.paymentId);
      }
    } catch (e) { logger.error('Вебхук ЮKassa:', e.message); }
    return { ok: true };
  });

  route('POST', /^\/internal\/materialize$/, OPEN, async (r) => {
    if (!config.adminKey || !safeEqual(config.adminKey, String(r.headers['x-admin-key'] || ''))) throw new HttpError(403, 'Доступ запрещён.');
    const raw = (plainObject(r.body) && r.body.daysAhead) ?? r.query.daysAhead;
    const daysAhead = raw === undefined ? 7 : Number(raw);
    if (!Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > 60) throw bad('daysAhead должен быть целым числом от 0 до 60.');
    return { ok: true, ...(await subs.materializeVisits({ daysAhead })) };
  });

  /* ---- HTTP ---- */
  const clientIp = (req) => {
    if (config.trustProxy) {
      const parts = String(req.headers['x-forwarded-for'] || '').split(',');
      const last = parts[parts.length - 1].trim();
      if (/^[0-9a-fA-F:.]{3,45}$/.test(last)) return last;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (!(config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin))) return {};
    return {
      'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400'
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > BODY_LIMIT) { req.resume(); return reject(new HttpError(413, 'Слишком большой запрос.')); }
      const chunks = []; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT) { reject(new HttpError(413, 'Слишком большой запрос.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function parseBody(raw, contentType, form) {
    if (!raw) return {};
    const ct = String(contentType || '').toLowerCase();
    if (form && ct.includes('application/x-www-form-urlencoded')) return parseNested(new URLSearchParams(raw));
    try { return JSON.parse(raw); } catch { throw bad('Некорректный JSON в запросе.'); }
  }

  async function handle(req, res) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(req) };
    const send = (status, body) => {
      if (status === 204) { res.writeHead(204, headers); return res.end(); }
      res.writeHead(status, headers); res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      if (req.method === 'OPTIONS') return send(204);
      let matched = null, params = [];
      let pathKnown = false;
      for (const rt of routes) {
        const m = rt.pattern.exec(pathname);
        if (!m) continue;
        pathKnown = true;
        if (rt.method === req.method) { matched = rt; params = m.slice(1).map(decodeURIComponent); break; }
      }
      if (!matched) throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Метод не поддерживается.' : 'Не найдено.');
      const r = { method: req.method, path: pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, ip: clientIp(req), params, contactId: null, body: {} };
      if (matched.opts.auth) {
        r.contactId = auth.authenticate(req.headers.authorization);
        if (!r.contactId) throw new HttpError(401, 'Требуется вход в кабинет.');
      }
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) r.body = parseBody(await readBody(req), req.headers['content-type'], matched.opts.form);
      return send(200, await matched.handler(r));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { message: e.message });
      if (e instanceof BitrixError) { logger.error('Bitrix:', e.message); return send(502, { message: 'Сервис временно недоступен. Попробуйте позже.' }); }
      logger.error('Ошибка запроса:', e && e.message);
      return send(500, { message: 'Внутренняя ошибка сервера. Попробуйте позже.' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  /* ---- таймеры ---- */
  const timers = [];
  let materializing = false;
  async function materializeSafe(opts) {
    if (materializing) return null;
    materializing = true;
    try { return await subs.materializeVisits(opts); } catch (e) { logger.error('materialize:', e.message); return null; } finally { materializing = false; }
  }
  function startTimers() {
    auth.purge();
    timers.push(setInterval(() => { try { auth.purge(); } catch (e) { logger.error('purge:', e.message); } }, 3600 * 1000));
    if (config.materializeIntervalMin > 0) timers.push(setInterval(() => materializeSafe(), config.materializeIntervalMin * 60 * 1000));
    timers.forEach((t) => t.unref());
  }

  function listen(port = config.port, host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); startTimers(); resolve(server.address().port); });
    });
  }
  function close() {
    timers.forEach(clearInterval);
    return new Promise((resolve) => {
      server.close(() => { try { db.close(); } catch { /* уже закрыта */ } resolve(); });
      server.closeIdleConnections && server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections && server.closeAllConnections(), 3000).unref();
    });
  }

  return { ctx, server, listen, close, materialize: materializeSafe };
}

module.exports = { createApp };

if (require.main === module) {
  let config;
  try { config = loadConfig(process.env); } catch (e) { console.error('Ошибка конфигурации: ' + e.message); process.exit(1); }
  const app = createApp(config);
  app.listen(config.port).then((port) => {
    app.ctx.logger.info(`CleanHub LK API слушает порт ${port}`);
  }).catch((e) => { console.error('Не удалось запустить сервер:', e.message); process.exit(1); });
  const stop = (sig) => {
    app.ctx.logger.info(`Получен ${sig}, останавливаюсь…`);
    setTimeout(() => process.exit(1), 10000).unref();
    app.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
