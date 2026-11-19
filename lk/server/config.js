'use strict';
/* Конфигурация из переменных окружения. Секретов по умолчанию нет. */

const SLOTS = ['09:00–11:00', '11:00–13:00', '13:00–15:00', '15:00–17:00', '17:00–19:00'];

const FIELD_DEFAULTS = {
  service: 'UF_CRM_CH_SERVICE',
  tariff: 'UF_CRM_CH_TARIFF',
  area: 'UF_CRM_CH_AREA',
  address: 'UF_CRM_CH_ADDRESS',
  slot: 'UF_CRM_CH_SLOT',
  visitDate: 'UF_CRM_CH_VISIT_DATE',
  bonusSpent: 'UF_CRM_CH_BONUS_SPENT',
  extras: 'UF_CRM_CH_EXTRAS',
  subId: 'UF_CRM_CH_SUB_ID',
  refCode: 'UF_CRM_CH_REFCODE' // поле контакта
};

function int(env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Переменная ${name} должна быть целым числом от ${min} до ${max}.`);
  return n;
}
const str = (env, name, def = '') => (env[name] === undefined ? def : String(env[name]).trim());
const bool = (env, name, def = false) => (env[name] === undefined || env[name] === '' ? def : ['1', 'true', 'yes'].includes(String(env[name]).toLowerCase()));

function loadConfig(env = process.env) {
  const isTest = env.NODE_ENV === 'test';
  const cfg = {};
  cfg.env = env.NODE_ENV || 'development';
  cfg.isTest = isTest;
  cfg.port = int(env, 'PORT', 8080, { min: 0, max: 65535 });
  cfg.publicUrl = str(env, 'PUBLIC_URL', 'http://localhost:' + cfg.port).replace(/\/+$/, '');
  cfg.cabinetUrl = str(env, 'CABINET_URL', 'https://cleanhub24.ru/lk');
  cfg.siteUrl = str(env, 'SITE_URL', 'https://cleanhub24.ru').replace(/\/+$/, '');
  cfg.allowedOrigins = str(env, 'ALLOWED_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean);
  cfg.trustProxy = bool(env, 'TRUST_PROXY', false);
  cfg.dbPath = str(env, 'DB_PATH', './data/lk.sqlite');
  cfg.logLevel = str(env, 'LOG_LEVEL', isTest ? 'silent' : 'info');

  cfg.bitrixWebhookUrl = str(env, 'BITRIX_WEBHOOK_URL');
  if (!cfg.bitrixWebhookUrl && !isTest) {
    throw new Error('Не задан BITRIX_WEBHOOK_URL. Укажите адрес входящего вебхука Битрикс24 вида https://<портал>.bitrix24.ru/rest/<id>/<токен>/ (см. README, раздел «Настройка Битрикс24»).');
  }
  if (cfg.bitrixWebhookUrl && !/^https?:\/\//.test(cfg.bitrixWebhookUrl)) throw new Error('BITRIX_WEBHOOK_URL должен начинаться с https://');
  if (cfg.bitrixWebhookUrl && !cfg.bitrixWebhookUrl.endsWith('/')) cfg.bitrixWebhookUrl += '/';
  cfg.bitrixEventToken = str(env, 'BITRIX_EVENT_TOKEN');
  cfg.bitrixCategoryId = int(env, 'BITRIX_CATEGORY_ID', 0, { min: 0 });
  cfg.bitrixStageNew = str(env, 'BITRIX_STAGE_NEW', cfg.bitrixCategoryId ? `C${cfg.bitrixCategoryId}:NEW` : 'NEW');
  cfg.bitrixWorkStages = str(env, 'BITRIX_WORK_STAGES', 'EXECUTING,PREPARATION').split(',').map((s) => s.trim()).filter(Boolean);
  cfg.bitrixAssignedById = int(env, 'BITRIX_ASSIGNED_BY_ID', 0, { min: 0 });
  cfg.bitrixRetryBaseMs = int(env, 'BITRIX_RETRY_BASE_MS', 500, { min: 1 });
  cfg.fields = {};
  for (const [k, def] of Object.entries(FIELD_DEFAULTS)) cfg.fields[k] = str(env, 'BITRIX_FIELD_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase(), def);

  cfg.smsProvider = str(env, 'SMS_PROVIDER', 'console');
  if (!['console', 'memory', 'smsru'].includes(cfg.smsProvider)) throw new Error('SMS_PROVIDER должен быть console, smsru или memory.');
  cfg.smsruApiId = str(env, 'SMSRU_API_ID');
  cfg.smsruBase = str(env, 'SMSRU_API_BASE', 'https://sms.ru').replace(/\/+$/, '');
  if (cfg.smsProvider === 'smsru' && !cfg.smsruApiId) throw new Error('Для SMS_PROVIDER=smsru нужен SMSRU_API_ID.');

  cfg.adminKey = str(env, 'ADMIN_KEY');
  cfg.referralOwnerBonus = int(env, 'REFERRAL_OWNER_BONUS', 500, { min: 0 });
  cfg.referralFriendBonus = int(env, 'REFERRAL_FRIEND_BONUS', 500, { min: 0 });
  cfg.maxPayPercent = int(env, 'MAX_PAY_PERCENT', 30, { min: 0, max: 100 });
  cfg.materializeIntervalMin = int(env, 'MATERIALIZE_INTERVAL_MIN', 60, { min: 0 });
  cfg.slots = SLOTS.slice();

  cfg.paymentsProvider = str(env, 'PAYMENTS_PROVIDER', 'none');
  if (!['none', 'yookassa'].includes(cfg.paymentsProvider)) throw new Error('PAYMENTS_PROVIDER должен быть none или yookassa.');
  cfg.yookassaShopId = str(env, 'YOOKASSA_SHOP_ID');
  cfg.yookassaSecretKey = str(env, 'YOOKASSA_SECRET_KEY');
  cfg.yookassaApiBase = str(env, 'YOOKASSA_API_BASE', 'https://api.yookassa.ru/v3').replace(/\/+$/, '');
  if (cfg.paymentsProvider === 'yookassa' && (!cfg.yookassaShopId || !cfg.yookassaSecretKey)) {
    throw new Error('Для PAYMENTS_PROVIDER=yookassa нужны YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.');
  }

  cfg.telegramBotToken = str(env, 'TELEGRAM_BOT_TOKEN');
  cfg.telegramBotUsername = str(env, 'TELEGRAM_BOT_USERNAME').replace(/^@/, '');
  cfg.telegramWebhookSecret = str(env, 'TELEGRAM_WEBHOOK_SECRET');
  cfg.telegramApiBase = str(env, 'TELEGRAM_API_BASE', 'https://api.telegram.org').replace(/\/+$/, '');
  return cfg;
}

module.exports = { loadConfig, SLOTS, FIELD_DEFAULTS };
