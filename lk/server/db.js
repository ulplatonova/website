'use strict';
/* SQLite (node:sqlite). Миграции по таблице schema_version. Только параметризованные запросы. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  /* 1: базовая схема */
  `
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_contact ON sessions(contact_id);

  CREATE TABLE sms_codes (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX idx_rate_limits_key ON rate_limits(key, ts);

  CREATE TABLE contacts_local (
    bitrix_contact_id TEXT PRIMARY KEY,
    ref_code TEXT NOT NULL UNIQUE,
    referrer_contact_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    addresses TEXT NOT NULL DEFAULT '[]',
    notify TEXT NOT NULL DEFAULT '{"tgOrders":true,"tgPromo":false}',
    tg_chat_id TEXT,
    tg_username TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_contacts_referrer ON contacts_local(referrer_contact_id);
  CREATE INDEX idx_contacts_tg ON contacts_local(tg_chat_id);

  CREATE TABLE tg_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,             -- link | login
    contact_id TEXT,                -- для link: кто привязывает
    session_token TEXT,             -- для login: выданная сессия, отдаётся один раз
    done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    title TEXT NOT NULL,
    ref_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_ledger_contact ON ledger(contact_id, created_at);

  CREATE TABLE deal_state (
    deal_id TEXT PRIMARY KEY,
    contact_id TEXT,
    notified_status TEXT,
    processed_status TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_deal_state_contact ON deal_state(contact_id);

  CREATE TABLE promo_codes (
    code TEXT PRIMARY KEY,
    bonus INTEGER NOT NULL,
    max_uses INTEGER,
    expires_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE promo_uses (
    code TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    UNIQUE(code, contact_id)
  );

  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    status TEXT NOT NULL,
    service TEXT NOT NULL,
    area INTEGER NOT NULL,
    tariff TEXT NOT NULL,
    freq INTEGER NOT NULL,
    months INTEGER NOT NULL,
    weekday INTEGER NOT NULL,
    slot TEXT NOT NULL,
    address TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    base INTEGER NOT NULL,
    discount_per_cleaning INTEGER NOT NULL,
    per_cleaning INTEGER NOT NULL,
    per_month INTEGER NOT NULL,
    period_total INTEGER NOT NULL,
    payment_id TEXT,
    payment_url TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_subs_contact ON subscriptions(contact_id);

  CREATE TABLE sub_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub_id TEXT NOT NULL,
    date TEXT NOT NULL,
    deal_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(sub_id, date)
  );
  `
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  let cur = row && row.v ? row.v : 0;
  for (; cur < MIGRATIONS.length; cur++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[cur]);
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(cur + 1);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

/* Небольшая обёртка: run/get/all с параметрами и транзакция (синхронная). */
function wrap(db) {
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0;
  return {
    raw: db,
    run: (sql, ...p) => prep(sql).run(...p),
    get: (sql, ...p) => prep(sql).get(...p),
    all: (sql, ...p) => prep(sql).all(...p),
    /* fn выполняется целиком или откатывается; вложенные вызовы используют внешнюю транзакцию */
    tx(fn) {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } finally { depth--; }
    },
    close: () => db.close()
  };
}

module.exports = { openDb, MIGRATIONS };
