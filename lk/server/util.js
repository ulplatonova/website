'use strict';
/* Общие мелочи: ошибки HTTP, хэши, сравнение без утечки по времени, даты, разбор вложенных form-параметров. */
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
const bad = (msg) => new HttpError(400, msg);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/* Сравнение строк за постоянное время (хэшируем, чтобы длины совпали). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* Дата «сегодня» по Москве (UTC+3, без перехода на летнее время) в формате YYYY-MM-DD. */
function moscowDate(ms) {
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/* Прибавить месяцы с обрезкой по концу месяца (31 янв + 1 мес = 28/29 фев). */
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
/* День недели 1=пн … 7=вс */
function weekdayOf(dateStr) {
  const w = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return w === 0 ? 7 : w;
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/* Разбор PHP-подобных ключей: data[FIELDS][ID]=5 -> {data:{FIELDS:{ID:'5'}}} */
function parseNested(pairs) {
  const out = {};
  for (const [key, value] of pairs) {
    const parts = key.replace(/\]/g, '').split('[');
    let cur = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '__proto__' || p === 'constructor' || p === 'prototype') break;
      if (i === parts.length - 1) cur[p] = value;
      else {
        if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
        cur = cur[p];
      }
    }
  }
  return out;
}

/* Лог без секретов. Уровень error/warn/info. В тестах молчим, если LOG_LEVEL не задан. */
function makeLogger(level) {
  const order = { silent: 0, error: 1, warn: 2, info: 3 };
  const lim = order[level] ?? 2;
  const w = (lvl, args) => { if (order[lvl] <= lim) console[lvl === 'info' ? 'log' : lvl](`[${new Date().toISOString()}] [${lvl}]`, ...args); };
  return { error: (...a) => w('error', a), warn: (...a) => w('warn', a), info: (...a) => w('info', a) };
}

const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

module.exports = { HttpError, bad, sha256, randomHex, safeEqual, moscowDate, addDays, addMonths, weekdayOf, isValidDate, parseNested, makeLogger, plainObject };
