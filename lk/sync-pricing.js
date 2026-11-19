#!/usr/bin/env node
/* Копирует lk/pricing.js во встроенный блок lk/cleanhub-lk.html (между маркерами PRICING:BEGIN и PRICING:END).
 * Запускать после любого изменения цен: node lk/sync-pricing.js */
const fs = require('fs'), path = require('path');
const htmlPath = path.join(__dirname, 'cleanhub-lk.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const pricing = fs.readFileSync(path.join(__dirname, 'pricing.js'), 'utf8');
const re = /\/\*PRICING:BEGIN\*\/[\s\S]*?\/\*PRICING:END\*\//;
if (!re.test(html)) { console.error('Маркеры PRICING:BEGIN/END не найдены в cleanhub-lk.html'); process.exit(1); }
const out = html.replace(re, () => '/*PRICING:BEGIN*/\n' + pricing + '/*PRICING:END*/');
fs.writeFileSync(htmlPath, out);
console.log(out === html ? 'Цены уже синхронизированы' : 'Цены обновлены в cleanhub-lk.html');
