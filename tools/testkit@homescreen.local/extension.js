// Development only: lets tools/nest.sh drive the nested shell over D-Bus.
// Turns on unsafe mode (Eval, Screenshot) and exposes globalThis.hsTest with
// synthetic input and frame timing helpers.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const now = () => GLib.get_monotonic_time();

class TestApi {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this.log = [];
    }

    layer() {
        return Main.layoutManager.uiGroup.get_children().find(c => c.name === 'homescreenLayer');
    }

    keyDown(keyval) {
        this._kbd.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
    }

    keyUp(keyval) {
        this._kbd.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
    }

    // key('a'), key('Escape'), key('e', ['Control_L']), key('Return')
    key(name, mods = []) {
        const kv = k => (k.length === 1 ? Clutter.unicode_to_keysym(k.codePointAt(0)) : Clutter[`KEY_${k}`]);
        mods.forEach(m => this.keyDown(kv(m)));
        this.keyDown(kv(name));
        this.keyUp(kv(name));
        mods.slice().reverse().forEach(m => this.keyUp(kv(m)));
    }

    type(text) {
        for (const ch of text)
            this.key(ch);
    }

    move(x, y) {
        this._ptr.notify_absolute_motion(now(), x, y);
    }

    click(x, y, button = Clutter.BUTTON_PRIMARY) {
        this.move(x, y);
        this._ptr.notify_button(now(), button, Clutter.ButtonState.PRESSED);
        this._ptr.notify_button(now(), button, Clutter.ButtonState.RELEASED);
    }

    press(x, y, button = Clutter.BUTTON_PRIMARY) {
        this.move(x, y);
        this._ptr.notify_button(now(), button, Clutter.ButtonState.PRESSED);
    }

    release(button = Clutter.BUTTON_PRIMARY) {
        this._ptr.notify_button(now(), button, Clutter.ButtonState.RELEASED);
    }

    // Glides the pointer from the current press point to (x, y) over ms.
    glide(x0, y0, x1, y1, ms = 400, done = null) {
        const t0 = now();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const k = Math.min(1, (now() - t0) / 1000 / ms);
            this.move(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k);
            if (k < 1)
                return GLib.SOURCE_CONTINUE;
            done?.();
            return GLib.SOURCE_REMOVE;
        });
        return id;
    }

    // Records presentation intervals until stopFrames(); returns stats.
    startFrames() {
        this._frames = [];
        this._framesId = global.stage.connect('after-paint', () => this._frames.push(now()));
    }

    stopFrames() {
        global.stage.disconnect(this._framesId);
        const t = this._frames;
        const d = t.slice(1).map((v, i) => (v - t[i]) / 1000);
        d.sort((a, b) => a - b);
        const pct = p => d[Math.min(d.length - 1, Math.floor(d.length * p))];
        return {
            frames: t.length,
            spanMs: t.length ? (t[t.length - 1] - t[0]) / 1000 : 0,
            p50: pct(0.5), p95: pct(0.95), max: d[d.length - 1],
            over20ms: d.filter(v => v > 20).length,
        };
    }

    destroy() {
        this._kbd.run_dispose?.();
        this._ptr.run_dispose?.();
    }
}

export default class TestKit extends Extension {
    enable() {
        global.context.unsafe_mode = true;
        globalThis.hsTest = new TestApi();
    }

    disable() {
        globalThis.hsTest?.destroy();
        delete globalThis.hsTest;
        global.context.unsafe_mode = false;
    }
}
