'use strict';
/* Заказы: список из сделок Битрикс24, создание сделки, обработка событий Битрикса. Цены считает только сервер. */
const crypto = require('node:crypto');
const pricing = require('../pricing.js');
const { bad, HttpError, moscowDate, isValidDate, plainObject } = require('./util');
const { levelFor } = require('./loyalty');

const money = (v) => Math.round(Number(v) || 0);
const fmt = (n) => pricing.money(n);
const clean = (s, max) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const EXTRA_BY_ID = Object.fromEntries(pricing.extras.map((x) => [x.id, x]));

/* Проверка входного state (строго: лишнее не молчим). Возвращает чистый state для pricing.compute. */
function validateState(state, { subscription = false } = {}) {
  if (!plainObject(state)) throw bad('Не указаны параметры уборки.');
  if (typeof state.service !== 'string' || !pricing.services[state.service]) throw bad('Выберите вид уборки.');
  if (!pricing.tariffs.some((t) => t.id === state.tariff)) throw bad('Выберите тариф.');
  const area = Number(state.area);
  if (typeof state.area !== 'number' || !Number.isFinite(area) || area < 1 || area > pricing.config.areaMax) throw bad(`Площадь должна быть от 1 до ${pricing.config.areaMax} м².`);
  const extras = {};
  if (state.extras !== undefined && state.extras !== null) {
    if (!plainObject(state.extras)) throw bad('Некорректный список дополнительных услуг.');
    for (const [id, qty] of Object.entries(state.extras)) {
      const x = EXTRA_BY_ID[id];
      if (!x) throw bad('Неизвестная дополнительная услуга.');
      if (!Number.isInteger(qty) || qty < 0 || qty > (x.toggle ? 1 : x.max || 99)) throw bad(`Некорректное количество: ${x.title}.`);
      if (qty) extras[id] = qty;
    }
  }
  const out = { service: state.service, area: Math.round(area), tariff: state.tariff, extras };
  if (subscription) {
    if (!pricing.subscription.enabled || state.service !== pricing.subscription.service) throw bad('Подписка доступна только на поддерживающую уборку.');
    if (!pricing.subscription.frequencies.includes(state.freq)) throw bad('Выберите частоту уборок: 2 или 4 раза в месяц.');
    if (pricing.subscription.discounts[state.months] == null) throw bad('Выберите срок подписки: 3, 6 или 12 месяцев.');
    out.freq = state.freq; out.months = state.months;
  }
  return out;
}

/* Товарные позиции по расчёту: тариф + допуслуги (бесплатно включённые и «по фото» не добавляем) */
function buildRows(r) {
  const rows = [{ PRODUCT_NAME: `${r.serviceTitle}, ${r.area} м²${r.individual ? ' (ориентировочно)' : ''}`, PRICE: r.base, QUANTITY: 1, CUSTOMIZED: 'Y' }];
  for (const l of r.lines) {
    if (l.quote || l.paid <= 0) continue;
    rows.push({ PRODUCT_NAME: l.title, PRICE: Math.round(l.cost / l.paid), QUANTITY: l.paid, CUSTOMIZED: 'Y' });
  }
  return rows;
}

function buildComment(r, { total, bonusSpend, address, date, slot, comment, subId }) {
  const lines = [subId ? `Визит по подписке ${subId}` : 'Заказ из личного кабинета', `Услуга: ${r.serviceTitle}`,
    `Тариф: ${r.individual ? 'индивидуальный расчёт' : r.tariffTitle}`, `Площадь: ${r.area} м²`];
  const paidExtras = r.lines.filter((l) => !l.quote && l.qty > 0).map((l) => `${l.title} × ${l.qty}${l.included ? ` (включено в тариф: ${l.included})` : ''}`);
  if (paidExtras.length) lines.push('Дополнительные услуги: ' + paidExtras.join('; '));
  const quotes = r.lines.filter((l) => l.quote).map((l) => l.title);
  if (quotes.length) lines.push('Оценить по фото: ' + quotes.join('; '));
  if (r.individual) lines.push('ИНДИВИДУАЛЬНЫЙ РАСЧЁТ, менеджеру уточнить цену');
  lines.push(`Стоимость: ${r.individual || r.totalApprox ? 'от ' : ''}${fmt(total)}`);
  if (bonusSpend) lines.push(`Бонусами: ${fmt(bonusSpend)}`);
  lines.push(`К оплате: ${fmt(total - bonusSpend)}`);
  lines.push(`Адрес: ${address}`, `Дата и время: ${date}, ${slot}`);
  if (comment) lines.push(`Комментарий клиента: ${comment}`);
  return lines.join('\n');
}

