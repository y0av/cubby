// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Accent and light/dark style. The accent follows the system accent colour
// (org.gnome.desktop.interface accent-color, Adwaita values) unless the
// extension has a custom hex. The style follows color-scheme.

import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export const ACCENTS = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
};

const INK_DARK = '#1e1e2e';
const INK_LIGHT = '#ffffff';

export function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '');
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex, alpha) {
    const [r, g, b] = parseHex(hex) ?? [0, 0, 0];
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG relative luminance of an [r, g, b] colour (0-255). */
export function luminance([r, g, b]) {
    const lin = c => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

/** Emits 'changed' when the accent or the style changes. */
export class Theme extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const changed = () => this.emit('changed');
        this._iface.connectObject('changed::accent-color', changed,
            'changed::color-scheme', changed, this);
        this._settings.connectObject('changed::accent-override', changed, this);
    }

    destroy() {
        this._iface.disconnectObject(this);
        this._settings.disconnectObject(this);
    }

    get dark() {
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    get accent() {
        const custom = this._settings.get_string('accent-override');
        if (parseHex(custom))
            return `#${parseHex(custom).map(c => c.toString(16).padStart(2, '0')).join('')}`;
        return ACCENTS[this._iface.get_string('accent-color')] ?? ACCENTS.blue;
    }

    /** Text colour to put on an accent fill. */
    get accentInk() {
        const a = parseHex(this.accent);
        return contrast(a, parseHex(INK_LIGHT)) >= contrast(a, parseHex(INK_DARK)) ? INK_LIGHT : INK_DARK;
    }

    accentRgba(alpha) {
        return rgba(this.accent, alpha);
    }
}
