# API кабинета CleanHub (контракт между фронтом и сервером)

Сервер: Node.js 22, **без внешних зависимостей** (встроенные `node:http`, `node:sqlite`, `node:test`, `fetch`).
Фронт: блок `lk/cleanhub-lk.html` в Тильде, `CHLK_CONFIG.mode='live'`, `apiBase=https://api.cleanhub24.ru/lk`.
Все ответы JSON. Ошибка: HTTP 4xx/5xx и тело `{"message":"текст по-русски для пользователя"}`.
После входа все запросы с заголовком `Authorization: Bearer <token>`. CORS: разрешённые origin из env, заголовки `Authorization, Content-Type`.

## Расчёт стоимости
Единственный источник цен: `lk/pricing.js` (`require('../pricing.js')`, `compute(state)`), копия логики калькулятора на сайте.
Сервер **всегда пересчитывает** сумму сам по `state` и игнорирует любые суммы с клиента.
`state` = `{service:'general'|'support'|'renovation', area:number, tariff:'lite'|'standard'|'premium', extras:{<extraId>:qty}, freq?:2|4, months?:3|6|12}`.
Если площадь больше последней границы тарифа (`compute().individual===true`), цена ориентировочная («от»), заказ принимается, но помечается в комментарии сделки «ИНДИВИДУАЛЬНЫЙ РАСЧЁТ, менеджеру уточнить цену». Для подписки индивидуальный расчёт запрещён (400).
Допуслуги с `quote:true` (цена по фото) в сумму не входят, их надо перечислить в комментарии «оценить по фото».

## Авторизация (без паролей, вход по SMS или через Telegram-бота)
- `POST /auth/code` `{phone, purpose:'login'|'register'}` → `{ok:true}`. Телефон нормализуется к `+7XXXXXXXXXX`. Ответ одинаков для известных и неизвестных номеров (нет перебора клиентов). Лимиты: 1 код в 60 с на номер, 5 в час на номер, 20 в час на IP. Код 4 цифры, хранится хэшем, живёт 5 минут, 5 попыток ввода.
- `POST /auth/verify` `{phone, code, profile:null | {name, email, refCode}}` → `{token, referralApplied:boolean}`. Если контакта с таким телефоном нет в Битриксе, он создаётся (имя и email из profile, если есть). `refCode` учитывается только при создании нового контакта, если код существует и это не он сам. Токен: 32 случайных байта (hex), в БД хранится хэш, живёт 30 дней.
- `POST /auth/telegram/start` → `{url:'https://t.me/<бот>?start=login_<token>', token}`; `GET /auth/telegram/status?token=` → `{done:false}` или `{done:true, token}`. Бот при `/start login_<token>` находит контакт, привязанный к этому chat_id; если привязки нет, отвечает «Сначала войдите по SMS и подключите Telegram в профиле».

## Профиль и бонусы
`GET /me` →
```json
{
 "user": {"id":"123","name":"Анна","phone":"+7 (916) 123-45-67","email":"","birthday":"1990-05-17",
          "tg":{"connected":false,"username":""},
          "notify":{"tgOrders":true,"tgPromo":false},
          "addresses":[{"id":"a1","label":"Дом","text":"Москва, ..."}]},
 "loyalty": {"clientNo":"CH-000123","balance":1410,"spent":28200,
             "levels":[{"name":"Гость","from":0,"pct":3},{"name":"Постоянный клиент","from":15000,"pct":5},{"name":"Премиум-клиент","from":40000,"pct":7}],
             "expiring":null,"maxPay":30,
             "history":[{"date":"ISO","title":"Начисление за заказ CH-10431","delta":475}]},
 "referral": {"code":"CH-K7M2Q","link":"https://cleanhub24.ru/?ref=CH-K7M2Q","ownerBonus":500,"friendBonus":500,
              "invited":[{"name":"Мария К.","status":"registered|ordered|rewarded","date":"ISO","reward":500}],
              "totals":{"invited":3,"rewarded":1,"earned":500}}}
```
- `spent` = сумма `OPPORTUNITY` выполненных сделок клиента (`STAGE_SEMANTIC_ID='S'`). Уровень определяется по `spent`.
- `balance` и `history` из локального реестра (таблица ledger, у каждой записи уникальный `ref_key`, повтор невозможен). История отсортирована по убыванию даты.
- Имя в `invited`: «Имя + первая буква фамилии.», без телефона и email.
- `PATCH /me` `{name?, email?, birthday?, addresses?, notify?}` → `{user}` (обновляет контакт в Битриксе: NAME, EMAIL, BIRTHDATE; адреса и notify хранятся в локальной БД).
- `POST /loyalty/promo` `{code}` → `{ok:true}`. Принимает: (а) реферальный код друга, если у клиента ещё нет выполненных заказов и реферера (привязывает реферера), (б) промокоды из таблицы `promo_codes` (разовые бонусы). Иначе 400 «Промокод не найден».

