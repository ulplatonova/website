'use strict';
/* Авторизация: SMS-коды, сессии, лимиты, вход через Telegram. Без паролей. */
const crypto = require('node:crypto');
const { HttpError, bad, sha256, randomHex, safeEqual, plainObject } = require('./util');

const CODE_TTL = 5 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const TG_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const GENERIC_CODE_ERROR = 'Неверный или просроченный код. Запросите новый.';

/* Телефон -> +7XXXXXXXXXX или null */
function normalizePhone(raw) {
  if (typeof raw !== 'string' || raw.length > 30) return null;
  let d = raw.replace(/[\s()\-+.]/g, '');
  if (!/^\d+$/.test(d)) return null;
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = d.slice(1);
  else if (d.length !== 10) return null;
  if (!/^[3-9]\d{9}$/.test(d)) return null;
  return '+7' + d;
}

function createAuth(ctx) {
  const { db, bitrix, sms, config } = ctx;
  const now = () => ctx.now();

  /* Лимиты по скользящему окну. Проверяем все правила, и только потом записываем событие. */
  function limit(rules, message) {
    const t = now();
    for (const [key, max, windowMs] of rules) {
      const row = db.get('SELECT COUNT(*) AS c FROM rate_limits WHERE key = ? AND ts > ?', key, t - windowMs);
      if (row.c >= max) throw new HttpError(429, message);
    }
    for (const [key] of rules) db.run('INSERT INTO rate_limits(key, ts) VALUES (?, ?)', key, t);
  }

  async function requestCode(body, ip) {
    if (!plainObject(body)) throw bad('Некорректный запрос.');
    const phone = normalizePhone(body.phone);
    if (!phone) throw bad('Укажите телефон в формате +7 (900) 123-45-67.');
    if (!['login', 'register'].includes(body.purpose)) throw bad('Некорректная цель запроса кода.');
    limit([[`code60:${phone}`, 1, 60 * 1000]], 'Код уже отправлен. Повторный запрос возможен через минуту.');
    limit([[`codeh:${phone}`, 5, 3600 * 1000], [`codeip:${ip}`, 20, 3600 * 1000]], 'Слишком много запросов кода. Попробуйте позже.');
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const t = now();
    db.run(`INSERT INTO sms_codes(phone, code_hash, purpose, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, purpose=excluded.purpose, attempts=0, created_at=excluded.created_at, expires_at=excluded.expires_at`,
    phone, sha256(`${phone}:${code}`), body.purpose, t, t + CODE_TTL);
    try { await sms.send(phone, `Код CleanHub: ${code}. Никому его не сообщайте.`); } catch (e) {
      db.run('DELETE FROM sms_codes WHERE phone = ?', phone);
      ctx.logger.error('SMS не отправлено:', e.message);
      throw new HttpError(502, 'Не удалось отправить SMS. Попробуйте позже.');
    }
    return { ok: true }; // одинаковый ответ для известных и неизвестных номеров
  }

  function parseProfile(p) {
    if (p === null || p === undefined) return {};
    if (!plainObject(p)) throw bad('Некорректные данные профиля.');
    const out = {};
    if (p.name !== undefined && p.name !== null && p.name !== '') {
      if (typeof p.name !== 'string' || p.name.trim().length > 100) throw bad('Имя слишком длинное.');
      out.name = p.name.trim();
    }
    if (p.email !== undefined && p.email !== null && p.email !== '') {
      if (typeof p.email !== 'string' || p.email.length > 254 || !EMAIL_RE.test(p.email.trim())) throw bad('Проверьте адрес электронной почты.');
      out.email = p.email.trim();
    }
    if (typeof p.refCode === 'string' && p.refCode.length <= 20) out.refCode = p.refCode.trim().toUpperCase(); // неверный код молча игнорируем
    return out;
  }

  async function verify(body, ip) {
    if (!plainObject(body)) throw bad('Некорректный запрос.');
    const phone = normalizePhone(body.phone);
    if (!phone || typeof body.code !== 'string' || !/^\d{4}$/.test(body.code)) throw bad(GENERIC_CODE_ERROR);
    const profile = parseProfile(body.profile);
    limit([[`verifyip:${ip}`, 60, 3600 * 1000]], 'Слишком много попыток. Попробуйте позже.');

    const rec = db.get('SELECT * FROM sms_codes WHERE phone = ?', phone);
    if (!rec || rec.expires_at < now()) throw bad(GENERIC_CODE_ERROR);
    if (!safeEqual(rec.code_hash, sha256(`${phone}:${body.code}`))) {
      const attempts = rec.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) db.run('DELETE FROM sms_codes WHERE phone = ?', phone);
      else db.run('UPDATE sms_codes SET attempts = ? WHERE phone = ?', attempts, phone);
      throw bad(GENERIC_CODE_ERROR);
    }
    // код одноразовый: если DELETE ничего не удалил, его уже использовал параллельный запрос
    if (db.run('DELETE FROM sms_codes WHERE phone = ?', phone).changes !== 1) throw bad(GENERIC_CODE_ERROR);

    let contact;
    try { contact = await bitrix.findContactByPhone(phone); } catch (e) { ctx.logger.error('Bitrix findContact:', e.message); throw new HttpError(502, 'Сервис временно недоступен. Попробуйте позже.'); }
    let referralApplied = false;
    let contactId;
    try {
      if (!contact) {
        const [first, ...rest] = (profile.name || '').split(/\s+/).filter(Boolean);
        const myCode = ctx.loyalty.newRefCode();
        contactId = await bitrix.createContact({ name: first, lastName: rest.join(' '), phone, email: profile.email, refCode: myCode });
        const referrer = profile.refCode ? ctx.loyalty.findByRefCode(profile.refCode) : null;
        ctx.loyalty.ensureLocal(contactId, { refCode: myCode, name: profile.name || 'Клиент', referrerId: referrer && referrer.bitrix_contact_id !== contactId ? referrer.bitrix_contact_id : null });
        referralApplied = !!(referrer && referrer.bitrix_contact_id !== contactId);
      } else {
        contactId = String(contact.ID);
        ctx.loyalty.ensureLocal(contactId, { name: bitrix.normalizeContact(contact).name });
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      ctx.logger.error('Регистрация контакта:', e.message);
      throw new HttpError(502, 'Сервис временно недоступен. Попробуйте позже.');
    }
    return { token: createSession(contactId), referralApplied };
  }

  function createSession(contactId) {
    const token = randomHex(32);
    const t = now();
    db.run('INSERT INTO sessions(token_hash, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), String(contactId), t, t + SESSION_TTL);
    return token;
  }

  function authenticate(header) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(header || '');
    if (!m) return null;
    const row = db.get('SELECT contact_id, expires_at FROM sessions WHERE token_hash = ?', sha256(m[1]));
    if (!row || row.expires_at < now()) return null;
    return row.contact_id;
  }

  /* ---- вход через Telegram ---- */
  function tgLoginStart(ip) {
    limit([[`tgstart:${ip}`, 20, 3600 * 1000]], 'Слишком много запросов. Попробуйте позже.');
    const token = randomHex(16);
    const t = now();
    db.run("INSERT INTO tg_tokens(token_hash, kind, created_at, expires_at) VALUES (?, 'login', ?, ?)", sha256(token), t, t + TG_TTL);
    return token;
  }
  function tgLoginStatus(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) throw bad('Некорректный токен.');
    const h = sha256(token);
    const row = db.get("SELECT * FROM tg_tokens WHERE token_hash = ? AND kind = 'login'", h);
    if (!row || row.expires_at < now()) throw new HttpError(404, 'Время ожидания истекло. Начните вход заново.');
    if (!row.done) return { done: false };
    db.run('DELETE FROM tg_tokens WHERE token_hash = ?', h); // сессия отдаётся ровно один раз
    return { done: true, token: row.session_token };
  }
  /* вызывается ботом; возвращает true, если токен принят */
  function tgLoginComplete(token, contactId) {
    const h = sha256(token);
    const row = db.get("SELECT * FROM tg_tokens WHERE token_hash = ? AND kind = 'login' AND done = 0", h);
    if (!row || row.expires_at < now()) return false;
    db.run('UPDATE tg_tokens SET done = 1, session_token = ?, contact_id = ? WHERE token_hash = ?', createSession(contactId), String(contactId), h);
    return true;
  }

  function purge() {
    const t = now();
    db.run('DELETE FROM sessions WHERE expires_at < ?', t);
    db.run('DELETE FROM sms_codes WHERE expires_at < ?', t);
    db.run('DELETE FROM tg_tokens WHERE expires_at < ?', t);
    db.run('DELETE FROM rate_limits WHERE ts < ?', t - 2 * 3600 * 1000);
  }

  return { limit, normalizePhone, requestCode, verify, createSession, authenticate, tgLoginStart, tgLoginStatus, tgLoginComplete, purge };
}

module.exports = { createAuth, normalizePhone };