function createOrders(ctx) {
  const { db, bitrix, config, loyalty } = ctx;
  const F = config.fields;
  const now = () => ctx.now();

  /* Общая часть: создать сделку + товарные позиции + запись deal_state. Возвращает объект сделки. */
  async function createDealRecord({ contactId, title, opportunity, rows, comments, uf, dateCreated }) {
    const fields = {
      TITLE: title, CONTACT_ID: Number(contactId), CATEGORY_ID: config.bitrixCategoryId, STAGE_ID: config.bitrixStageNew,
      SOURCE_ID: 'WEB', OPPORTUNITY: opportunity, CURRENCY_ID: 'RUB',
      IS_MANUAL_OPPORTUNITY: 'Y', // сумма сделки не должна пересчитываться по товарным позициям (из неё вычтены бонусы)
      COMMENTS: comments, ...uf
    };
    if (config.bitrixAssignedById) fields.ASSIGNED_BY_ID = config.bitrixAssignedById;
    const id = await bitrix.createDeal(fields);
    try { await bitrix.setProductRows(id, rows); } catch (e) { ctx.logger.error(`Сделка ${id}: не удалось записать товарные позиции:`, e.message); }
    db.run(`INSERT INTO deal_state(deal_id, contact_id, notified_status, updated_at) VALUES (?, ?, 'new', ?)
            ON CONFLICT(deal_id) DO UPDATE SET contact_id = excluded.contact_id`, id, String(contactId), now());
    return { deal: { ID: id, ...fields, STAGE_SEMANTIC_ID: 'P', DATE_CREATE: dateCreated }, rows };
  }

  async function createOrder(contactId, body) {
    if (!plainObject(body)) throw bad('Некорректный запрос.');
    const state = validateState(body.state);
    const address = typeof body.address === 'string' ? clean(body.address, 300) : '';
    if (!address) throw bad('Укажите адрес.');
    if (!isValidDate(body.date)) throw bad('Укажите дату в формате ГГГГ-ММ-ДД.');
    if (body.date < moscowDate(now())) throw bad('Дата не может быть в прошлом.');
    if (typeof body.slot !== 'string' || !config.slots.includes(body.slot)) throw bad('Выберите время из списка.');
    const comment = body.comment === undefined || body.comment === null ? '' : (typeof body.comment === 'string' ? clean(body.comment, 1000) : null);
    if (comment === null) throw bad('Некорректный комментарий.');
    const bonusSpend = body.bonusSpend === undefined || body.bonusSpend === null ? 0 : body.bonusSpend;
    if (!Number.isInteger(bonusSpend) || bonusSpend < 0) throw bad('Некорректная сумма бонусов.');

    const r = pricing.compute(state);   // цены только отсюда; числа клиента игнорируются
    const total = money(r.total);
    if (total <= 0) throw bad('Не удалось рассчитать стоимость заказа.');
    const maxByPercent = Math.floor(total * config.maxPayPercent / 100);
    if (bonusSpend > maxByPercent) throw bad(`Бонусами можно оплатить не более ${config.maxPayPercent}% заказа (${fmt(maxByPercent)}).`);

    // Резервируем списание атомарно (баланс + запись в реестре в одной транзакции), затем создаём сделку
    const reserveKey = bonusSpend ? 'order-pending:' + crypto.randomUUID() : null;
    if (bonusSpend) {
      db.tx(() => {
        if (bonusSpend > loyalty.balance(contactId)) throw bad('Недостаточно бонусов на балансе.');
        loyalty.addLedger(contactId, -bonusSpend, 'Списание в заказе', reserveKey);
      });
    }
    let created;
    try {
      created = await createDealRecord({
        contactId, title: `Заказ из кабинета: ${r.serviceTitle}, ${r.area} м²`, opportunity: total - bonusSpend, rows: buildRows(r),
        comments: buildComment(r, { total, bonusSpend, address, date: body.date, slot: body.slot, comment }),
        dateCreated: new Date(now()).toISOString(),
        uf: {
          [F.service]: state.service, [F.tariff]: r.individual ? '' : state.tariff, [F.area]: r.area, [F.address]: address, [F.slot]: body.slot,
          [F.visitDate]: body.date, [F.bonusSpent]: bonusSpend, [F.extras]: JSON.stringify(state.extras)
        }
      });
    } catch (e) {
      if (reserveKey) db.run('DELETE FROM ledger WHERE ref_key = ?', reserveKey);
      ctx.logger.error('Создание сделки:', e.message);
      throw new HttpError(502, 'Не удалось оформить заказ. Попробуйте позже.');
    }
    const dealId = created.deal.ID;
    if (reserveKey) db.run('UPDATE ledger SET ref_key = ?, title = ? WHERE ref_key = ?', `deal:${dealId}:spend`, `Списание в заказе CH-${dealId}`, reserveKey);
    ctx.telegram.notifyStatus(contactId, dealId, 'new').catch(() => {});
    let spent = 0;
    try { spent = loyalty.spentOf(await bitrix.listDeals(String(contactId))); } catch { /* прогноз бонусов не критичен */ }
    return { order: mapOrder(created.deal, created.rows, { earnedByKey: {}, spent }) };
  }

  /* ---- маппинг сделки в заказ кабинета ---- */
  function parseJson(s) { try { const v = JSON.parse(s); return plainObject(v) ? v : {}; } catch { return {}; } }

  function mapOrder(deal, rows, { earnedByKey, spent }) {
    const id = String(deal.ID);
    const status = bitrix.mapStatus(deal);
    const svcId = deal[F.service] && pricing.services[deal[F.service]] ? deal[F.service] : null;
    const extras = parseJson(deal[F.extras]);
    const tariffId = deal[F.tariff];
    const tariff = pricing.tariffs.find((t) => t.id === tariffId);
    const area = Number(deal[F.area]) || 0;
    let items = (rows || []).map((r) => ({ name: String(r.PRODUCT_NAME || r.NAME || ''), qty: Number(r.QUANTITY) || 1, price: money(r.PRICE) }));
    if (!items.length && svcId && area) {
      try { items = buildRows(pricing.compute({ service: svcId, area, tariff: tariffId, extras })).map((r) => ({ name: r.PRODUCT_NAME, qty: r.QUANTITY, price: r.PRICE })); } catch { items = []; }
    }
    const opp = money(deal.OPPORTUNITY);
    let bonusEarned = 0;
    if (status !== 'cancel') {
      const e = earnedByKey[`deal:${id}:earn`];
      bonusEarned = e !== undefined ? e : Math.round(opp * levelFor(spent).cur.pct / 100);
    }
    const commentMatch = /^Комментарий клиента: (.*)$/m.exec(deal.COMMENTS || '');
    return {
      id: 'CH-' + id, dealId: Number(id),
      date: String(deal[F.visitDate] || deal.DATE_CREATE || '').slice(0, 10), status,
      title: svcId ? pricing.services[svcId].full : String(deal.TITLE || 'Заказ'),
      tariff: tariff ? tariff.title : '', area, svc: svcId || '', items, total: opp, bonusSpent: money(deal[F.bonusSpent]),
      bonusEarned, address: String(deal[F.address] || ''), slot: String(deal[F.slot] || ''),
      comment: commentMatch ? commentMatch[1] : '', sub: deal[F.subId] ? String(deal[F.subId]) : null, extras
    };
  }

  const earnedMap = (contactId) => Object.fromEntries(db.all("SELECT ref_key, delta FROM ledger WHERE contact_id = ? AND ref_key LIKE 'deal:%:earn'", String(contactId)).map((r) => [r.ref_key, r.delta]));

  /* Загрузка сделок клиента + сверка бонусов. Используется в /orders и /me. */
  async function loadClientDeals(contactId) {
    const deals = await bitrix.listDeals(String(contactId));
    await loyalty.reconcile(String(contactId), deals);
    return deals;
  }

  async function listOrders(contactId) {
    const deals = await loadClientDeals(contactId);
    const rowsByDeal = await bitrix.getProductRowsBatch(deals.map((d) => d.ID));
    const ctxData = { earnedByKey: earnedMap(contactId), spent: loyalty.spentOf(deals) };
    return { orders: deals.map((d) => mapOrder(d, rowsByDeal[String(d.ID)], ctxData)) };
  }

  /* ---- события Битрикса ---- */
  async function handleDealEvent(dealId) {
    const deal = await bitrix.getDeal(dealId);
    if (!deal || !deal.CONTACT_ID || !Number(deal.CONTACT_ID)) return;
    await loyalty.processDeal(deal);
    const status = bitrix.mapStatus(deal);
    // Атомарно «занимаем» уведомление: параллельные/повторные события не продублируют сообщение
    const claim = db.run('UPDATE deal_state SET notified_status = ? WHERE deal_id = ? AND (notified_status IS NULL OR notified_status <> ?)', status, String(deal.ID), status);
    if (claim.changes === 1) await ctx.telegram.notifyStatus(String(deal.CONTACT_ID), String(deal.ID), status);
  }

  return { createOrder, listOrders, loadClientDeals, mapOrder, createDealRecord, handleDealEvent, validateState, buildRows, buildComment };
}

module.exports = { createOrders, validateState, buildRows, buildComment };
