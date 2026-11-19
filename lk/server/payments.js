'use strict';
/* Платежи за подписку. Провайдер none — платежи выключены, подписка сразу активна.
   ВНИМАНИЕ: адаптер yookassa написан по документации ЮKassa API v3 и НЕ ПРОВЕРЕН на реальном API
   (нет доступа к магазину). Перед включением проверьте его в тестовом магазине ЮKassa.
   Не реализованы: чек по 54-ФЗ (receipt) и автоматические рекуррентные списания следующих месяцев. */

function createPayments(config, { fetchImpl = fetch } = {}) {
  if (config.paymentsProvider !== 'yookassa') {
    return {
      name: 'none', enabled: false,
      async createSubscriptionPayment() { throw new Error('Платежи отключены'); },
      async handleWebhook() { return null; }
    };
  }
  const auth = 'Basic ' + Buffer.from(`${config.yookassaShopId}:${config.yookassaSecretKey}`).toString('base64');
  const api = config.yookassaApiBase;

  return {
    name: 'yookassa', enabled: true,
    /* UNTESTED against the real YooKassa API */
    async createSubscriptionPayment(sub, contact) {
      const res = await fetchImpl(`${api}/payments`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json', 'Idempotence-Key': `sub-${sub.id}` },
        body: JSON.stringify({
          amount: { value: sub.perMonth.toFixed(2), currency: 'RUB' },
          capture: true,
          confirmation: { type: 'redirect', return_url: config.cabinetUrl },
          save_payment_method: true,
          description: `Подписка CleanHub ${sub.id}: первый месяц`.slice(0, 128),
          metadata: { subscription_id: sub.id, contact_id: contact && contact.id }
        }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json().catch(() => ({}));
      const url = data && data.confirmation && data.confirmation.confirmation_url;
      if (!res.ok || !data.id || !url) throw new Error('ЮKassa отклонила создание платежа, HTTP ' + res.status);
      return { paymentId: String(data.id), url };
    },
    /* Телу вебхука не доверяем: берём только id платежа и перепроверяем его запросом GET /payments/{id}. UNTESTED. */
    async handleWebhook(body) {
      const id = body && body.object && body.object.id;
      if (body && body.event !== 'payment.succeeded') return { event: String(body.event || ''), subscriptionId: null };
      if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return null;
      const res = await fetchImpl(`${api}/payments/${id}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const p = await res.json().catch(() => null);
      if (!p || p.id !== id || p.status !== 'succeeded' || p.paid !== true) return null;
      return { event: 'succeeded', paymentId: id, subscriptionId: (p.metadata && p.metadata.subscription_id) || null, amount: p.amount && p.amount.value };
    }
  };
}

module.exports = { createPayments };
