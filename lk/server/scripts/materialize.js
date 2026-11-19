#!/usr/bin/env node
'use strict';
/* Запасной вариант для cron: вызывает POST /internal/materialize работающего сервера.
   Нужны ADMIN_KEY и (по желанию) LK_URL, по умолчанию http://127.0.0.1:$PORT. */
const base = (process.env.LK_URL || `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/+$/, '');
if (!process.env.ADMIN_KEY) { console.error('Не задан ADMIN_KEY'); process.exit(1); }
fetch(base + '/internal/materialize', {
  method: 'POST', headers: { 'X-Admin-Key': process.env.ADMIN_KEY, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120000)
}).then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error('Ошибка: ' + e.message); process.exit(1); });
