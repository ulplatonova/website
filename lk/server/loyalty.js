'use strict';
/* Программа лояльности: уровни, реестр бонусов (ledger), начисления по сделкам, рефералы, промокоды.
   Все суммы — целые рубли. Идемпотентность обеспечивает UNIQUE(ref_key) в таблице ledger. */
const crypto = require('node:crypto');
const { HttpError, bad } = require('./util');

const LEVELS = [
  { name: 'Гость', from: 0, pct: 3 },
  { name: 'Постоянный клиент', from: 15000, pct: 5 },
  { name: 'Премиум-клиент', from: 40000, pct: 7 }
];
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function levelFor(spent) {
  let idx = 0;
  LEVELS.forEach((l, i) => { if (spent >= l.from) idx = i; });
  return { idx, cur: LEVELS[idx], next: LEVELS[idx + 1] || null };
}
const money = (v) => Math.round(Number(v) || 0);

function createLoyalty(ctx) {
  const { db, bitrix, config } = ctx;
  const now = () => ctx.now();

  /* ---- локальные данные контакта ---- */
  function newRefCode() {
    for (let i = 0; i < 20; i++) {
      let s = 'CH-';
      for (let j = 0; j < 5; j++) s += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
      if (!db.get('SELECT 1 AS x FROM contacts_local WHERE ref_code = ?', s)) return s;
    }
    throw new Error('Не удалось сгенерировать реферальный код');
  }
  const getLocal = (id) => db.get('SELECT * FROM contacts_local WHERE bitrix_contact_id = ?', String(id));
  const findByRefCode = (code) => (typeof code === 'string' && /^CH-[A-Z0-9]{5}$/.test(code) ? db.get('SELECT * FROM contacts_local WHERE ref_code = ?', code) : null);

  function ensureLocal(id, { refCode, name, referrerId } = {}) {
    id = String(id);
    let row = getLocal(id);
    if (row) {
      if (name && name !== row.name) { db.run('UPDATE contacts_local SET name = ? WHERE bitrix_contact_id = ?', name, id); row.name = name; }
      return row;
    }
    for (let i = 0; i < 5; i++) {
      try {
        db.run('INSERT INTO contacts_local(bitrix_contact_id, ref_code, referrer_contact_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
          id, i === 0 && refCode ? refCode : newRefCode(), referrerId || null, name || '', now());
        break;
      } catch (e) { row = getLocal(id); if (row) return row; if (i === 4) throw e; }
    }
    return getLocal(id);
  }

  /* ---- реестр ---- */
  function addLedger(contactId, delta, title, refKey) {
    return db.run('INSERT OR IGNORE INTO ledger(contact_id, delta, title, ref_key, created_at) VALUES (?, ?, ?, ?, ?)', String(contactId), delta, title, refKey, now()).changes === 1;
  }
  const balance = (contactId) => db.get('SELECT COALESCE(SUM(delta), 0) AS b FROM ledger WHERE contact_id = ?', String(contactId)).b;
  const history = (contactId, n = 100) => db.all('SELECT delta, title, created_at FROM ledger WHERE contact_id = ? ORDER BY id DESC LIMIT ?', String(contactId), n)
    .map((r) => ({ date: new Date(r.created_at).toISOString(), title: r.title, delta: r.delta }));
  const spentOf = (deals) => deals.filter((d) => d.STAGE_SEMANTIC_ID === 'S').reduce((s, d) => s + money(d.OPPORTUNITY), 0);

  /* ---- обработка сделки (идемпотентно) ---- */
  async function processDeal(deal, contactDeals) {
    const dealId = String(deal.ID);
    const contactId = deal.CONTACT_ID && Number(deal.CONTACT_ID) ? String(deal.CONTACT_ID) : null;
    if (!contactId) return { processed: false };
    ensureLocal(contactId);
    const sem = deal.STAGE_SEMANTIC_ID;
    db.run(`INSERT INTO deal_state(deal_id, contact_id, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(deal_id) DO UPDATE SET contact_id = excluded.contact_id, updated_at = excluded.updated_at`, dealId, contactId, now());
    if (sem !== 'S' && sem !== 'F') return { processed: false };
    if (db.get('SELECT processed_status FROM deal_state WHERE deal_id = ?', dealId).processed_status === sem) return { processed: true, already: true };

    let spentBefore = 0;
    if (sem === 'S') {
      const deals = contactDeals || await bitrix.listDeals(contactId);
      // Уровень берём по сумме выполненных сделок ДО этой (по порядку номеров сделок)
      spentBefore = spentOf(deals.filter((d) => Number(d.ID) < Number(dealId)));
    }
    const opp = money(deal.OPPORTUNITY);
    db.tx(() => {
      if (sem === 'S') {
        const earn = Math.round(opp * levelFor(spentBefore).cur.pct / 100);
        if (earn > 0) addLedger(contactId, earn, `Начисление за заказ CH-${dealId}`, `deal:${dealId}:earn`);
        // Реферал: награда за первую выполненную сделку приглашённого (ключи ref:<приглашённый>:… гарантируют однократность)
        const local = getLocal(contactId);
        if (local && local.referrer_contact_id) {
          if (config.referralOwnerBonus > 0) addLedger(local.referrer_contact_id, config.referralOwnerBonus, 'Бонус за друга', `ref:${contactId}:owner`);
          if (config.referralFriendBonus > 0) addLedger(contactId, config.referralFriendBonus, 'Бонус за первый заказ по рекомендации', `ref:${contactId}:friend`);
        }
      } else {
        // Сделка проиграна: возвращаем бонусы, списанные нашим сервером при создании заказа (по записи реестра)
        const spend = db.get('SELECT delta FROM ledger WHERE ref_key = ?', `deal:${dealId}:spend`);
        if (spend && spend.delta < 0) addLedger(contactId, -spend.delta, `Возврат бонусов за заказ CH-${dealId}`, `deal:${dealId}:refund`);
      }
      db.run('UPDATE deal_state SET processed_status = ? WHERE deal_id = ?', sem, dealId);
    });
    return { processed: true, already: false };
  }

  /* Сверка: обрабатываем все завершённые сделки клиента по возрастанию номера */
  async function reconcile(contactId, deals) {
    const finished = deals.filter((d) => d.STAGE_SEMANTIC_ID === 'S' || d.STAGE_SEMANTIC_ID === 'F').sort((a, b) => Number(a.ID) - Number(b.ID));
    for (const d of finished) await processDeal(d, deals);
  }

  /* ---- профиль лояльности ---- */
  function loyaltyView(contactId, deals) {
    const spent = spentOf(deals);
    return {
      clientNo: 'CH-' + String(contactId).padStart(6, '0'),
      balance: balance(contactId), spent,
      levels: LEVELS.map((l) => ({ ...l })),
      expiring: null, maxPay: config.maxPayPercent,
      history: history(contactId)
    };
  }

  function shortName(name) {
    const [first, last] = String(name || '').trim().split(/\s+/);
    if (!first) return 'Клиент';
    return last ? `${first} ${last[0].toUpperCase()}.` : first;
  }

  function referralView(contactId) {
    const me = ensureLocal(contactId);
    const rows = db.all('SELECT bitrix_contact_id AS id, name, created_at FROM contacts_local WHERE referrer_contact_id = ? ORDER BY created_at DESC, rowid DESC', String(contactId));
    let rewarded = 0, earned = 0;
    const invited = rows.map((r) => {
      const reward = db.get('SELECT delta FROM ledger WHERE ref_key = ?', `ref:${r.id}:owner`);
      let status = 'registered';
      if (reward) { status = 'rewarded'; rewarded++; earned += reward.delta; }
      else if (db.get("SELECT 1 AS x FROM deal_state WHERE contact_id = ? AND COALESCE(processed_status, '') <> 'F'", r.id)) status = 'ordered';
      return { name: shortName(r.name), status, date: new Date(r.created_at).toISOString(), reward: reward ? reward.delta : 0 };
    });
    return {
      code: me.ref_code, link: `${config.siteUrl}/?ref=${me.ref_code}`,
      ownerBonus: config.referralOwnerBonus, friendBonus: config.referralFriendBonus,
      invited, totals: { invited: invited.length, rewarded, earned }
    };
  }

  /* ---- промокоды ---- */
  async function redeemPromo(contactId, rawCode) {
    ctx.auth.limit([[`promo:${contactId}`, 20, 3600 * 1000]], 'Слишком много попыток. Попробуйте позже.');
    if (typeof rawCode !== 'string' || !rawCode.trim() || rawCode.length > 40) throw bad('Промокод не найден');
    const code = rawCode.trim().toUpperCase();
    const promo = db.get('SELECT * FROM promo_codes WHERE code = ?', code);
    if (promo) {
      if (!promo.active || (promo.expires_at && promo.expires_at < now())) throw bad('Промокод не найден');
      db.tx(() => {
        if (promo.max_uses != null && db.get('SELECT COUNT(*) AS c FROM promo_uses WHERE code = ?', code).c >= promo.max_uses) throw bad('Промокод уже использован');
        const ins = db.run('INSERT OR IGNORE INTO promo_uses(code, contact_id, used_at) VALUES (?, ?, ?)', code, String(contactId), now());
        if (ins.changes !== 1) throw bad('Вы уже использовали этот промокод');
        addLedger(contactId, promo.bonus, `Промокод ${code}`, `promo:${code}:${contactId}`);
      });
      return { ok: true };
    }
    const owner = findByRefCode(code);
    if (!owner) throw bad('Промокод не найден');
    if (String(owner.bitrix_contact_id) === String(contactId)) throw bad('Нельзя использовать собственный код.');
    const me = ensureLocal(contactId);
    if (me.referrer_contact_id) throw bad('Код друга уже применён.');
    const deals = await bitrix.listDeals(String(contactId));
    if (deals.some((d) => d.STAGE_SEMANTIC_ID === 'S')) throw bad('Код друга можно применить только до первого выполненного заказа.');
    db.run('UPDATE contacts_local SET referrer_contact_id = ? WHERE bitrix_contact_id = ? AND referrer_contact_id IS NULL', owner.bitrix_contact_id, String(contactId));
    return { ok: true };
  }

  return { LEVELS, levelFor, newRefCode, findByRefCode, getLocal, ensureLocal, addLedger, balance, history, spentOf, processDeal, reconcile, loyaltyView, referralView, redeemPromo, shortName };
}

module.exports = { createLoyalty, LEVELS, levelFor };
