'use strict';
/* Подписки на поддерживающую уборку: график визитов и создание сделок на ближайшие визиты. */
const crypto = require('node:crypto');
const pricing = require('../pricing.js');
const { bad, HttpError, moscowDate, addDays, addMonths, weekdayOf, isValidDate, plainObject } = require('./util');
const { validateState } = require('./orders');

const SUB_ID_RE = /^s_[0-9a-f]{8}$/;
const MAX_OPEN_SUBS = 10;

/* Даты визитов: первая дата >= startDate с нужным днём недели, дальше каждые 7 (freq=4) или 14 (freq=2) дней, строго до endDate */
function visitDates(startDate, weekday, freq, months) {
  const end = addMonths(startDate, months);
  let d = startDate;
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  const step = freq === 4 ? 7 : 14;
  const out = [];
  for (; d < end; d = addDays(d, step)) out.push(d);
  return out;
}

function createSubscriptions(ctx) {
  const { db, bitrix, config } = ctx;
  const F = config.fields;
  const now = () => ctx.now();

  function view(row) {
    const today = moscowDate(now());
    let status = row.status;
    if ((status === 'active' || status === 'paused') && row.end_date < today) status = 'finished';
    const dates = status === 'cancelled' || status === 'finished' ? [] : visitDates(row.start_date, row.weekday, row.freq, row.months).filter((d) => d >= today).slice(0, 4);
    return {
      id: row.id, status, service: row.service, area: row.area, tariff: row.tariff, freq: row.freq, months: row.months, weekday: row.weekday,
      slot: row.slot, address: row.address, startDate: row.start_date, endDate: row.end_date,
      base: row.base, discountPerCleaning: row.discount_per_cleaning, perCleaning: row.per_cleaning, perMonth: row.per_month, periodTotal: row.period_total,
      nextVisits: dates, paymentUrl: status === 'pending_payment' ? row.payment_url : null, createdAt: new Date(row.created_at).toISOString()
    };
  }
  const own = (contactId, id) => {
    if (typeof id !== 'string' || !SUB_ID_RE.test(id)) return null;
    return db.get('SELECT * FROM subscriptions WHERE id = ? AND contact_id = ?', id, String(contactId)) || null;
  };

  function list(contactId) {
    return { subscriptions: db.all('SELECT * FROM subscriptions WHERE contact_id = ? ORDER BY created_at DESC, rowid DESC', String(contactId)).map(view) };
  }

  async function create(contactId, body) {
    if (!plainObject(body)) throw bad('Некорректный запрос.');
    const state = validateState(body.state, { subscription: true });
    state.extras = {}; // допуслуги в абонемент не входят (цена абонемента фиксирована)
    const r = pricing.compute(state);
    if (r.individual || !r.subscription || r.subscription.individual) throw bad('Для такой площади подписка рассчитывается индивидуально. Свяжитесь с менеджером.');
    if (!Number.isInteger(body.weekday) || body.weekday < 1 || body.weekday > 7) throw bad('Выберите день недели.');
    if (typeof body.slot !== 'string' || !config.slots.includes(body.slot)) throw bad('Выберите время из списка.');
    const address = typeof body.address === 'string' ? body.address.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : '';
    if (!address) throw bad('Укажите адрес.');
    if (!isValidDate(body.startDate)) throw bad('Укажите дату начала в формате ГГГГ-ММ-ДД.');
    if (body.startDate < addDays(moscowDate(now()), 1)) throw bad('Подписка может начаться не раньше завтрашнего дня.');
    if (body.startDate > addDays(moscowDate(now()), 366)) throw bad('Дата начала слишком далеко.');
    let comment = '';
    if (body.comment !== undefined && body.comment !== null) {
      if (typeof body.comment !== 'string') throw bad('Некорректный комментарий.');
      comment = body.comment.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1000);
    }
    const open = db.get("SELECT COUNT(*) AS c FROM subscriptions WHERE contact_id = ? AND status IN ('active','paused','pending_payment')", String(contactId)).c;
    if (open >= MAX_OPEN_SUBS) throw bad('Слишком много действующих подписок.');

    const s = r.subscription;
    const id = 's_' + crypto.randomBytes(4).toString('hex');
    const status = ctx.payments.enabled ? 'pending_payment' : 'active';
    db.run(`INSERT INTO subscriptions(id, contact_id, status, service, area, tariff, freq, months, weekday, slot, address, comment, start_date, end_date,
              base, discount_per_cleaning, per_cleaning, per_month, period_total, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, String(contactId), status, state.service, r.area, state.tariff, s.freq, s.months, body.weekday, body.slot, address, comment, body.startDate,
    addMonths(body.startDate, s.months), r.base, s.discountPerCleaning, s.perCleaning, s.perMonth, s.periodTotal, now());

    if (status === 'pending_payment') {
      try {
        const contact = bitrix.normalizeContact(await bitrix.getContact(contactId));
        const row = db.get('SELECT * FROM subscriptions WHERE id = ?', id);
        const pay = await ctx.payments.createSubscriptionPayment(view(row), contact);
        db.run('UPDATE subscriptions SET payment_id = ?, payment_url = ? WHERE id = ?', pay.paymentId, pay.url, id);
      } catch (e) {
        db.run('DELETE FROM subscriptions WHERE id = ?', id);
        ctx.logger.error('Платёж подписки:', e.message);
        throw new HttpError(502, 'Не удалось создать платёж. Попробуйте позже.');
      }
    }
    const subscription = view(db.get('SELECT * FROM subscriptions WHERE id = ?', id));
    return { subscription, paymentUrl: subscription.paymentUrl };
  }

  function act(contactId, id, body) {
    const row = own(contactId, id);
    if (!row) throw new HttpError(404, 'Подписка не найдена.');
    if (!plainObject(body) || !['pause', 'resume', 'cancel'].includes(body.action)) throw bad('Некорректное действие.');
    const v = view(row);
    const next = { pause: ['active', 'paused'], resume: ['paused', 'active'] };
    let to;
    if (body.action === 'cancel') {
      if (!['active', 'paused', 'pending_payment'].includes(v.status)) throw bad('Эту подписку нельзя отменить.');
      to = 'cancelled';
    } else {
      if (v.status !== next[body.action][0]) throw bad('Это действие сейчас недоступно.');
      to = next[body.action][1];
    }
    db.run('UPDATE subscriptions SET status = ? WHERE id = ?', to, id);
    return { subscription: view(db.get('SELECT * FROM subscriptions WHERE id = ?', id)) };
  }

  /* Оплата прошла (вебхук ЮKassa после перепроверки платежа) */
  function activatePaid(subId, paymentId) {
    if (!SUB_ID_RE.test(String(subId))) return false;
    return db.run("UPDATE subscriptions SET status = 'active' WHERE id = ? AND status = 'pending_payment' AND payment_id = ?", subId, paymentId).changes === 1;
  }
  const findByPaymentId = (paymentId) => db.get('SELECT * FROM subscriptions WHERE payment_id = ?', paymentId);

  /* Для каждой активной подписки создаём сделки на визиты в окне [сегодня, сегодня+daysAhead].
     Строка в sub_visits (UNIQUE sub_id+date) «занимается» до создания сделки, поэтому повтор не создаст дубль. */
  async function materializeVisits({ daysAhead = 7 } = {}) {
    const today = moscowDate(now());
    const until = addDays(today, daysAhead);
    const out = { created: 0, errors: 0 };
    const subs = db.all("SELECT * FROM subscriptions WHERE status = 'active'");
    for (const sub of subs) {
      if (sub.end_date < today) { db.run("UPDATE subscriptions SET status = 'finished' WHERE id = ?", sub.id); continue; }
      const all = visitDates(sub.start_date, sub.weekday, sub.freq, sub.months);
      for (const date of all.filter((d) => d >= today && d <= until)) {
        if (db.run('INSERT OR IGNORE INTO sub_visits(sub_id, date, created_at) VALUES (?, ?, ?)', sub.id, date, now()).changes !== 1) continue;
        try {
          const dealId = await createVisitDeal(sub, date, all.indexOf(date) + 1, all.length);
          db.run('UPDATE sub_visits SET deal_id = ? WHERE sub_id = ? AND date = ?', dealId, sub.id, date);
          out.created++;
        } catch (e) {
          db.run('DELETE FROM sub_visits WHERE sub_id = ? AND date = ? AND deal_id IS NULL', sub.id, date); // повторим при следующем запуске
          ctx.logger.error(`Материализация ${sub.id} ${date}:`, e.message);
          out.errors++;
        }
      }
    }
    return out;
  }

  async function createVisitDeal(sub, date, n, total) {
    const name = `${pricing.services[sub.service].full} (подписка), ${sub.area} м²`;
    const comments = [`Визит ${n} из ${total} по подписке ${sub.id}`, `Услуга: ${pricing.services[sub.service].full}`,
      `Тариф: ${pricing.tariffs.find((t) => t.id === sub.tariff).title}`, `Площадь: ${sub.area} м²`,
      `Стоимость визита: ${pricing.money(sub.per_cleaning)} (скидка по подписке ${pricing.money(sub.discount_per_cleaning)})`,
      `Адрес: ${sub.address}`, `Дата и время: ${date}, ${sub.slot}`];
    if (sub.comment) comments.push(`Комментарий клиента: ${sub.comment}`);
    const { deal } = await ctx.orders.createDealRecord({
      contactId: sub.contact_id, title: `Подписка: поддерживающая уборка, ${sub.area} м²`, opportunity: sub.per_cleaning,
      rows: [{ PRODUCT_NAME: name, PRICE: sub.per_cleaning, QUANTITY: 1, CUSTOMIZED: 'Y' }], comments: comments.join('\n'), dateCreated: new Date(now()).toISOString(),
      uf: { [F.service]: sub.service, [F.tariff]: sub.tariff, [F.area]: sub.area, [F.address]: sub.address, [F.slot]: sub.slot, [F.visitDate]: date, [F.bonusSpent]: 0, [F.extras]: '{}', [F.subId]: sub.id }
    });
    return deal.ID;
  }

  return { list, create, act, activatePaid, findByPaymentId, materializeVisits, visitDates };
}

module.exports = { createSubscriptions, visitDates };
