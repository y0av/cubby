// Mean luminance of the current wallpaper, sampled once per wallpaper change
// from a small downscaled decode (asynchronous, off the main loop's
// critical path). Drives the scrim strength and the clock colour.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const SAMPLE_W = 48;
const SAMPLE_H = 30;
export const DEFAULT_LUMINANCE = 0.3;

/** Mean of 0.2126R + 0.7152G + 0.0722B over pixels, 0..1 (the sketch's adaptScrim). */
export function meanLuminance(pixbuf) {
    const px = pixbuf.get_pixels();
    const n = pixbuf.get_n_channels(), stride = pixbuf.get_rowstride();
    const w = pixbuf.get_width(), h = pixbuf.get_height();
    let sum = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * stride + x * n;
            sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
        }
    }
    return sum / (w * h);
}

function colorLuminance(hex) {
    const m = /^#?([0-9a-f]{6})/i.exec(hex ?? '');
    if (!m)
        return DEFAULT_LUMINANCE;
    const n = parseInt(m[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Emits 'changed' (luminance) when the wallpaper or colour scheme changes. */
export class WallpaperWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this.luminance = DEFAULT_LUMINANCE;
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

    /**
     * Brightest and darkest sampled pixel (WCAG relative luminance) in a
     * region given as fractions of the wallpaper, or null without a sample.
     */
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
        let lum, sample = null;
        if (this._bg.get_string('picture-options') === 'none' || !uri || uri.endsWith('.xml')) {
            // plain colour, or a slideshow we don't decode
            lum = colorLuminance(this._bg.get_string('primary-color'));
        } else {
            try {
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
                const pixbuf = await new Promise((resolve, reject) => {
                    GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, SAMPLE_W, SAMPLE_H, false,
                        cancellable, (_s, res) => {
                            try {
                                resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        });
                });
                stream.close_async(0, null, null);
                lum = meanLuminance(pixbuf);
                sample = {
                    data: pixbuf.get_pixels(),
                    n: pixbuf.get_n_channels(),
                    stride: pixbuf.get_rowstride(),
                    width: pixbuf.get_width(),
                    height: pixbuf.get_height(),
                };
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                lum = DEFAULT_LUMINANCE;
            }
        }
        if (cancellable.is_cancelled())
            return;
        this.sample = sample;
        this.luminance = lum;
        this.emit('changed', lum);
    }
}
