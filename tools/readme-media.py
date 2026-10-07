#!/usr/bin/env python3
"""Screenshots and the demo GIF for the README, from the nested shell.

Uses generic data (GNOME's default folders plus category groups over the
system's apps, no personal folders), a generated wallpaper and the blue
accent. The GIF is captured in real time by the test kit's frame recorder
while a storyboard plays inside the shell. The headless shell draws no
pointer, so the pointer, clicks and keyboard shortcuts are drawn on
afterwards.

Usage: tools/readme-media.py [OUTDIR]
Set ONLY=stills or ONLY=gif to make just one of them.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

TRANSPARENT = 255

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEST = os.path.join(ROOT, 'tools', 'nest.sh')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'shots', 'readme')
TMP = tempfile.mkdtemp(prefix='cubby-media-')
os.makedirs(OUT, exist_ok=True)

SCREEN = (1920, 1200)
GIF_W = 960
SCALE = GIF_W / SCREEN[0]
FRAME_MS = 40
FONT = '/usr/share/fonts/truetype/ubuntu/Ubuntu[wdth,wght].ttf'


def nest(*args):
    return subprocess.run([NEST, *args], check=True, capture_output=True, text=True).stdout.strip()


def js(code):
    return nest('js', code)


_bus = None


def _connection():
    global _bus
    if _bus is None:
        addr = open(os.path.expanduser('~/.cache/cubby-nest/bus')).read().strip()
        _bus = Gio.DBusConnection.new_for_address_sync(
            addr, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
    return _bus


def shot(path):
    _connection().call_sync('org.gnome.Shell', '/org/gnome/Shell/Screenshot',
                            'org.gnome.Shell.Screenshot', 'Screenshot',
                            GLib.Variant('(bbs)', (False, False, path)), None, 0, -1, None)


def still(name):
    """A screenshot saved as the README's 1600x1000 JPEG."""
    png = os.path.join(TMP, f'{name}.png')
    shot(png)
    Image.open(png).convert('RGB').resize((1600, 1000), Image.LANCZOS).save(
        os.path.join(OUT, f'{name}.jpg'), quality=88)


# ---- wallpaper ----

