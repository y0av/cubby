#!/usr/bin/env python3
"""Screenshots and the demo GIF for the README, from the nested shell.

Uses generic data (GNOME's default folders plus category groups over the
system's apps, no personal folders), two test wallpapers and the blue
accent. Animations are captured in slow motion through St's
slow-down factor and retimed in the GIF.

Usage: tools/readme-media.py WALLPAPER_DIR [OUTDIR]
WALLPAPER_DIR holds w0.png (alpine dusk) and w1.png (beach noon).
"""
import os
import subprocess
import sys
import tempfile
import time

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEST = os.path.join(ROOT, 'tools', 'nest.sh')
WALLS = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'shots', 'readme')
os.makedirs(OUT, exist_ok=True)
GIF_W = 720
SLOW = 20


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
    """Screenshot over one long-lived D-Bus connection (much faster than
    spawning gdbus per frame)."""
    _connection().call_sync('org.gnome.Shell', '/org/gnome/Shell/Screenshot',
                            'org.gnome.Shell.Screenshot', 'Screenshot',
                            GLib.Variant('(bbs)', (False, False, path)), None, 0, -1, None)


def start(wall, light=False):
    global _bus
    _bus = None
    args = ['start', '1920x1200', '--dtp', '--no-folders', '--no-local', '--accent', 'blue',
            '--wall', os.path.join(WALLS, wall)]
    if light:
        args.append('--light')
    nest(*args)
    js("const s = cubbyTest.layer()._settings; s.set_boolean('show-clock', true); s.set_boolean('tip-dismissed', true); 1")
    # one window to show the dimming
    js("imports.gi.Shell.AppSystem.get_default().lookup_app('org.gnome.TextEditor.desktop')?.activate(); 1")
    time.sleep(3)


def stills():
    start('w0.png')
    js('cubbyTest.layer().open(); 1')
    time.sleep(1.5)
    shot(f'{OUT}/dark.png')
    js("cubbyTest.type('te'); 1")
    time.sleep(1.5)
    shot(f'{OUT}/search.png')
    js("cubbyTest.key('Escape'); 1")
    time.sleep(0.6)
    js("const l = cubbyTest.layer(); const t = [...l.board.tiles.values()].find(t => t.slots.some(s => s.kind === 'more') && t.folder.apps.length > 8); l.openFolder(t.folder.id, t.slots.at(-1)); 1")
    time.sleep(1.2)
    shot(f'{OUT}/folder.png')
    js("cubbyTest.key('Escape'); 1")
    time.sleep(0.8)
    js("cubbyTest.key('e', ['Control_L']); 1")
    time.sleep(0.8)
    js("const t = [...cubbyTest.layer().board.tiles.values()][1]; const [x, y] = t.get_transformed_position(); cubbyTest.move(x + 60, y + 60); 1")
    time.sleep(0.8)
    shot(f'{OUT}/edit.png')
    js("cubbyTest.key('Escape'); 1")
    time.sleep(0.5)
    js("const t = [...cubbyTest.layer().board.tiles.values()][2]; const [x, y] = t.get_transformed_position(); cubbyTest.click(x + 220, y + 60, 3); 1")
    time.sleep(0.6)
    shot(f'{OUT}/menu.png')
    js("cubbyTest.key('Escape'); 1")
    nest('stop')

    start('w1.png', light=True)
    js('cubbyTest.layer().open(); 1')
    time.sleep(1.5)
    shot(f'{OUT}/light.png')
    nest('stop')


class Recorder:
    """Grabs frames as fast as screenshots allow; each frame's GIF duration
    is its real interval divided by the slow-down factor in force."""

    def __init__(self):
        self.frames = []
        self.dir = tempfile.mkdtemp(prefix='hsgif')
        self.slow = 1

    def set_slow(self, slow):
        if slow != self.slow:
            js(f'imports.gi.St.Settings.get().slow_down_factor = {slow}; 1')
            self.slow = slow

    def grab(self, seconds):
        end = time.monotonic() + seconds
        while True:
            t = time.monotonic()
            path = os.path.join(self.dir, f'{len(self.frames):04d}.png')
            shot(path)
            self.frames.append([path, t, self.slow])
            if t >= end:
                break

    def hold(self, seconds):
        """Repeats the last frame for `seconds` of GIF time."""
        if self.frames:
            self.frames.append([self.frames[-1][0], None, seconds])

    def save(self, path, min_ms=40):
        # frame list with real durations, then drop frames shorter than
        # min_ms (their time goes to the frame kept before them)
        timed = []
        for i, (p, t, slow) in enumerate(self.frames):
            if t is None:
                timed.append((None, int(slow * 1000)))
                continue
            nxt = next((f[1] for f in self.frames[i + 1:] if f[1] is not None), t + 0.1)
            timed.append((p, max(20, int((nxt - t) * 1000 / slow))))
        kept = []
        for p, dur in timed:
            if p is None or not kept or kept[-1][1] >= min_ms:
                kept.append([p, dur])
            else:
                kept[-1][1] += dur
        images, durations = [], []
        for p, dur in kept:
            if p is None:
                images.append(images[-1])
            else:
                im = Image.open(p).convert('RGB')
                im = im.resize((GIF_W, int(im.height * GIF_W / im.width)), Image.LANCZOS)
                images.append(im.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
            durations.append(dur)
        images[0].save(path, save_all=True, append_images=images[1:], duration=durations,
                       loop=0, optimize=True, disposal=1)


def gif():
    start('w0.png')
    r = Recorder()
    js("cubbyTest.move(960, 1190); 1")
    r.grab(0.1)
    r.hold(0.6)

    def step(code, seconds, slow):
        # set the slow-down first, so the animation the action starts uses it
        r.set_slow(slow)
        js(code)
        r.grab(seconds * slow)

    step('cubbyTest.layer().open(); 1', 1.3, SLOW)                       # open wave
    r.hold(0.8)
    step("cubbyTest.type('te'); 1", 0.5, SLOW)                            # results pop in
    r.hold(1.4)
    step("cubbyTest.key('Escape'); 1", 0.35, SLOW)
    step("const l = cubbyTest.layer(); const t = [...l.board.tiles.values()].find(t => t.slots.some(s => s.kind === 'more') && t.folder.apps.length > 8); const s = t.slots.at(-1); const [x, y] = s.get_transformed_position(); cubbyTest.click(x + s.width / 2, y + s.height / 2); 1", 0.6, SLOW)   # folder grows
    r.hold(1.2)
    step("cubbyTest.key('Escape'); 1", 0.5, SLOW)
    step("cubbyTest.layer()._theme._iface.set_string('color-scheme', 'default'); 1", 0.3, 1)
    r.hold(1.0)
    step("cubbyTest.key('e', ['Control_L']); 1", 1.4, 6)                  # wiggle
    step("cubbyTest.key('Escape'); cubbyTest.layer()._theme._iface.set_string('color-scheme', 'prefer-dark'); 1", 0.3, 1)
    r.hold(0.4)
    step('cubbyTest.layer().close(); 1', 0.5, SLOW)                       # close wave
    r.hold(0.6)
    r.set_slow(1)
    r.save(f'{OUT}/demo.gif')
    nest('stop')


if __name__ == '__main__':
    what = os.environ.get('ONLY', 'all')
    if what in ('all', 'stills'):
        stills()
    if what in ('all', 'gif'):
        gif()
    for f in sorted(os.listdir(OUT)):
        print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KiB')
