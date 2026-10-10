// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// A 96px wide sample of the wallpaper. The scrim and clock go by its mean
// luminance; the clock halo and frosted glass use the pixels.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {parseHex} from './theme.js';
import {isCancelled} from './util.js';

const DECODE_W = 192;
const SAMPLE_W = 96;
const DEFAULT_LUMINANCE = 0.3;

// on the gamma-encoded values, unlike luminance() in theme.js
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function meanLuminance(pixbuf) {
    const px = pixbuf.get_pixels();
    const n = pixbuf.get_n_channels(), stride = pixbuf.get_rowstride();
    const w = pixbuf.get_width(), h = pixbuf.get_height();
    let sum = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * stride + x * n;
            sum += luma(px[i], px[i + 1], px[i + 2]);
        }
    }
    return sum / (w * h);
}

function colorLuminance(hex) {
    const rgb = parseHex(hex);
    return rgb ? luma(...rgb) : DEFAULT_LUMINANCE;
}

// Emits 'changed' when the wallpaper changes, including a switch between its
// light and dark versions.
export class WallpaperWatcher extends Signals.EventEmitter {
    // aspect() returns the monitor's width / height
    constructor(aspect = () => 16 / 10) {
        super();
        this._aspect = aspect;
        this.luminance = DEFAULT_LUMINANCE;
        this.sample = null;
        this._cancellable = null;
        this._bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const update = () => this._update();
        this._bg.connectObject('changed::picture-uri', update, 'changed::picture-uri-dark', update,
            'changed::picture-options', update, 'changed::primary-color', update, this);
        this._iface.connectObject('changed::color-scheme', update, this);
        this._update();
    }

    destroy() {
        this._cancellable?.cancel();
        this._bg.disconnectObject(this);
        this._iface.disconnectObject(this);
    }

    // the region is in fractions of the wallpaper; null until there's a sample
    regionExtremes(fx0, fy0, fx1, fy1, relLum) {
        const smp = this.sample;
        if (!smp)
            return null;
        const x0 = Math.max(0, Math.floor(fx0 * smp.width)), x1 = Math.min(smp.width - 1, Math.ceil(fx1 * smp.width));
        const y0 = Math.max(0, Math.floor(fy0 * smp.height)), y1 = Math.min(smp.height - 1, Math.ceil(fy1 * smp.height));
        let brightest = null, darkest = null, lb = -1, ld = 2;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const i = y * smp.stride + x * smp.n;
                const c = [smp.data[i], smp.data[i + 1], smp.data[i + 2]];
                const l = relLum(c);
                if (l > lb) {
                    lb = l;
                    brightest = c;
                }
                if (l < ld) {
                    ld = l;
                    darkest = c;
                }
            }
        }
        return {brightest, darkest};
    }

    // a centre crop to the monitor's aspect is what the "zoom" option shows
    _cropToMonitor(pb) {
        const A = this._aspect();
        let w = pb.get_width(), h = pb.get_height(), x = 0, y = 0;
        if (w / h > A) {
            const cw = Math.round(h * A);
            x = Math.floor((w - cw) / 2);
            w = cw;
        } else {
            const ch = Math.round(w / A);
            y = Math.floor((h - ch) / 2);
            h = ch;
        }
        const sub = pb.new_subpixbuf(x, y, Math.max(1, w), Math.max(1, h));
        return sub.scale_simple(SAMPLE_W, Math.max(1, Math.round(SAMPLE_W / A)), GdkPixbuf.InterpType.BILINEAR);
    }

    // for when the monitor's aspect changes
    refresh() {
        this._update();
    }

    _uri() {
        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        const key = dark ? 'picture-uri-dark' : 'picture-uri';
        return this._bg.get_string(key) || this._bg.get_string('picture-uri');
    }

    async _update() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const uri = this._uri();
        let lum = DEFAULT_LUMINANCE, sample = null;
        if (this._bg.get_string('picture-options') === 'none' || !uri || uri.endsWith('.xml')) {
            // plain colour, or a slideshow we don't decode
            lum = colorLuminance(this._bg.get_string('primary-color'));
        } else {
            try {
                const pixbuf = this._cropToMonitor(await this._decode(uri, cancellable));
                lum = meanLuminance(pixbuf);
                sample = {
                    data: pixbuf.get_pixels(),
                    n: pixbuf.get_n_channels(),
                    stride: pixbuf.get_rowstride(),
                    width: pixbuf.get_width(),
                    height: pixbuf.get_height(),
                };
            } catch (e) {
                if (isCancelled(e))
                    return;
            }
        }
        if (cancellable.is_cancelled())
            return;
        this.sample = sample;
        this.luminance = lum;
        this.emit('changed', lum);
    }

    async _decode(uri, cancellable) {
        const file = Gio.File.new_for_uri(uri);
        const stream = await new Promise((resolve, reject) => {
            file.read_async(0, cancellable, (f, res) => {
                try {
                    resolve(f.read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        try {
            return await new Promise((resolve, reject) => {
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, DECODE_W, -1, true,
                    cancellable, (_s, res) => {
                        try {
                            resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
        } finally {
            stream.close_async(0, null, null);
        }
    }
}
