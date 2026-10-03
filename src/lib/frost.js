// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Frosted glass (optional): one blurred copy of the wallpaper, shown only
// inside the tiles. There is no live blur: the wallpaper sample (96px wide,
// already cropped to the monitor) is box-blurred once in JS when the
// wallpaper changes and stretched over the monitor with linear filtering.
// One GLSL effect masks it to the tiles' rounded rectangles; their rects and
// opacities are refreshed on frames that are being drawn anyway.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

const MAX_RECTS = 48;
const BLUR_PASSES = 3;
const BLUR_RADIUS = 2;

const DECL = `
uniform vec4 rects[${MAX_RECTS}];
uniform float alphas[${MAX_RECTS}];
uniform float count;
uniform vec2 size;
uniform float radius;
float rounded_rect(vec2 p, vec4 r, float rad) {
    vec2 h = r.zw * 0.5;
    vec2 q = abs(p - (r.xy + h)) - h + rad;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
`;

const CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
float a = 0.0;
for (int i = 0; i < ${MAX_RECTS}; i++) {
    if (float(i) >= count)
        break;
    float d = rounded_rect(p, rects[i], radius);
    a = max(a, clamp(0.5 - d, 0.0, 1.0) * alphas[i]);
}
cogl_color_out *= a;
`;

const FrostMask = GObject.registerClass(
class FrostMask extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._loc = {
            rects: this.get_uniform_location('rects'),
            alphas: this.get_uniform_location('alphas'),
            count: this.get_uniform_location('count'),
            size: this.get_uniform_location('size'),
            radius: this.get_uniform_location('radius'),
        };
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECL, CODE, false);
    }

    /** @param {Array} rects - [{x, y, width, height, alpha}] in actor pixels */
    update(rects, width, height, radius) {
        const n = Math.min(MAX_RECTS, rects.length);
        const flat = new Array(MAX_RECTS * 4).fill(0);
        const alphas = new Array(MAX_RECTS).fill(0);
        for (let i = 0; i < n; i++) {
            const r = rects[i];
            flat.splice(i * 4, 4, r.x, r.y, r.width, r.height);
            alphas[i] = r.alpha;
        }
        this.set_uniform_float(this._loc.rects, 4, flat);
        this.set_uniform_float(this._loc.alphas, 1, alphas);
        this.set_uniform_float(this._loc.count, 1, [n]);
        this.set_uniform_float(this._loc.size, 2, [width, height]);
        this.set_uniform_float(this._loc.radius, 1, [radius]);
        this.queue_repaint();
    }
});

/** Separable box blur on an RGB(A) sample, repeated to approach a Gaussian. */
function blurSample(sample) {
    const {width: w, height: h, n, stride, data} = sample;
    const src = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            for (let c = 0; c < 3; c++)
                src[(y * w + x) * 3 + c] = data[y * stride + x * n + c];
        }
    }
    const dst = new Float32Array(src.length);
    const pass = (horizontal, from, to) => {
        const len = horizontal ? w : h, lines = horizontal ? h : w;
        for (let l = 0; l < lines; l++) {
            for (let i = 0; i < len; i++) {
                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    for (let k = -BLUR_RADIUS; k <= BLUR_RADIUS; k++) {
                        const j = Math.min(len - 1, Math.max(0, i + k));
                        const idx = horizontal ? (l * w + j) : (j * w + l);
                        sum += from[idx * 3 + c];
                    }
                    const out = horizontal ? (l * w + i) : (i * w + l);
                    to[out * 3 + c] = sum / (2 * BLUR_RADIUS + 1);
                }
            }
        }
    };
    for (let k = 0; k < BLUR_PASSES; k++) {
        pass(true, src, dst);
        pass(false, dst, src);
    }
    const bytes = new Uint8Array(w * h * 3);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = Math.round(src[i]);
    return bytes;
}

export const Frost = GObject.registerClass(
class Frost extends St.Widget {
    _init() {
        super._init({
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
        this.set_content_scaling_filters(Clutter.ScalingFilter.LINEAR, Clutter.ScalingFilter.LINEAR);
        this._mask = new FrostMask();
        this.add_effect_with_name('frost-mask', this._mask);
        this._key = '';
    }

    /** New wallpaper sample, or null (plain colour: no frost). */
    setSample(sample) {
        if (!sample) {
            this.set_content(null);
            return;
        }
        const bytes = blurSample(sample);
        const content = St.ImageContent.new_with_preferred_size(sample.width, sample.height);
        const ctx = global.stage.context.get_backend().get_cogl_context();
        content.set_bytes(ctx, new GLib.Bytes(bytes), Cogl.PixelFormat.RGB_888,
            sample.width, sample.height, sample.width * 3);
        this.set_content(content);
    }

    /**
     * @param {Array} rects - tile rects in this actor's pixels, with alpha
     * @param {number} radius - corner radius
     */
    setRects(rects, radius) {
        const key = rects.map(r => `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)},${r.alpha.toFixed(2)}`).join(';');
        if (key === this._key)
            return;
        this._key = key;
        this._mask.update(rects, this.width, this.height, radius);
    }
});
