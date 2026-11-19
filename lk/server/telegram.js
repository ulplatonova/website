'use strict';
/* Telegram: привязка аккаунта, вход через бота, уведомления о статусах заказов.
   Токен бота есть только в URL запроса к API Telegram, в логи и ошибки он не попадает. */
const { bad, HttpError, sha256, randomHex, safeEqual } = require('./util');

const TTL = 10 * 60 * 1000;
const TEXTS = {
  new: (id) => `Заказ CH-${id} принят. Мы свяжемся с вами для подтверждения.`,
  work: (id) => `Мастер приступил к заказу CH-${id}.`,
  done: (id) => `Заказ CH-${id} выполнен. Спасибо, что выбрали CleanHub! Бонусы за заказ начислены в кабинете.`,
  cancel: (id) => `Заказ CH-${id} отменён. Если это ошибка, напишите нам.`
};

function createTelegram(ctx, { fetchImpl = fetch } = {}) {
  const { db, config } = ctx;
  const now = () => ctx.now();
  const enabled = !!(config.telegramBotToken && config.telegramBotUsername);

  async function sendMessage(chatId, text, extra = {}) {
    if (!config.telegramBotToken) return false;
    try {
      const res = await fetchImpl(`${config.telegramApiBase}/bot${config.telegramBotToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra }), signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { ctx.logger.warn('Telegram sendMessage: HTTP', res.status); return false; }
      return true;
    } catch { ctx.logger.warn('Telegram sendMessage: сеть недоступна'); return false; }
  }
  const cabinetButton = () => ({ reply_markup: { inline_keyboard: [[{ text: 'Открыть кабинет', url: config.cabinetUrl }]] } });

  function requireEnabled() { if (!enabled) throw new HttpError(503, 'Telegram временно недоступен.'); }

  /* ---- привязка из кабинета ---- */
  function createLinkToken(contactId) {
    requireEnabled();
    ctx.auth.limit([[`tglink:${contactId}`, 20, 3600 * 1000]], 'Слишком много запросов. Попробуйте позже.');
    db.run("DELETE FROM tg_tokens WHERE kind = 'link' AND contact_id = ?", String(contactId));
    const token = randomHex(16);
    db.run("INSERT INTO tg_tokens(token_hash, kind, contact_id, created_at, expires_at) VALUES (?, 'link', ?, ?, ?)", sha256(token), String(contactId), now(), now() + TTL);
    return { url: `https://t.me/${config.telegramBotUsername}?start=link_${token}`, token };
  }
  function status(contactId, token) {
    if (token !== undefined && (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token))) throw bad('Некорректный токен.');
    const row = ctx.loyalty.ensureLocal(contactId);
    return { connected: !!row.tg_chat_id, username: row.tg_username || '' };
  }
  function unlink(contactId) {
    db.run("UPDATE contacts_local SET tg_chat_id = NULL, tg_username = '' WHERE bitrix_contact_id = ?", String(contactId));
    return { ok: true };
  }

  /* ---- вебхук бота ---- */
  const verifySecret = (header) => !!config.telegramWebhookSecret && safeEqual(config.telegramWebhookSecret, header || '');

  async function handleUpdate(update) {
    const msg = update && update.message;
    if (!msg || !msg.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return;
    const chatId = String(msg.chat.id);
    const m = /^\/start(?:@\w+)?(?:\s+(link|login)_([0-9a-f]{32}))?\s*$/.exec(msg.text.trim());
    if (!m || !m[1]) {
      await sendMessage(chatId, 'Здравствуйте! Это бот CleanHub: он присылает статусы заказов и помогает войти в кабинет.', cabinetButton());
      return;
    }
    const [, kind, token] = m;
    const h = sha256(token);
    if (kind === 'link') {
      const row = db.get("SELECT * FROM tg_tokens WHERE token_hash = ? AND kind = 'link'", h);
      if (!row || row.expires_at < now()) { await sendMessage(chatId, 'Ссылка устарела. Получите новую в личном кабинете.', cabinetButton()); return; }
      db.tx(() => {
        db.run("UPDATE contacts_local SET tg_chat_id = NULL, tg_username = '' WHERE tg_chat_id = ?", chatId); // чат принадлежит одному клиенту
        ctx.loyalty.ensureLocal(row.contact_id);
        db.run('UPDATE contacts_local SET tg_chat_id = ?, tg_username = ? WHERE bitrix_contact_id = ?', chatId, String((msg.from && msg.from.username) || '').slice(0, 64), row.contact_id);
        db.run('DELETE FROM tg_tokens WHERE token_hash = ?', h); // одноразовый
      });
      await sendMessage(chatId, 'Telegram подключён. Сюда будут приходить уведомления о заказах.', cabinetButton());
      return;
    }
    const owner = db.get('SELECT bitrix_contact_id AS id FROM contacts_local WHERE tg_chat_id = ?', chatId);
    if (!owner) { await sendMessage(chatId, 'Сначала войдите по SMS и подключите Telegram в профиле.', cabinetButton()); return; }
    if (ctx.auth.tgLoginComplete(token, owner.id)) await sendMessage(chatId, 'Готово! Вернитесь на сайт: вход выполнен.');
    else await sendMessage(chatId, 'Ссылка для входа устарела. Начните вход на сайте заново.', cabinetButton());
  }

  /* ---- уведомления о статусах ---- */
  async function notifyStatus(contactId, dealId, st) {
    const text = TEXTS[st];
    if (!text) return;
    const row = db.get('SELECT tg_chat_id, notify FROM contacts_local WHERE bitrix_contact_id = ?', String(contactId));
    if (!row || !row.tg_chat_id) return;
    let notify = {};
    try { notify = JSON.parse(row.notify); } catch { /* значения по умолчанию */ }
    if (notify.tgOrders === false) return;
    await sendMessage(row.tg_chat_id, text(dealId), cabinetButton());
  }

  return { enabled, sendMessage, createLinkToken, status, unlink, verifySecret, handleUpdate, notifyStatus };
}

module.exports = { createTelegram };
