'use strict';
/* SMS-провайдеры: console (только для разработки), memory (тесты), smsru.
   ВАЖНО: провайдер smsru написан по документации sms.ru и НЕ проверялся на живом сервисе. */

function createSms(config, { fetchImpl = fetch, logger } = {}) {
  if (config.smsProvider === 'memory') {
    const messages = [];
    return {
      name: 'memory',
      async send(phone, text) { messages.push({ phone, text, at: Date.now() }); },
      /* для тестов: последний код, отправленный на номер */
      lastCode(phone) {
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].phone === phone) { const m = /\d{4}/.exec(messages[i].text); return m && m[0]; }
        return null;
      },
      count: (phone) => messages.filter((m) => m.phone === phone).length,
      messages
    };
  }
  if (config.smsProvider === 'smsru') {
    return {
      name: 'smsru',
      async send(phone, text) {
        const to = phone.replace(/\D/g, ''); // 7XXXXXXXXXX
        const url = `${config.smsruBase}/sms/send?api_id=${encodeURIComponent(config.smsruApiId)}&to=${to}&msg=${encodeURIComponent(text)}&json=1`;
        let data;
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
          data = await res.json();
        } catch { throw new Error('sms.ru недоступен'); }
        const item = data && data.sms && data.sms[to];
        // 100 — запрос принят и сообщение поставлено в очередь
        if (!data || Number(data.status_code) !== 100 || (item && Number(item.status_code) !== 100)) {
          throw new Error('sms.ru отклонил отправку, status_code=' + (item ? item.status_code : data && data.status_code));
        }
      }
    };
  }
  return {
    name: 'console',
    async send(phone, text) {
      // ТОЛЬКО ДЛЯ РАЗРАБОТКИ: код пишется в лог. В продакшене используйте SMS_PROVIDER=smsru.
      logger && logger.warn(`[SMS console, ТОЛЬКО ДЛЯ РАЗРАБОТКИ] ${phone}: ${text}`);
    }
  };
}

module.exports = { createSms };
