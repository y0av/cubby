// Optional large clock and date chip under the search field. Ticks from
// GnomeDesktop.WallClock and follows the 12/24-hour setting.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const Clock = GObject.registerClass(
class Clock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'hs-clock',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            visible: false,
        });
        const row = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'hs-clock-row'});
        this._time = new St.Label({style_class: 'hs-clock-time', y_align: Clutter.ActorAlign.END});
        this._period = new St.Label({style_class: 'hs-clock-period', y_align: Clutter.ActorAlign.END});
        row.add_child(this._time);
        row.add_child(this._period);
        this.add_child(row);
        this._date = new St.Label({style_class: 'hs-clock-date', x_align: Clutter.ActorAlign.CENTER});
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
        this._wallClock?.disconnectObject(this);
        this._iface.disconnectObject(this);
        this._wallClock?.run_dispose();
        this._wallClock = null;
    }

    setBright(bright) {
        if (bright)
            this.add_style_class_name('hs-clock-on-bright');
        else
            this.remove_style_class_name('hs-clock-on-bright');
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
