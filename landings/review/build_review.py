#!/usr/bin/env python3
"""Сборка страницы-ревью (артефакт): оба лендинга + панель комментариев слева.

    python3 landings/review/build_review.py   ->   landings/review/review.html
"""
import base64
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import build  # noqa: E402

CSS_REVIEW = open(os.path.join(HERE, 'review.css'), encoding='utf-8').read()
JS_REVIEW = open(os.path.join(HERE, 'review.js'), encoding='utf-8').read()


def container_css(css):
    """@media по ширине окна -> @container по ширине «экрана» лендинга (десктоп 1280 / телефон 390)."""
    return re.sub(r'@media \((min|max)-width:(\d+)px\)', r'@container chl (\1-width:\2px)', css)


CACHE = os.path.join(HERE, '.img-cache')


def embed_images(html):
    """Артефакт не грузит картинки с чужих доменов — встраиваем их как data: URI."""
    os.makedirs(CACHE, exist_ok=True)

    def one(m):
        url = m.group(0)
        f = os.path.join(CACHE, re.sub(r'[^A-Za-z0-9.]+', '_', url[-90:]))
        if not (os.path.exists(f) and open(f, 'rb').read(4) == b'RIFF'):
            for _ in range(8):  # Тильда отдаёт webp со 2-го запроса (первый — редирект на оригинал); сеть тоже бывает нестабильна
                subprocess.run(['curl', '-sSL', '-m', '60', '-o', f, url])
                if os.path.exists(f) and open(f, 'rb').read(4) == b'RIFF':
                    break
                time.sleep(2)
        data = open(f, 'rb').read()
        if data[:4] != b'RIFF':
            raise SystemExit('не удалось получить webp: ' + url)
        return 'data:image/webp;base64,' + base64.b64encode(data).decode()

    return re.sub(r'https://optim\.tildacdn\.com/[^"\')\s]+', one, html)


def tpl(key, fn):
    cfg, body = fn()
    body = embed_images(build.nbsp(body))
    return ('<template id="tpl-%s">\n<div id="chl">\n%s\n</div>\n</template>\n'
            '<script type="application/json" id="cfg-%s">%s</script>\n') % (
        key, body, key, json.dumps(cfg, ensure_ascii=False).replace('</', '<\\/'))


HTML = '''<title>Правки лендингов CleanHub</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
%(css_review)s
/* ---- стили лендингов (без изменений, @media заменены на @container) ---- */
%(css_landing)s
</style>

<div class="app">
  <aside class="panel" id="panel" aria-label="Комментарии и правки">
    <div class="p-head">
      <div class="p-title"><h1>Комментарии<small>CleanHub · рекламные лендинги</small></h1><button class="btn sm hide-wide" id="close-panel" type="button">Закрыть</button></div>
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" id="tab-comments" type="button">Комментарии<span class="n">0</span></button>
        <button class="tab" role="tab" id="tab-edits" type="button">Правки текста<span class="n">0</span></button>
      </div>
    </div>
    <div class="p-body" id="p-body"></div>
  </aside>
  <main class="main">
    <div class="tb">
      <button class="btn" id="toggle-panel" type="button">Комментарии · <span id="tp-count">0</span></button>
      <div class="seg" id="page" role="group" aria-label="Лендинг"><button type="button" data-v="general" aria-pressed="true">Генеральная</button><button type="button" data-v="reno" aria-pressed="false">После ремонта</button></div>
      <div class="seg" id="device" role="group" aria-label="Устройство"><button type="button" data-v="mobile" aria-pressed="false">Телефон</button><button type="button" data-v="desktop" aria-pressed="true">Десктоп</button></div>
      <div class="seg" id="mode" role="group" aria-label="Режим"><button type="button" data-v="view" aria-pressed="true">Просмотр</button><button type="button" data-v="edit" aria-pressed="false" style="--x:1">Правка</button><button type="button" data-v="comment" aria-pressed="false">Комментарий</button></div>
      <span class="sp"></span><span class="hint hide-narrow" id="hint"></span>
    </div>
    <div class="canvas" id="canvas"><div class="sheet" id="sheet"><div class="stage" id="stage"></div><div class="pins" id="pins"></div></div></div>
  </main>
</div>
<div id="mock" data-tooltip-hook="#popup:order" hidden>
  <form class="mock-card" id="mock-form">
    <h2>Оставить заявку</h2>
    <div class="mock-tag">ПРИМЕР. Так будет выглядеть окно заявки. В Тильде вместо него откроется ваша форма, а заявка придёт менеджеру на почту, в Telegram или CRM (как на основном сайте).</div>
    <input type="text" id="mock-name" placeholder="Ваше имя" aria-label="Имя" autocomplete="off">
    <input type="tel" id="mock-phone" placeholder="+7 (___) ___-__-__" aria-label="Телефон" autocomplete="off">
    <small>Менеджер получит вместе с заявкой ваш расчёт:</small>
    <pre id="mock-view"></pre>
    <input type="hidden" name="Расчёт" id="mock-calc"><input type="hidden" name="Сумма" id="mock-sum">
    <small>Нажимая кнопку, вы соглашаетесь с политикой обработки персональных данных и договором оферты.</small>
    <div class="row"><button class="btn" id="mock-close" type="button">Закрыть</button><button class="btn pri" type="submit">Отправить заявку</button></div>
    <div class="ok" id="mock-ok" hidden>В примере заявка никуда не уходит. В Тильде здесь откроется страница «Спасибо».</div>
  </form>
</div>
<div id="toast" hidden style="position:fixed;left:50%%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%%);background:var(--fg);color:var(--panel);padding:9px 14px;border-radius:9px;font-weight:600;font-size:13px;z-index:99;max-width:90vw"></div>

%(templates)s
<script>
/* Логика калькулятора лендинга, обёрнутая в функцию: вызывается при каждом показе страницы. */
window.__chlInit = function () {
%(js_landing)s
};
</script>
<script>
%(js_review)s
</script>
'''


def main():
    out = HTML % {
        'css_review': CSS_REVIEW,
        'css_landing': container_css(build.CSS),
        'templates': tpl('general', build.page_general) + tpl('reno', build.page_reno),
        'js_landing': build.JS,
        'js_review': JS_REVIEW,
    }
    path = os.path.join(HERE, 'review.html')
    open(path, 'w', encoding='utf-8').write(out)
    print('%s  %.0f KB' % (os.path.relpath(path, os.path.dirname(os.path.dirname(HERE))), len(out.encode('utf-8')) / 1024))


if __name__ == '__main__':
    main()