## Начисление бонусов (без Тейки, всё считает сервер)
Выполняется функцией `processDeal(deal)` идемпотентно, из двух мест: вебхука Битрикса и сверки при `GET /me` и `GET /orders`.
- Сделка выиграна (`STAGE_SEMANTIC_ID='S'`): кешбэк `round(OPPORTUNITY * pct / 100)`, где pct — уровень клиента по `spent` **до** этой сделки; запись `ref_key='deal:<id>:earn'`. Заголовок «Начисление за заказ CH-<id>».
- В сделке указано списание бонусов (`UF_CRM_CH_BONUS_SPENT`) и сделка проиграна (`'F'`): возврат `ref_key='deal:<id>:refund'`.
- Реферал: при **первой** выигранной сделке клиента, у которого есть реферер: +`ownerBonus` рефереру (`ref:<referee>:owner`, «Бонус за друга») и +`friendBonus` самому клиенту (`ref:<referee>:friend`, «Бонус за первый заказ по рекомендации»).
- Списание при создании заказа: запись `deal:<id>:spend` с отрицательной суммой сразу.
- Лимит списания: не больше баланса и не больше `maxPay`% (30) от суммы заказа до бонусов. Нарушение: 400.
- Реферальный код: `CH-` + 5 символов из `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, уникальный, создаётся при первом обращении к `GET /me`.

## Заказы (Битрикс24, сделки)
- `GET /orders` → `{orders:[...]}` — сделки клиента (`CONTACT_ID`), новые сверху. Заказ:
```json
{"id":"CH-10431","dealId":10431,"date":"ISO дата визита","status":"new|work|done|cancel","title":"Генеральная уборка",
 "tariff":"Стандарт","area":53,"svc":"general","items":[{"name":"Генеральная уборка, 53 м²","qty":1,"price":15990}],
 "total":15990,"bonusSpent":0,"bonusEarned":800,"address":"...","slot":"11:00–13:00","comment":"","sub":null,"extras":{"windows":4}}
```
  `status`: семантика `S`→`done`, `F`→`cancel`, иначе стадия из `BITRIX_WORK_STAGES` (по умолчанию `EXECUTING,PREPARATION`) → `work`, остальные → `new`. Стадия сравнивается по суффиксу после `:` (в воронках `C2:WON`). `items` берутся из товарных позиций сделки (`crm.deal.productrows.get`, все сделки одним `batch`), если позиций нет, то из `UF_CRM_CH_EXTRAS` + `pricing.compute`. `bonusEarned` — из реестра, для невыполненных сделок прогноз по текущему уровню.
- `POST /orders` `{state, address, date:'YYYY-MM-DD', slot, comment, bonusSpend}` → `{order}`. Дата не раньше сегодня, слот из списка конфигурации, адрес не пустой (иначе 400). Создаёт сделку (`crm.deal.add`) и товарные позиции (`crm.deal.productrows.set`: строка тарифа + по строке на допуслугу), `OPPORTUNITY = total - bonusSpend`, `TITLE = "Заказ из кабинета: <услуга>, <площадь> м²"`, `CONTACT_ID`, `CATEGORY_ID`, `STAGE_ID` (новая), `SOURCE_ID='WEB'`, `COMMENTS` — расчёт текстом (услуга, тариф, допуслуги, «К оплате», «Бонусами», комментарий клиента).
- Пользовательские поля сделки (имена настраиваются, по умолчанию): `UF_CRM_CH_SERVICE`, `UF_CRM_CH_TARIFF`, `UF_CRM_CH_AREA`, `UF_CRM_CH_ADDRESS`, `UF_CRM_CH_SLOT`, `UF_CRM_CH_VISIT_DATE` (дата), `UF_CRM_CH_BONUS_SPENT`, `UF_CRM_CH_EXTRAS` (JSON строкой), `UF_CRM_CH_SUB_ID`. Поля контакта: `UF_CRM_CH_REFCODE`. Скрипт `server/scripts/bitrix-setup.js` создаёт их через `crm.deal.userfield.add` / `crm.contact.userfield.add` (идемпотентно, если поле уже есть, пропускает).
- Подключение: входящий вебхук Битрикса `BITRIX_WEBHOOK_URL=https://<портал>.bitrix24.ru/rest/<user>/<token>/`. Клиент `bitrix.js`: `call(method, params)`, `batch(cmds)` (до 50 команд), повтор при 5xx и `QUERY_LIMIT_EXCEEDED` с паузой, таймаут 15 с.
- Поиск контакта по телефону: `crm.duplicate.findbycomm {type:'PHONE', values:[...]}` (пробовать форматы `+7…`, `7…`, `8…`), затем `crm.contact.get`.
- `POST /bitrix/events` — исходящий вебхук Битрикса (`ONCRMDEALUPDATE`, `ONCRMDEALADD`), form-urlencoded (`event`, `data[FIELDS][ID]`, `auth[application_token]`). Проверка токена `BITRIX_EVENT_TOKEN` (timing-safe), иначе 403. Действия: загрузить сделку → `processDeal` → если статус изменился относительно `notified_status`, отправить Telegram-уведомление (если у клиента подключён Telegram и включено `notify.tgOrders`). Всегда отвечает 200 быстро.

