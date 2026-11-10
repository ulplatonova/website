#!/usr/bin/env python3
"""Векторный логотип CleanHub (SVG): иконка + CLEAN + HUB на плашке. Буквы переведены в контуры (шрифт Montserrat, OFL).
    python3 landings/assets/make_logo.py -> landings/assets/logo.svg  (и logo.inline.txt для вставки в HTML)
Нужны: fonttools и woff Montserrat (latin 500/700), путь указан в FONT_DIR."""
import os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.environ.get('FONT_DIR', '/tmp/claude-0/font')
GREEN, INK = '#46b05a', '#0a2a12'


def text_path(font_file, text, cap_h, x0, baseline, width=None, tracking=0):
    f = TTFont(os.path.join(FONT_DIR, font_file)); gs = f.getGlyphSet(); cmap = f.getBestCmap()
    cap = getattr(f['OS/2'], 'sCapHeight', 0) or 700
    k = cap_h / cap
    names = [cmap[ord(c)] for c in text]
    adv = [f['hmtx'][n][0] for n in names]
    total = sum(adv) * k + tracking * (len(text) - 1)
    sx = 1.0
    if width: sx = width / total
    x = x0; pen = SVGPathPen(gs)
    for n, a in zip(names, adv):
        tp = TransformPen(pen, (k * sx, 0, 0, -k, x, baseline))
        gs[n].draw(tp)
        x += a * k * sx + tracking
    return pen.getCommands()


clean = text_path('m600.woff', 'CLEAN', cap_h=80, x0=117, baseline=112, width=378)
hub = text_path('m600.woff', 'HUB', cap_h=68, x0=530, baseline=108, width=215)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="766" height="152" viewBox="0 0 766 152" role="img" aria-label="CleanHub">
<rect width="100" height="152" rx="16" fill="{GREEN}"/>
<rect x="23" width="55" height="76" fill="#fff"/>
<rect x="23" y="76" width="55" height="20" rx="3" fill="{INK}"/>
<rect x="43" y="92" width="12" height="60" fill="{INK}"/>
<g fill="{INK}"><circle cx="41" cy="55" r="6"/><circle cx="61" cy="62" r="5"/><circle cx="54" cy="42" r="4"/><circle cx="36" cy="31" r="2.2"/><circle cx="48" cy="29" r="2.2"/><circle cx="63" cy="32" r="2.2"/></g>
<path d="{clean}" fill="{INK}"/>
<rect x="516" y="15" width="250" height="115" rx="40" fill="{GREEN}"/>
<path d="{hub}" fill="{INK}"/>
</svg>'''
open(os.path.join(HERE, 'logo.svg'), 'w', encoding='utf-8').write(svg)
open(os.path.join(HERE, 'logo.inline.txt'), 'w', encoding='utf-8').write(svg.replace('\n', ''))
print('logo.svg', len(svg), 'bytes')
