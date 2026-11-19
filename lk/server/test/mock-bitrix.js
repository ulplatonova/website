'use strict';
/* Эмулятор REST Битрикс24 в памяти: только те методы, которые использует сервер.
   Поведение приближено к настоящему: числа отдаются строками ("15990.00"), неизвестные UF-поля молча отбрасываются,
   OPPORTUNITY пересчитывается по товарным позициям, если не стоит IS_MANUAL_OPPORTUNITY=Y. */
const http = require('node:http');
const { parseNested } = require('../util');
const { FIELD_DEFAULTS } = require('../config');

function arrify(v) {
  if (Array.isArray(v)) return v.map(arrify);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    const o = Object.fromEntries(keys.map((k) => [k, arrify(v[k])]));
    if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => o[k]);
    return o;
  }
  return v;
}

const semanticOf = (stage) => {
  const suf = String(stage || '').split(':').pop();
  if (suf === 'WON') return 'S';
  if (suf === 'LOSE' || suf === 'APOLOGY') return 'F';
  return 'P';
};
const fixed = (n) => Number(n || 0).toFixed(2);

function createMockBitrix({ userfields = true } = {}) {
  const state = {
    contacts: new Map(), deals: new Map(), rows: new Map(),
    userfields: { deal: [], contact: [] },
    nextContact: 100, nextDeal: 10431, nextField: 1,
    calls: [], failNext: null
  };
  const ufNames = (entity) => state.userfields[entity].map((f) => f.FIELD_NAME);
  const addUf = (entity, name, type = 'string') => state.userfields[entity].push({ ID: String(state.nextField++), FIELD_NAME: name, USER_TYPE_ID: type });
  if (userfields) {
    for (const [k, v] of Object.entries(FIELD_DEFAULTS)) addUf(k === 'refCode' ? 'contact' : 'deal', v);
  }
  const keepUf = (entity, fields) => {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
      if (k.startsWith('UF_') && !ufNames(entity).includes(k)) continue; // как в Битриксе: неизвестное поле игнорируется
      out[k] = v;
    }
    return out;
  };
  const err = (code, desc, status = 400) => Object.assign(new Error(desc), { code, desc, status });
  let seq = 1;

  function contactMulti(list, type) {
    return (list || []).map((x) => ({ ID: String(seq++), VALUE_TYPE: x.VALUE_TYPE || 'WORK', VALUE: x.VALUE, TYPE_ID: type }));
  }

  const methods = {
    'crm.duplicate.findbycomm'(p) {
      if (p.type !== 'PHONE' || !Array.isArray(p.values)) throw err('ERROR_CORE', 'bad params');
      const ids = [];
      for (const c of state.contacts.values()) if ((c.PHONE || []).some((ph) => p.values.includes(ph.VALUE))) ids.push(Number(c.ID));
      return { result: ids.length ? { CONTACT: ids } : [] };
    },
    'crm.contact.get'(p) {
      const c = state.contacts.get(String(p.id));
      if (!c) throw err('NOT_FOUND', 'Not found');
      return { result: c };
    },
    'crm.contact.list'(p) {
      let list = [...state.contacts.values()];
      for (const [k, v] of Object.entries(p.filter || {})) list = list.filter((c) => String(c[k]) === String(v));
      return { result: list, total: list.length };
    },
    'crm.contact.add'(p) {
      const f = keepUf('contact', p.fields);
      if (!f.NAME) throw err('ERROR_CORE', 'NAME required');
      const id = String(state.nextContact++);
      state.contacts.set(id, { ...f, ID: id, PHONE: contactMulti(f.PHONE, 'PHONE'), EMAIL: contactMulti(f.EMAIL, 'EMAIL') });
      return { result: Number(id) };
    },
    'crm.contact.update'(p) {
      const c = state.contacts.get(String(p.id));
      if (!c) throw err('NOT_FOUND', 'Not found');
      const f = keepUf('contact', p.fields);
      for (const [k, v] of Object.entries(f)) {
        if (k === 'EMAIL' || k === 'PHONE') {
          for (const item of v) {
            const ex = item.ID && c[k].find((x) => x.ID === String(item.ID));
            if (ex) { if (item.VALUE === '') c[k] = c[k].filter((x) => x !== ex); else ex.VALUE = item.VALUE; } else if (item.VALUE) c[k].push(...contactMulti([item], k));
          }
        } else c[k] = v;
      }
      return { result: true };
    },
    'crm.deal.list'(p) {
      let list = [...state.deals.values()];
      for (const [k, v] of Object.entries(p.filter || {})) list = list.filter((d) => String(d[k]) === String(v));
      const dir = (p.order && p.order.ID) === 'ASC' ? 1 : -1;
      list.sort((a, b) => dir * (Number(a.ID) - Number(b.ID)));
      const start = Number(p.start) || 0;
      const page = list.slice(start, start + 50);
      const out = { result: page, total: list.length };
      if (start + 50 < list.length) out.next = start + 50;
      return out;
    },
    'crm.deal.get'(p) {
      const d = state.deals.get(String(p.id));
      if (!d) throw err('NOT_FOUND', 'Not found');
      return { result: d };
    },
    'crm.deal.add'(p) {
      const f = keepUf('deal', p.fields);
      const id = String(state.nextDeal++);
      const stage = f.STAGE_ID || 'NEW';
      const deal = { ...f, ID: id, STAGE_ID: stage, STAGE_SEMANTIC_ID: semanticOf(stage), OPPORTUNITY: fixed(f.OPPORTUNITY),
        CONTACT_ID: f.CONTACT_ID ? String(f.CONTACT_ID) : null, CATEGORY_ID: String(f.CATEGORY_ID ?? 0), DATE_CREATE: new Date().toISOString().replace('Z', '+00:00') };
      for (const k of Object.keys(deal)) if (k.startsWith('UF_') && typeof deal[k] === 'number') deal[k] = String(deal[k]);
      state.deals.set(id, deal);
      return { result: Number(id) };
    },
    'crm.deal.update'(p) {
      const d = state.deals.get(String(p.id));
      if (!d) throw err('NOT_FOUND', 'Not found');
      Object.assign(d, keepUf('deal', p.fields));
      if (p.fields && p.fields.STAGE_ID) d.STAGE_SEMANTIC_ID = semanticOf(d.STAGE_ID);
      return { result: true };
    },
    'crm.deal.productrows.get'(p) {
      if (!state.deals.has(String(p.id))) throw err('NOT_FOUND', 'Not found');
      return { result: state.rows.get(String(p.id)) || [] };
    },
    'crm.deal.productrows.set'(p) {
      const d = state.deals.get(String(p.id));
      if (!d) throw err('NOT_FOUND', 'Not found');
      if (!Array.isArray(p.rows)) throw err('ERROR_CORE', 'rows required');
      const rows = p.rows.map((r, i) => ({ ID: String(seq++), OWNER_ID: String(p.id), OWNER_TYPE: 'D', PRODUCT_NAME: r.PRODUCT_NAME, PRICE: fixed(r.PRICE), QUANTITY: fixed(r.QUANTITY), SORT: String((i + 1) * 10) }));
      state.rows.set(String(p.id), rows);
      if (d.IS_MANUAL_OPPORTUNITY !== 'Y') d.OPPORTUNITY = fixed(rows.reduce((s, r) => s + Number(r.PRICE) * Number(r.QUANTITY), 0));
      return { result: true };
    }
  };
  for (const entity of ['deal', 'contact']) {
    methods[`crm.${entity}.userfield.list`] = () => ({ result: state.userfields[entity] });
    methods[`crm.${entity}.userfield.add`] = (p) => {
      const f = p.fields || {};
      if (!f.FIELD_NAME || !f.USER_TYPE_ID || !f.EDIT_FORM_LABEL) throw err('ERROR_CORE', 'FIELD_NAME, USER_TYPE_ID, EDIT_FORM_LABEL required');
      const full = 'UF_CRM_' + f.FIELD_NAME;
      if (ufNames(entity).includes(full)) throw err('ERROR_CORE', 'Field exists');
      addUf(entity, full, f.USER_TYPE_ID);
      return { result: Number(state.userfields[entity].at(-1).ID) };
    };
  }
  methods.batch = (p) => {
    const cmds = p.cmd || {};
    const keys = Object.keys(cmds);
    if (keys.length > 50) throw err('ERROR_BATCH_LENGTH_EXCEEDED', 'Max batch length exceeded', 400);
    const result = {}, result_error = {}, result_total = {}, result_next = {};
    for (const key of keys) {
      const [method, query = ''] = String(cmds[key]).split(/\?(.*)/s);
      try {
        if (!methods[method] || method === 'batch') throw err('ERROR_METHOD_NOT_FOUND', 'Method not found', 404);
        const r = methods[method](arrify(parseNested(new URLSearchParams(query))));
        result[key] = r.result;
        if (r.total !== undefined) result_total[key] = r.total;
        if (r.next !== undefined) result_next[key] = r.next;
      } catch (e) { result_error[key] = { error: e.code || 'ERROR', error_description: e.desc || e.message }; if (p.halt) break; }
    }
    return { result: { result, result_error, result_total, result_next } };
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url, 'http://x');
      // вспомогательные ручки для тестов
      const t = /^\/__test\/(.+)$/.exec(url.pathname);
      if (t) {
        const body = raw ? JSON.parse(raw) : {};
        if (t[1] === 'stage') { api.setStage(body.dealId, body.stage); return send(200, { ok: true }); }
        if (t[1] === 'contact') return send(200, { id: api.addContact(body) });
        if (t[1] === 'calls') return send(200, state.calls);
        return send(404, {});
      }
      const m = /^\/rest\/1\/testtoken\/([\w.]+)\.json$/.exec(url.pathname);
      if (!m) return send(404, { error: 'INVALID_CREDENTIALS', error_description: 'Invalid request credentials' });
      const method = m[1];
      let params = {};
      try {
        params = /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw || '{}') : arrify(parseNested(new URLSearchParams(raw)));
      } catch { return send(400, { error: 'INVALID_REQUEST' }); }
      state.calls.push({ method, params });
      if (state.failNext && state.failNext.n > 0) {
        state.failNext.n--;
        return send(state.failNext.status, { error: state.failNext.error, error_description: 'injected' });
      }
      if (!methods[method]) return send(404, { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found!' });
      try { send(200, { ...methods[method](params), time: { start: 0, finish: 0 } }); } catch (e) { send(e.status || 400, { error: e.code || 'ERROR', error_description: e.desc || e.message }); }
    });
  });

  const api = {
    state, server, url: '',
    /* сменить стадию сделки (как менеджер в CRM) */
    setStage(dealId, stage) {
      const d = state.deals.get(String(dealId));
      if (!d) throw new Error('нет сделки ' + dealId);
      d.STAGE_ID = stage; d.STAGE_SEMANTIC_ID = semanticOf(stage);
    },
    /* добавить контакт «как из CRM», с произвольным форматом телефона */
    addContact({ name = 'Тест', phone, email }) {
      const id = String(state.nextContact++);
      state.contacts.set(id, { ID: id, NAME: name, PHONE: contactMulti([{ VALUE: phone }], 'PHONE'), EMAIL: contactMulti(email ? [{ VALUE: email }] : [], 'EMAIL') });
      return id;
    },
    /* создать сделку «менеджером»: поля как в crm.deal.add, rows — товарные позиции */
    addDeal(fields, rows) {
      const id = String(methods['crm.deal.add']({ fields }).result);
      if (rows) methods['crm.deal.productrows.set']({ id, rows });
      return id;
    },
    deal: (id) => state.deals.get(String(id)),
    rows: (id) => state.rows.get(String(id)) || [],
    calls: (method) => state.calls.filter((c) => !method || c.method === method),
    failNext(n, status = 503, error = 'QUERY_LIMIT_EXCEEDED') { state.failNext = { n, status, error }; },
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { api.url = `http://127.0.0.1:${server.address().port}/rest/1/testtoken/`; resolve(api); })),
    stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
  };
  return api;
}

module.exports = { createMockBitrix, semanticOf };