def wallpaper(path, light=False):
    """Layered dunes under a dusk (or daytime) sky, with a little grain
    against banding. Generated, so the screenshots carry no third-party art."""
    w, h = SCREEN
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)

    def c(hexc):
        return np.array([int(hexc[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255

    def screen(a, b):
        return 1 - (1 - a) * (1 - b)

    def glow(cx, cy, rx, ry, col, a):
        return np.exp(-(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2))[..., None] * c(col) * a

    t = (y / h)[..., None]
    if light:
        img = c('#7fb2e8') * (1 - t) + c('#f3d7d0') * t
        img = screen(img, glow(1500, 200, 700, 420, '#ffffff', 0.35))
        waves = [(560, 70, 2300, 0.6, '#9db8f2', '#7b8fd6', 0.85), (700, 85, 1900, 2.1, '#b79cf0', '#8f78d0', 0.88),
                 (840, 75, 2600, 4.0, '#f2a3c2', '#c97aa0', 0.85), (980, 60, 2100, 1.3, '#ffc29e', '#e39a7a', 0.8)]
    else:
        img = c('#070a1f') * (1 - t) + c('#120d33') * t
        img = screen(img, glow(1500, 180, 700, 420, '#1aa7b8', 0.55) + glow(300, 300, 600, 380, '#3b2fd6', 0.5))
        waves = [(560, 70, 2300, 0.6, '#4b3be0', '#1b1452', 0.85), (700, 85, 1900, 2.1, '#8a3fd8', '#2a1250', 0.88),
                 (840, 75, 2600, 4.0, '#e0558f', '#3a1240', 0.85), (980, 60, 2100, 1.3, '#ff8a5c', '#4a1a3a', 0.8)]
    for base, amp, length, phase, top, bottom, alpha in waves:
        edge = (base + amp * np.sin(x[0] / length * 2 * np.pi + phase) +
                0.4 * amp * np.sin(x[0] / (length * 0.37) * 2 * np.pi + phase * 1.7))[None, :]
        depth = np.clip((y - edge) / 420, 0, 1)[..., None]
        fill = c(top) * (1 - depth) + c(bottom) * depth
        inside = np.clip((y - edge) / 3 + 0.5, 0, 1)[..., None]
        crest = np.exp(-((y - edge) / 6) ** 2)[..., None] * 0.18
        img = img * (1 - inside * alpha) + fill * inside * alpha
        img = screen(img, crest * c(top))
    img = screen(img, glow(1460, 900, 520, 300, '#ff9a6b', 0.18))
    img += (np.random.default_rng(1).random((h, w, 1)) - 0.5) * (3 / 255)
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(path)
    return path


def start(light=False):
    global _bus
    _bus = None
    wall = wallpaper(os.path.join(TMP, 'wall-light.png' if light else 'wall.png'), light)
    args = ['start', f'{SCREEN[0]}x{SCREEN[1]}', '--dtp', '--no-folders', '--no-local',
            '--accent', 'blue', '--wall', wall]
    if light:
        args.append('--light')
    nest(*args)
    # results from Characters and Clocks crowd out the rest for a short query
    nest('gset', 'set', 'org.gnome.desktop.search-providers', 'disabled',
         "['org.gnome.Characters.desktop', 'org.gnome.clocks.desktop']")
    time.sleep(2)
    js("const s = cubbyTest.layer()._settings; s.set_boolean('show-clock', true); s.set_boolean('tip-dismissed', true); 1")
    # one window, to show the windows fading back
    js("imports.gi.Shell.AppSystem.get_default().lookup_app('org.gnome.TextEditor.desktop')?.activate(); 1")
    time.sleep(3)


# ---- stills ----

def stills():
    start()
    js('cubbyTest.layer().open(); 1')
    time.sleep(1.5)
    still('dark')
    js("cubbyTest.type('te'); 1")
    time.sleep(1.5)
    still('search')
    js("cubbyTest.key('Escape'); 1")
    time.sleep(0.6)
    js("const l = cubbyTest.layer(); const t = [...l.board.tiles.values()].find(t => t.slots.some(s => s.kind === 'more') && t.folder.apps.length > 8); l.openFolder(t.folder.id); 1")
    time.sleep(1.2)
    still('folder')
    js("cubbyTest.key('Escape'); 1")
    time.sleep(0.8)
    js("cubbyTest.key('e', ['Control_L']); 1")
    time.sleep(0.8)
    js("const t = [...cubbyTest.layer().board.tiles.values()][1]; const [x, y] = t.get_transformed_position(); cubbyTest.move(x + 60, y + 60); 1")
    time.sleep(0.8)
    still('edit')
    js("cubbyTest.key('Escape'); 1")
    time.sleep(0.5)
    js("const t = [...cubbyTest.layer().board.tiles.values()][2]; const [x, y] = t.get_transformed_position(); cubbyTest.click(x + 220, y + 60, 3); 1")
    time.sleep(0.6)
    still('menu')
    js("cubbyTest.key('Escape'); 1")
    nest('stop')

    start(light=True)
    js('cubbyTest.layer().open(); 1')
    time.sleep(1.5)
    still('light')
    nest('stop')


# ---- the demo ----

# Helpers for the storyboard, which runs inside the shell so its timing
# does not depend on D-Bus round trips.
HELPERS = """
const T = cubbyTest, L = T.layer();
const C = a => { const e = a.get_transformed_extents(); return [e.get_x() + e.get_width() / 2, e.get_y() + e.get_height() / 2]; };
const corner = a => { const e = a.get_transformed_extents(); return [e.get_x() + e.get_width(), e.get_y() + e.get_height()]; };
const P = () => global.get_pointer().slice(0, 2);
const go = (xy, ms) => { const [x, y] = P(); T.glide(x, y, xy[0], xy[1], ms); };
const by = (dx, dy, ms) => { const [x, y] = P(); T.glide(x, y, x + dx, y + dy, ms); };
const click = () => { T.mark('click'); T.click(...P()); };
const down = () => { T.mark('press'); T.press(...P()); };
const up = () => { T.mark('release'); T.release(); };
const key = (k, mods = [], label = '') => { if (label) T.mark('key', label); T.key(k, mods); };
const tile = name => [...L.board.tiles.values()].find(t => t.folder.name === name);
const cell = (x, y) => { const r = L.board.pixelRect({page: 0, x, y, w: 1, h: 1}); return [r.x + r.width / 2, r.y + r.height / 2]; };
function find(a, pred) { if (pred(a)) return a; for (const c of a.get_children()) { const r = find(c, pred); if (r) return r; } return null; }
const showApps = () => C(find(Main.layoutManager.uiGroup, a => a.has_style_class_name?.('show-apps') && a.mapped));
"""

# (name, length in ms, steps as "[ms, () => ...]" JavaScript, hold in ms after it)
STORYBOARD = [
    ('open', 2300, """
        [150, () => go(showApps(), 750)],
        [1050, click],
    """, 600),
    ('folder', 2100, """
        [100, () => go(C(tile('System').slots.at(-1)), 650)],
        [850, click],
    """, 500),
    ('reorder', 2700, """
        [150, () => go(C(L.folderView.items[4]), 450)],
        [750, down],
        [900, () => go(C(L.folderView.items[0]), 900)],
        [2000, up],
    """, 500),
    ('close-folder', 900, """
        [150, () => key('Escape', [], 'Esc')],
    """, 200),
    ('edit-move', 3000, """
        [100, () => key('e', ['Control_L'], 'Ctrl  E')],
        [650, () => go(C(tile('Games')), 600)],
        [1350, down],
        [1500, () => go(cell(7, 2), 850)],
        [2450, up],
    """, 0),
    ('edit-resize', 2600, """
        [100, () => { const [x, y] = corner(tile('Programming')); go([x - 8, y - 8], 600); }],
        [850, down],
        [1000, () => by(L.grid.U + L.grid.GX, 0, 800)],
        [1900, up],
    """, 300),
    ('done', 1500, """
        [100, () => go(C(L.editBar.done), 650)],
        [850, click],
    """, 300),
    ('search', 2700, """
        [50, () => by(330, 60, 500)],
        [650, () => key('c')],
        [830, () => key('a')],
        [1010, () => key('l')],
        [2050, () => {
            const items = L.results.items;
            const i = items.findIndex(item => item.app?.get_id() === 'org.gnome.Calculator.desktop');
            for (let k = 0; k < i; k++)
                key('Right', [], '→');
        }],
    """, 700),
    ('launch', 2600, """
        [150, () => key('Return', [], 'Enter')],
    """, 1300),
]


def record(name, length, steps):
    out = os.path.join(TMP, name)
    js(HELPERS + f"T.record({length}, '{out}', 0, 0, {SCREEN[0]}, {SCREEN[1]}, "
       f"{{maxFrames: {length // FRAME_MS + 10}, interval: {FRAME_MS - 2}}}); T.play([{steps}]); 1")
    # the recorder clears this flag once every frame is written
    while js('String(cubbyTest.recording)') == 'true':
        time.sleep(0.3)
    return out


def cursor_sprite(height=21):
    """An arrow pointer with a soft shadow, drawn large and scaled down."""
    k = 8
    pts = [(0, 0), (0, 16.5), (4.2, 12.6), (7.0, 19.2), (9.6, 18.1), (6.9, 11.7), (12.4, 11.7)]
    s = height / 19.5
    size = (int(16 * s * k), int(23 * s * k))
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    poly = [((px * s + 1.5) * k, (py * s + 1.5) * k) for px, py in pts]
    shadow = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(px + 1.2 * k, py + 1.6 * k) for px, py in poly], fill=(0, 0, 0, 110))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(1.6 * k)))
    d = ImageDraw.Draw(img)
    d.polygon(poly, fill=(255, 255, 255, 255), outline=(20, 20, 28, 255), width=int(1.3 * k))
    sprite = img.resize((size[0] // k, size[1] // k), Image.LANCZOS)
    return sprite, (int(1.5 * s), int(1.5 * s))


def keycap(label, alpha):
    font = ImageFont.truetype(FONT, 17)
    font.set_variation_by_axes([100, 600])
    l, t, r, b = font.getbbox(label)
    w, h = r - l + 32, 38
    k = 4
    big = Image.new('RGBA', (w * k, h * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle((0, 0, w * k - 1, h * k - 1), radius=11 * k, fill=(22, 21, 32, 215),
                        outline=(255, 255, 255, 60), width=k)
    cap = big.resize((w, h), Image.LANCZOS)
    ImageDraw.Draw(cap).text((16 - l, (h - (b - t)) / 2 - t), label, font=font, fill=(240, 241, 245, 255))
    if alpha < 1:
        a = cap.getchannel('A').point(lambda v: int(v * alpha))
        cap.putalpha(a)
    return cap


def render(segments):
    """Frames with the pointer, clicks and keys drawn on, and durations."""
    sprite, hot = cursor_sprite()
    frames = []
    for name, length, hold, data in segments:
        info = json.load(open(f'{data}/frames.json'))
        marks = info['marks']
        presses = [(m['t'], next((n['t'] for n in marks if n['kind'] == 'release' and n['t'] > m['t']), 1e9))
                   for m in marks if m['kind'] == 'press']
        times = [f['t'] for f in info['frames']] + [length]
        for i, f in enumerate(info['frames']):
            t = f['t']
            im = Image.open(f'{data}/f{i:03d}.png').convert('RGB').resize(
                (GIF_W, int(SCREEN[1] * SCALE)), Image.LANCZOS).convert('RGBA')
            px, py = f['x'] * SCALE, f['y'] * SCALE
            over = Image.new('RGBA', im.size, (0, 0, 0, 0))
            d = ImageDraw.Draw(over)
            for m in marks:
                age = (t - m['t']) / 1000
                if m['kind'] == 'click' and 0 <= age < 0.4:
                    p = age / 0.4
                    r = 7 + 17 * p
                    cx, cy = m['x'] * SCALE, m['y'] * SCALE
                    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, int(220 * (1 - p))), width=2)
            if any(a <= t < b for a, b in presses):
                d.ellipse((px - 11, py - 11, px + 11, py + 11), fill=(255, 255, 255, 70))
            im.alpha_composite(over)
            im.alpha_composite(sprite, (int(px - hot[0]), int(py - hot[1])))
            keys = [m for m in marks if m['kind'] == 'key' and 0 <= (t - m['t']) / 1000 < 1.0]
            if keys:
                age = (t - keys[-1]['t']) / 1000
                alpha = min(1, age / 0.08, (1.0 - age) / 0.25)
                cap = keycap(keys[-1]['label'], max(0, alpha))
                im.alpha_composite(cap, ((im.width - cap.width) // 2, im.height - cap.height - 28))
            frames.append([im.convert('RGB'), max(20, int(times[i + 1] - t))])
        frames[-1][1] += hold
    return frames


BAYER = np.array([[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
                  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
                  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
                  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]], np.float32) / 64 - 0.5


def encode(frames, path, fade_steps=8):
    # fade the last frame into the first so the loop has no jump cut
    first, last = frames[0][0], frames[-1][0]
    for k in range(1, fade_steps + 1):
        frames.append([Image.blend(last, first, k / (fade_steps + 1)), 50])
    merged = []
    for im, dur in frames:
        if merged and np.array_equal(np.asarray(im), np.asarray(merged[-1][0])):
            merged[-1][1] += dur
        else:
            merged.append([im, dur])

    # one palette for the whole GIF
    sample = merged[::max(1, len(merged) // 24)]
    mosaic = Image.new('RGB', (GIF_W, sample[0][0].height * len(sample)))
    for i, (im, _) in enumerate(sample):
        mosaic.paste(im, (0, i * im.height))
    palette = mosaic.quantize(TRANSPARENT, method=Image.Quantize.LIBIMAGEQUANT, dither=Image.Dither.NONE)
    colours = palette.getpalette()[:TRANSPARENT * 3] + [0, 0, 0]

    def indices(rgb):
        return np.asarray(Image.fromarray(rgb).quantize(palette=palette, dither=Image.Dither.NONE))

    # Ordered dithering keeps the wallpaper's gradients from banding, but
    # only where the picture holds still; moving areas are left plain
    # (banding doesn't show in motion and noise costs bytes). Pixels that
    # did not change are written as transparent, so each frame stores only
    # what moved.
    h, w = merged[0][0].height, GIF_W
    noise = np.tile(BAYER, (h // 8 + 1, w // 8 + 1))[:h, :w, None] * 7
    out, shown, previous = [], None, None
    for im, _ in merged:
        rgb = np.asarray(im)
        dithered = indices(np.clip(rgb + noise, 0, 255).astype(np.uint8))
        if previous is None:
            idx = dithered
        else:
            moving = Image.fromarray((np.any(rgb != previous, axis=2) * 255).astype(np.uint8))
            moving = np.asarray(moving.filter(ImageFilter.MaxFilter(5))) > 0
            idx = np.where(moving, indices(rgb), dithered)
        frame = idx if shown is None else np.where(idx == shown, TRANSPARENT, idx)
        shown, previous = idx, rgb
        p = Image.fromarray(frame.astype(np.uint8), 'P')
        p.putpalette(colours)
        p.info['transparency'] = TRANSPARENT
        out.append(p)
    out[0].save(path, save_all=True, append_images=out[1:], duration=[d for _, d in merged],
                loop=0, optimize=False, disposal=1, transparency=TRANSPARENT)
    return len(merged), sum(d for _, d in merged)


def gif():
    start()
    # a fresh layout, and a clock that doesn't move on between takes
    js('const L = cubbyTest.layer(); L._settings.set_string("layouts", "{}"); '
       'L._settings.set_string("folder-orders", "{}"); cubbyTest.move(1250, 700); '
       'L.clock._update(); L.clock._update = () => {}; 1')
    time.sleep(1)
    segments = []
    for name, length, steps, hold in STORYBOARD:
        segments.append((name, length, hold, record(name, length, steps)))
        time.sleep(0.3)
    nest('stop')
    frames = render(segments)
    n, ms = encode(frames, f'{OUT}/demo.gif')
    print(f'demo.gif: {n} frames, {ms / 1000:.1f}s')


if __name__ == '__main__':
    what = os.environ.get('ONLY', 'all')
    if what in ('all', 'stills'):
        stills()
    if what in ('all', 'gif'):
        gif()
    for f in sorted(os.listdir(OUT)):
        print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KiB')
