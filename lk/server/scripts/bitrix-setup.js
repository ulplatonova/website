#!/usr/bin/env node
'use strict';
/* Создаёт пользовательские поля сделки и контакта в Битрикс24 (crm.deal.userfield.add / crm.contact.userfield.add).
   Идемпотентно: существующие поля пропускаются. Ключ --dry-run только показывает, что будет сделано. */
const { loadConfig } = require('../config');
const { createBitrix } = require('../bitrix');

function specs(config) {
  const F = config.fields;
  return [
    { entity: 'deal', name: F.service, type: 'string', label: 'CleanHub: вид уборки' },
    { entity: 'deal', name: F.tariff, type: 'string', label: 'CleanHub: тариф' },
    { entity: 'deal', name: F.area, type: 'integer', label: 'CleanHub: площадь, м²' },
    { entity: 'deal', name: F.address, type: 'string', label: 'CleanHub: адрес' },
    { entity: 'deal', name: F.slot, type: 'string', label: 'CleanHub: время визита' },
    { entity: 'deal', name: F.visitDate, type: 'date', label: 'CleanHub: дата визита' },
    { entity: 'deal', name: F.bonusSpent, type: 'integer', label: 'CleanHub: списано бонусов' },
    { entity: 'deal', name: F.extras, type: 'string', label: 'CleanHub: допуслуги (JSON)' },
    { entity: 'deal', name: F.subId, type: 'string', label: 'CleanHub: id подписки' },
    { entity: 'contact', name: F.refCode, type: 'string', label: 'CleanHub: реферальный код' }
  ];
}

async function run({ config, bitrix, dryRun = false, log = console.log }) {
  const summary = { created: [], existing: [] };
  const existing = {};
  for (const entity of ['deal', 'contact']) {
    const list = await bitrix.call(`crm.${entity}.userfield.list`, { order: { SORT: 'ASC' }, filter: {} });
    existing[entity] = new Set((list || []).map((f) => f.FIELD_NAME));
  }
  for (const s of specs(config)) {
    if (existing[s.entity].has(s.name)) { log(`пропуск: поле ${s.name} (${s.entity}) уже есть`); summary.existing.push(s.name); continue; }
    if (dryRun) { log(`[dry-run] будет создано: ${s.name} (${s.entity}, ${s.type})`); summary.created.push(s.name); continue; }
    const label = { ru: s.label, en: s.label };
    await bitrix.call(`crm.${s.entity}.userfield.add`, {
      fields: {
        FIELD_NAME: s.name.replace(/^UF_CRM_/, ''), // Битрикс сам добавит префикс UF_CRM_
        USER_TYPE_ID: s.type, XML_ID: s.name, SORT: 500, MULTIPLE: 'N', MANDATORY: 'N', SHOW_FILTER: 'N', SHOW_IN_LIST: 'Y',
        EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label
      }
    });
    log(`создано: ${s.name} (${s.entity}, ${s.type})`);
    summary.created.push(s.name);
  }
  log(`${dryRun ? 'Было бы создано' : 'Создано'}: ${summary.created.length}, уже существовало: ${summary.existing.length}`);
  return summary;
}

module.exports = { run, specs };

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    let config;
    try { config = loadConfig(process.env); } catch (e) { console.error('Ошибка конфигурации: ' + e.message); process.exit(1); }
    await run({ config, bitrix: createBitrix(config), dryRun });
  })().catch((e) => { console.error('Ошибка: ' + e.message); process.exit(1); });
}
