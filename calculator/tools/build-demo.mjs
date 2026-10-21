// Собирает calculator/demo.html — страницу предпросмотра калькулятора без Тильды.
// Запуск: node calculator/tools/build-demo.mjs
// В демо подключены шрифты сайта и макет попап-формы Тильды (#popup:calc со скрытым полем «Расчёт»),
// чтобы проверить, что расчёт попадает в заявку.
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('..', import.meta.url);
const snippet = readFileSync(new URL('cleanhub-calculator.html', dir), 'utf8');

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Калькулятор CleanHub — предпросмотр</title>
<style>
@font-face{font-family:'UA-brand';src:url('https://static.tildacdn.com/tild3434-3839-4830-a366-326661663237/ua-BRAND-regular.woff') format('woff');font-weight:400}
@font-face{font-family:'UA-brand';src:url('https://static.tildacdn.com/tild3032-6561-4961-a135-333136313139/ua-BRAND-bold.woff') format('woff');font-weight:700}
@font-face{font-family:'GothamPro';src:url('https://static.tildacdn.com/tild3237-3065-4361-b037-316637376363/gothampro.woff') format('woff');font-weight:400}
@font-face{font-family:'GothamPro';src:url('https://static.tildacdn.com/tild6464-3139-4739-b638-653766393930/gothampro_medium.woff') format('woff');font-weight:500}
body{margin:0;background:#fff;--t-headline-font:'UA-brand',Arial,sans-serif;--t-text-font:'GothamPro',Arial,sans-serif;font-family:var(--t-text-font)}
.demo-bar{background:#0b2517;color:#fff;font-size:13px;padding:10px 16px;text-align:center}
.demo-popup{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:16px}
.demo-popup.is-open{display:flex}
.demo-popup__box{background:#fff;border-radius:24px;max-width:520px;width:100%;padding:28px;max-height:90vh;overflow:auto}
.demo-popup h3{margin:0 0 6px;font-family:var(--t-headline-font);font-size:24px}
.demo-popup p{margin:0 0 16px;color:#66756d;font-size:14px}
.demo-popup input[type=text]{width:100%;box-sizing:border-box;height:50px;border:1px solid #c9c9c9;border-radius:30px;padding:0 20px;font:inherit;margin-bottom:12px}
.demo-popup pre{white-space:pre-wrap;background:#f4f7f5;border-radius:16px;padding:14px;font-size:12px;line-height:1.5;margin:0 0 16px}
.demo-popup button{height:50px;border:0;border-radius:30px;background:#00b14f;color:#fff;font:inherit;width:100%;cursor:pointer}
.demo-popup .demo-close{background:none;color:#000;height:auto;width:auto;float:right;font-size:28px;line-height:1}
</style>
</head>
<body>
<div class="demo-bar">Предпросмотр калькулятора. На сайте он встаёт в блок «HTML-код» (T123) Тильды.</div>

<!-- ↓↓↓ содержимое calculator/cleanhub-calculator.html ↓↓↓ -->
${snippet}
<!-- ↑↑↑ конец калькулятора ↑↑↑ -->

<!-- Макет попапа Тильды: на сайте его заменяет блок «Форма в попапе» с хуком #popup:calc -->
<div class="demo-popup t-popup" data-tooltip-hook="#popup:calc">
  <div class="demo-popup__box">
    <button type="button" class="demo-close" aria-label="Закрыть">×</button>
    <h3>Оставьте заявку</h3>
    <p>Так выглядит попап-форма. Ниже — скрытое поле <b>«Расчёт»</b> в том виде, в каком оно придёт менеджеру вместе с заявкой.</p>
    <form onsubmit="event.preventDefault();alert('Демо: заявка не отправляется')">
      <input type="text" name="Name" placeholder="Как к вам обращаться?">
      <input type="text" name="Phone" placeholder="+7 (000) 000-00-00">
      <input type="hidden" name="Расчёт">
      <pre data-demo-out></pre>
      <button type="submit">Отправить</button>
    </form>
  </div>
</div>
<script>
// Имитация Тильды: клик по ссылке #popup:calc открывает попап
(function () {
  var popup = document.querySelector('.demo-popup');
  document.addEventListener('click', function (e) {
    if (e.target.closest('a[href$="#popup:calc"]')) {
      e.preventDefault();
      var f = popup.querySelector('form');
      popup.querySelector('[data-demo-out]').textContent = 'Расчёт: ' + f.elements['Расчёт'].value;
      popup.classList.add('is-open');
      document.body.classList.add('t-body_popupshowed');
    }
    if (e.target === popup || e.target.closest('.demo-close')) {
      popup.classList.remove('is-open');
      document.body.classList.remove('t-body_popupshowed');
    }
  });
})();
</script>
</body>
</html>
`;

writeFileSync(new URL('demo.html', dir), page);
console.log('calculator/demo.html обновлён');
