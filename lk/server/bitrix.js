'use strict';
/* Клиент REST Битрикс24 через входящий вебхук. Используются только документированные методы. */

class BitrixError extends Error {
  constructor(code, description, status) {
    super(`Bitrix: ${code}${description ? ' — ' + description : ''}`);
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_METHOD = /(\.get|\.list|\.findbycomm|\.fields)$/;

/* PHP-подобное кодирование параметров для команд batch: filter[ID]=1&select[0]=ID */
function toQuery(params) {
  const parts = [];
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${prefix}[${encodeURIComponent(k)}]`, x);
    else parts.push(`${prefix}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params || {})) walk(encodeURIComponent(k), v);
  return parts.join('&');
}

function createBitrix(config, { fetchImpl = fetch, logger } = {}) {
  const base = config.bitrixWebhookUrl;
  const F = config.fields;
  const MAX_ATTEMPTS = 5;

  async function callFull(method, params = {}) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(config.bitrixRetryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * config.bitrixRetryBaseMs));
      let res, data;
      try {
        res = await fetchImpl(`${base}${method}.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const text = await res.text();
        try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      } catch (e) {
        // сетевая ошибка или таймаут: повторяем только чтение, чтобы не создать дубль
        lastErr = new BitrixError('NETWORK', e && e.name === 'TimeoutError' ? 'таймаут 15 с' : 'сеть недоступна', 0);
        if (READ_METHOD.test(method)) continue;
        throw lastErr;
      }
      const code = data.error;
      if (code === 'QUERY_LIMIT_EXCEEDED' || res.status >= 500) {
        lastErr = new BitrixError(code || 'HTTP_' + res.status, data.error_description, res.status);
        continue;
      }
      if (code || !res.ok) throw new BitrixError(code || 'HTTP_' + res.status, data.error_description, res.status);
      return data;
    }
    logger && logger.warn('Bitrix: исчерпаны попытки для', method, lastErr && lastErr.code);
    throw lastErr;
  }
  const call = async (method, params) => (await callFull(method, params)).result;

  /* cmds: массив [method, params] или объект {ключ: [method, params]}. До 50 команд за запрос, остальное чанками. */
  async function batch(cmds, { halt = false } = {}) {
    const isArr = Array.isArray(cmds);
    const entries = isArr ? cmds.map((c, i) => [String(i), c]) : Object.entries(cmds);
    const result = isArr ? [] : {};
    const errors = {};
    for (let i = 0; i < entries.length; i += 50) {
      const chunk = entries.slice(i, i + 50);
      const cmd = {};
      for (const [key, [method, params]] of chunk) cmd[key] = `${method}?${toQuery(params)}`;
      const data = await call('batch', { halt: halt ? 1 : 0, cmd });
      const r = (data && data.result) || {};
      const e = (data && data.result_error) || {};
      for (const [key] of chunk) {
        if (e[key]) errors[key] = new BitrixError(e[key].error || 'BATCH_ERROR', e[key].error_description, 200);
        const v = Array.isArray(r) ? r[Number(key)] : r[key];
        if (isArr) result[Number(key)] = v; else result[key] = v;
      }
    }
    return { result, errors };
  }

  /* ---- контакты ---- */
  const phoneVariants = (phone) => {
    const d = String(phone).replace(/\D/g, '').slice(-10);
    return ['+7' + d, '7' + d, '8' + d];
  };

  async function findContactByPhone(phone) {
    const res = await call('crm.duplicate.findbycomm', { type: 'PHONE', values: phoneVariants(phone), entity_type: 'CONTACT' });
    const ids = (res && res.CONTACT) || [];
    if (!ids.length) return null;
    const sorted = ids.map(Number).sort((a, b) => a - b);
    for (const id of sorted) {
      const c = await getContact(id);
      if (c) return c;
    }
    return null;
  }

  async function getContact(id) {
    try { return await call('crm.contact.get', { id }); } catch (e) {
      if (e instanceof BitrixError && (e.code === 'NOT_FOUND' || e.status === 404)) return null;
      throw e;
    }
  }

  async function createContact({ name, lastName, phone, email, refCode }) {
    const fields = {
      NAME: name || 'Клиент', OPEN: 'Y', SOURCE_ID: 'WEB', TYPE_ID: 'CLIENT',
      PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }]
    };
    if (lastName) fields.LAST_NAME = lastName;
    if (email) fields.EMAIL = [{ VALUE: email, VALUE_TYPE: 'WORK' }];
    if (refCode) fields[F.refCode] = refCode;
    if (config.bitrixAssignedById) fields.ASSIGNED_BY_ID = config.bitrixAssignedById;
    return String(await call('crm.contact.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } }));
  }
  const updateContact = (id, fields) => call('crm.contact.update', { id, fields });

  /* Приведение сырого контакта к виду для кабинета */
  function normalizeContact(raw) {
    if (!raw) return null;
    const first = (arr) => (Array.isArray(arr) && arr[0] && arr[0].VALUE) || '';
    return {
      id: String(raw.ID),
      firstName: raw.NAME || '', lastName: raw.LAST_NAME || '',
      name: [raw.NAME, raw.LAST_NAME].filter(Boolean).join(' ').trim(),
      phone: first(raw.PHONE), email: first(raw.EMAIL),
      birthday: raw.BIRTHDATE ? String(raw.BIRTHDATE).slice(0, 10) : '',
      refCode: raw[F.refCode] || ''
    };
  }

  /* ---- сделки ---- */
  const DEAL_SELECT = ['*', 'UF_*'];
  async function listDeals(contactId) {
    const all = [];
    let start = 0;
    for (let page = 0; page < 200; page++) {
      const data = await callFull('crm.deal.list', { filter: { CONTACT_ID: contactId }, select: DEAL_SELECT, order: { ID: 'DESC' }, start });
      all.push(...(data.result || []));
      if (data.next === undefined || data.next === null) break;
      start = data.next;
    }
    return all;
  }
  async function getDeal(id) {
    try { return await call('crm.deal.get', { id }); } catch (e) {
      if (e instanceof BitrixError && (e.code === 'NOT_FOUND' || e.status === 404)) return null;
      throw e;
    }
  }
  const createDeal = async (fields) => String(await call('crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } }));
  const setProductRows = (id, rows) => call('crm.deal.productrows.set', { id, rows });

  /* Товарные позиции нескольких сделок одним (или несколькими по 50) batch-запросом -> {dealId: rows[]} */
  async function getProductRowsBatch(dealIds) {
    const out = {};
    const ids = [...new Set(dealIds.map(String))];
    if (!ids.length) return out;
    const cmds = {};
    ids.forEach((id) => { cmds['d' + id] = ['crm.deal.productrows.get', { id }]; });
    const { result, errors } = await batch(cmds);
    for (const id of ids) out[id] = errors['d' + id] ? [] : (Array.isArray(result['d' + id]) ? result['d' + id] : []);
    return out;
  }

  /* ---- статусы ---- */
  const stageSuffix = (s) => String(s || '').split(':').pop();
  /* S -> done, F -> cancel, рабочие стадии (по суффиксу после «:») -> work, иначе new */
  function mapStatus(deal) {
    const sem = deal.STAGE_SEMANTIC_ID;
    if (sem === 'S') return 'done';
    if (sem === 'F') return 'cancel';
    return config.bitrixWorkStages.includes(stageSuffix(deal.STAGE_ID)) ? 'work' : 'new';
  }

  return { call, callFull, batch, toQuery, phoneVariants, findContactByPhone, getContact, createContact, updateContact, normalizeContact, listDeals, getDeal, createDeal, setProductRows, getProductRowsBatch, mapStatus, stageSuffix };
}

module.exports = { createBitrix, BitrixError, toQuery };
