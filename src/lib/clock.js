// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Optional large clock and date chip under the search field. Ticks from
// GnomeDesktop.WallClock and follows the 12/24-hour setting.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {contrast, luminance} from './theme.js';

const HALO_SIZE = 300;
const HALO_STRETCH = 8 / 3;
const HALO_CONTRAST = 5;
const SHADE = [12, 12, 20];

export const Clock = GObject.registerClass(
class Clock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'cubby-clock',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            visible: false,
        });
        const row = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'cubby-clock-row'});
        this._time = new St.Label({style_class: 'cubby-clock-time', y_align: Clutter.ActorAlign.END});
        this._period = new St.Label({style_class: 'cubby-clock-period', y_align: Clutter.ActorAlign.END});
        row.add_child(this._time);
        row.add_child(this._period);
        this.add_child(row);
        this._date = new St.Label({style_class: 'cubby-clock-date', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._date);
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallClock = null;
        this.connect('destroy', () => this.stop());
    }

    /** Starts ticking (only while shown). */
    start() {
        if (!this._wallClock) {
            this._wallClock = new GnomeDesktop.WallClock();
            this._wallClock.connectObject('notify::clock', () => this._update(), this);
            this._iface.connectObject('changed::clock-format', () => this._update(), this);
        }
        this._update();
    }

    stop() {
        // dropping the last reference stops the WallClock's own timer
        this._wallClock?.disconnectObject(this);
        this._iface.disconnectObject(this);
        this._wallClock = null;
    }

    setBright(bright) {
        if (bright)
            this.add_style_class_name('cubby-clock-on-bright');
        else
            this.remove_style_class_name('cubby-clock-on-bright');
    }

    _update() {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._iface.get_string('clock-format') !== '12h';
        this._time.text = h24 ? now.format('%H:%M') : now.format('%l:%M').trim();
        this._period.text = h24 ? '' : now.format('%p');
        this._period.visible = !h24;
        /* Translators: date under the clock, strftime format */
        this._date.text = now.format(_('%A, %-d %B'));
    }
});

/**
 * A soft glow behind the clock, just strong enough for the digits to reach
 * 5:1 against the wallpaper under them, and often fully transparent. St's
 * radial gradient is circular, so a circle is drawn and stretched into an
 * ellipse around the digits.
 */
export const ClockHalo = GObject.registerClass(
class ClockHalo extends St.Widget {
    _init() {
        super._init({
            reactive: false,
            visible: false,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            scale_x: HALO_STRETCH,
        });
    }

    /** Centres the halo on (x, y). */
    place(x, y, scaleFactor) {
        const size = Math.round(HALO_SIZE * scaleFactor);
        this.set_size(size, size);
        this.set_position(Math.round(x - size / 2), Math.round(y - size / 2));
    }

    /**
     * Works out how strong the halo has to be over the wallpaper.
     *
     * @param {object} wallpaper - the WallpaperWatcher
     * @param {Array} region - [x0, y0, x1, y1] behind the digits, as
     *   fractions of the monitor
     * @param {number} scrim - the scrim's opacity over that region
     * @returns {boolean} whether any halo is needed
     */
    update(wallpaper, region, scrim) {
        // a bright wallpaper gets the dark clock and a light halo
        const bright = wallpaper.luminance > 0.5;
        const glow = bright ? [255, 255, 255] : SHADE;
        const text = bright ? [30, 30, 46] : [255, 255, 255];
        const extremes = wallpaper.regionExtremes(...region, luminance);
        let strength = 0;
        if (extremes) {
            const over = (top, alpha, bottom) => bottom.map((v, i) => top[i] * alpha + v * (1 - alpha));
            const behind = over(SHADE, scrim, bright ? extremes.darkest : extremes.brightest);
            while (strength < 0.9 && contrast(text, over(glow, strength, behind)) < HALO_CONTRAST)
                strength += 0.02;
        }
        // the outer digits sit at about 60% of the radius, where the
        // gradient has faded to 0.4 of its centre value
        const centre = Math.min(0.9, strength / 0.4).toFixed(2);
        const [r, g, b] = glow;
        this.style = 'background-gradient-direction: radial; ' +
            `background-gradient-start: rgba(${r}, ${g}, ${b}, ${centre}); ` +
            `background-gradient-end: rgba(${r}, ${g}, ${b}, 0);`;
        return strength > 0;
    }
});
