#!/usr/bin/env python3
"""Contrast check for every text style on the board, on given wallpapers.

For each wallpaper this reproduces the extension's scrim (strength from the
wallpaper's mean luminance, three vertical bands), then takes the worst
backdrop in the band where tiles and chips sit: the 99th-percentile
brightest pixel for the dark style (light text) and the 1st-percentile
darkest for the light style (dark text). Glass and text tokens are
composited over it and WCAG contrast is reported against 4.5:1.

Usage: tools/contrast.py WALLPAPER... [--json]
"""
import json
import sys

from PIL import Image

SCREEN_W, SCREEN_H = 1920, 1200
BAND = (340, 1018)          # board top (no clock) to board bottom incl. chips (clock)
CLOCK_BAND = (210, 330)     # the big clock with show-clock on
CLOCK_X = (790, 1130)       # its horizontal extent

STYLES = {
    'dark': {
        'tile': ((28, 27, 38), .74), 'strong': ((26, 25, 36), .84),
        'inset': ((255, 255, 255), .075),
        'ink': ((239, 241, 245), 1), 'ink2': ((239, 241, 245), .66),
    },
    'light': {
        'tile': ((244, 245, 248), .80), 'strong': ((246, 246, 249), .90),
        'inset': ((30, 30, 46), .065),
        'ink': ((30, 30, 46), 1), 'ink2': ((30, 30, 46), .70),
    },
}

# (element, surface layers bottom-up, text token, font px)
ELEMENTS = [
    ('app name on tile', ['tile'], 'ink', 13.5),
    ('app name on hovered slot', ['tile', 'inset'], 'ink', 13.5),
    ('+N badge', ['strong'], 'ink', 13),
    ('folder name chip', ['strong'], 'ink', 14),
    ('search placeholder', ['strong'], 'ink2', 19),
    ('result count in field', ['strong'], 'ink2', 14),
    ('section label', ['strong'], 'ink2', 13),
    ('result caption', ['strong'], 'ink2', 13),
    ('result chip source', ['strong', 'inset'], 'ink2', 13),
    ('folder count', ['strong'], 'ink2', 14),
    ('edit banner text', ['strong'], 'ink2', 15),
    ('tooltip secondary', ['strong'], 'ink2', 13),
    ('menu shortcut', ['strong'], 'ink2', 13),
]


def lum709(c):
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255


def rel_lum(c):
    def lin(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])


def contrast(a, b):
    la, lb = sorted([rel_lum(a), rel_lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def over(top, alpha, bottom):
    return tuple(top[i] * alpha + bottom[i] * (1 - alpha) for i in range(3))


def scrim_params(img):
    small = img.resize((48, 30), Image.BILINEAR)
    px = list(small.get_flattened_data() if hasattr(small, 'get_flattened_data') else small.getdata())
    L = sum(lum709(p) for p in px) / len(px)
    a = 0.38 + L * 0.42
    b = 0.04 + L * 0.3
    return L, a, b


def scrim_alpha(y, a, b):
    h1, h2 = SCREEN_H * 0.36, SCREEN_H * 0.64
    if y < h1:
        return a + (b - a) * (y / h1)
    if y < h2:
        return b
    return b + (a * 0.8 - b) * ((y - h2) / (SCREEN_H - h2))


def backdrop(img, band, a, b, pct_bright, xs=None):
    w, h = img.size
    pix = img.load()
    samples = []
    for y in range(band[0], band[1], 2):
        s = scrim_alpha(y, a, b)
        for x in range(*(xs or (0, w)), 4):
            c = over((12, 12, 20), s, pix[x, y])
            samples.append((lum709(c), c))
    samples.sort(key=lambda t: t[0])
    k = int(len(samples) * pct_bright)
    return samples[min(len(samples) - 1, max(0, k))][1]


def check(path):
    img = Image.open(path).convert('RGB').resize((SCREEN_W, SCREEN_H), Image.BILINEAR)
    L, a, b = scrim_params(img)
    out = {'wallpaper': path, 'luminance': round(L, 3), 'rows': []}
    for style, tok in STYLES.items():
        bg = backdrop(img, BAND, a, b, 0.99 if style == 'dark' else 0.01)
        for name, layers, text, size in ELEMENTS:
            surf = bg
            for layer in layers:
                col, alpha = tok[layer]
                surf = over(col, alpha, surf)
            tcol, talpha = tok[text]
            fg = over(tcol, talpha, surf)
            r = contrast(fg, surf)
            out['rows'].append({'style': style, 'element': name, 'px': size,
                                'ratio': round(r, 2), 'ok': r >= 4.5 and size >= 13})
    # the clock sits on the scrimmed wallpaper, with the extension's halo
    # (alpha computed from the same 48x30 sample the extension uses)
    bright = L > 0.5
    clock_fg = (30, 30, 46) if bright else (255, 255, 255)
    halo_col = (255, 255, 255) if bright else (12, 12, 20)
    small = img.resize((48, 30), Image.BILINEAR)
    sp = small.load()
    region = [sp[x, y] for y in range(int(CLOCK_BAND[0] / SCREEN_H * 30), int(CLOCK_BAND[1] / SCREEN_H * 30 + 0.999) + 1)
              for x in range(int(CLOCK_X[0] / SCREEN_W * 48), int(CLOCK_X[1] / SCREEN_W * 48 + 0.999) + 1)]
    base = (min if bright else max)(region, key=rel_lum)
    s_mid = scrim_alpha(sum(CLOCK_BAND) / 2, a, b)
    bg = over((12, 12, 20), s_mid, base)
    h = 0.0
    while h < 0.9 and contrast(clock_fg, over(halo_col, h, bg)) < 5:
        h += 0.02
    worst = backdrop(img, CLOCK_BAND, a, b, 0.01 if bright else 0.99, CLOCK_X)
    r = contrast(clock_fg, over(halo_col, h, worst))
    out['rows'].append({'style': 'any', 'element': f'clock (halo {h:.2f})', 'px': 92,
                        'ratio': round(r, 2), 'ok': r >= 4.5})
    return out


def main():
    paths = [p for p in sys.argv[1:] if not p.startswith('--')]
    results = [check(p) for p in paths]
    if '--json' in sys.argv:
        print(json.dumps(results, indent=1))
        return
    bad = 0
    for res in results:
        print(f"\n{res['wallpaper']}  (mean luminance {res['luminance']})")
        for row in res['rows']:
            flag = 'ok ' if row['ok'] else 'LOW'
            bad += not row['ok']
            print(f"  {flag} {row['style']:5} {row['element']:28} {row['px']:>5}px  {row['ratio']:5.2f}:1")
    print(f"\n{bad} below 4.5:1 or under 13px")
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