## Подписка (по модели калькулятора: `pricing.subscription`)
Только поддерживающая уборка (`pricing.subscription.service`), `freq` — число уборок в месяц (2 или 4), `months` — срок 3/6/12. `compute(state).subscription` даёт `perCleaning`, `perMonth`, `periodTotal`, `discountPerCleaning`, `savingMonth`.
Подписка:
```json
{"id":"s_ab12","status":"pending_payment|active|paused|cancelled|finished","service":"support","area":53,"tariff":"standard",
 "freq":2,"months":6,"weekday":3,"slot":"11:00–13:00","address":"...","startDate":"2026-12-02","endDate":"2027-06-02",
 "base":7990,"discountPerCleaning":700,"perCleaning":7290,"perMonth":14580,"periodTotal":87480,
 "nextVisits":["2026-12-02","2026-12-16","2026-12-30","2027-01-13"],"paymentUrl":null,"createdAt":"ISO"}
```
- Даты визитов: первый визит = первая дата ≥ `startDate` с днём недели `weekday` (1=пн … 7=вс); далее каждые 7 дней при `freq=4`, каждые 14 дней при `freq=2`; до `endDate = startDate + months` месяцев. `startDate` не раньше завтра.
- `GET /subscriptions` → `{subscriptions:[...]}`.
- `POST /subscriptions` `{state:{service:'support',area,tariff,freq,months}, weekday, slot, startDate, address, comment}` → `{subscription, paymentUrl}`. Статус `active`, если платежи отключены (`PAYMENTS_PROVIDER=none`), иначе `pending_payment` и `paymentUrl` из провайдера.
- `PATCH /subscriptions/:id` `{action:'pause'|'resume'|'cancel'}` → `{subscription}`. Допустимые переходы: active→paused, paused→active, active|paused|pending_payment→cancelled. Чужую подписку изменить нельзя (404).
- Материализация: `materializeVisits({daysAhead:7})` для каждой `active` подписки создаёт сделку на каждый визит в окне [сегодня, сегодня+daysAhead], которого ещё нет в таблице `sub_visits` (UNIQUE sub_id+date). Сделка как у заказа, `OPPORTUNITY = perCleaning`, `UF_CRM_CH_SUB_ID`, `TITLE = "Подписка: поддерживающая уборка, <площадь> м²"`. Запуск: раз в час внутри процесса (`MATERIALIZE_INTERVAL_MIN`, 0 = выкл) и по `POST /internal/materialize` с `X-Admin-Key` (timing-safe).
- В `GET /orders` сделки подписки имеют `sub:"<id>"`.

## Платежи (ЮKassa, подготовка)
`payments.js` с интерфейсом `{enabled, createSubscriptionPayment(sub, contact) → {paymentId, url}, handleWebhook(body) → {subscriptionId, event}}`. Провайдер `none` по умолчанию. Провайдер `yookassa` (env `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `PUBLIC_URL`): `POST https://api.yookassa.ru/v3/payments`, Basic auth, заголовок `Idempotence-Key`, сумма `perMonth`, `capture:true`, `confirmation:{type:'redirect', return_url}`, `save_payment_method:true`, `metadata:{subscription_id}`. `POST /yookassa/webhook`: не доверять телу, перепроверить платёж запросом `GET /v3/payments/{id}`; при `succeeded` перевести подписку в `active`. Этот провайдер не проверяется в тестах (нет доступа к ЮKassa), это должно быть явно сказано в README.

## Telegram
Env `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`. `POST /telegram/webhook` (проверка заголовка `X-Telegram-Bot-Api-Secret-Token`).
- `POST /telegram/link` (с токеном) → `{url:'https://t.me/<бот>?start=link_<token>', token}`; `GET /telegram/status?token=` → `{connected:boolean, username}`; `DELETE /telegram` → `{ok:true}`.
- Бот: `/start link_<token>` привязывает chat_id (и username) к контакту, бонус за подключение не начисляется. `/start login_<token>` см. выше. Другие сообщения: ответ с кнопкой/ссылкой на кабинет.
- Токены привязки одноразовые, живут 10 минут. Уведомления о статусах: «Заказ CH-… принят / мастер приступил / выполнен / отменён».

## Конфигурация (env, без значений по умолчанию для секретов)
`PORT`, `PUBLIC_URL`, `ALLOWED_ORIGINS` (через запятую), `DB_PATH`, `BITRIX_WEBHOOK_URL`, `BITRIX_EVENT_TOKEN`, `BITRIX_CATEGORY_ID`, `BITRIX_STAGE_NEW`, `BITRIX_WORK_STAGES`, `BITRIX_ASSIGNED_BY_ID`, `SMS_PROVIDER` (`console`|`smsru`|`memory` для тестов), `SMSRU_API_ID`, `ADMIN_KEY`, `REFERRAL_OWNER_BONUS=500`, `REFERRAL_FRIEND_BONUS=500`, `MAX_PAY_PERCENT=30`, `MATERIALIZE_INTERVAL_MIN=60`, `PAYMENTS_PROVIDER=none|yookassa`, плюс перечисленные выше. Слоты: `09:00–11:00, 11:00–13:00, 13:00–15:00, 15:00–17:00, 17:00–19:00`.
