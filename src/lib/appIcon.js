// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// An app's icon as tiles, folders and search results show it: the icon,
// a bar of window pips under it and, for apps installed since the last
// open, a "New" marker.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

const MAX_PIPS = 3;
const PRESS_SCALE = 0.95;

/** "running, 2 windows", or '' when the app is not running. */
export function runningText(app) {
    if (app.state !== Shell.AppState.RUNNING)
        return '';
    const n = app.get_n_windows();
    return ngettext('running, %d window', 'running, %d windows', n).format(n);
}

/** Name for screen readers, with the running state and any extra text. */
export function accessibleName(app, ...extra) {
    return [app.get_name(), ...extra, runningText(app)].filter(Boolean).join(', ');
}

/** Shrinks a button a little while it is held down. */
export function addPressFeedback(button) {
    button.set_pivot_point(0.5, 0.5);
    button.connect('notify::pressed', () => {
        const scale = button.pressed ? PRESS_SCALE : 1;
        button.ease({
            scale_x: scale,
            scale_y: scale,
            duration: button.pressed ? 90 : 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    });
}

// One pip per window up to three, the focused app's first pip wide. The
// pips stay neutral: the accent colour means "selected".
const Pips = GObject.registerClass(
class Pips extends St.BoxLayout {
    _init(small) {
        super._init({
            style_class: small ? 'cubby-pips cubby-pips-small' : 'cubby-pips',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            translation_y: small ? 6 : 8,
        });
        this._small = small;
    }

    update(app, focused) {
        const windows = app.state === Shell.AppState.RUNNING
            ? Math.max(1, Math.min(MAX_PIPS, app.get_n_windows())) : 0;
        const count = this._small ? Math.min(windows, 1) : windows;
        while (this.get_n_children() > count)
            this.get_last_child().destroy();
        while (this.get_n_children() < count)
            this.add_child(new St.Widget({style_class: 'cubby-pip'}));
        this.get_children().forEach((pip, i) => {
            if (i === 0 && focused && !this._small)
                pip.add_style_class_name('cubby-pip-focused');
            else
                pip.remove_style_class_name('cubby-pip-focused');
        });
        this.visible = count > 0;
    }
});

export const AppIcon = GObject.registerClass(
class AppIcon extends St.Widget {
    /**
     * @param {Shell.App} app
     * @param {number} size - icon size in pixels
     * @param {object} [params]
     * @param {boolean} [params.small] - a mini icon in an overflow preview
     * @param {boolean} [params.isNew] - installed since the last open
     */
    _init(app, size, {small = false, isNew = false} = {}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            width: size,
            height: size,
        });
        this.app = app;
        this.icon = new St.Icon({
            style_class: small ? null : 'cubby-icon',
            gicon: app.get_icon(),
            fallback_icon_name: 'application-x-executable',
            icon_size: size,
        });
        this.add_child(this.icon);
        this._pips = new Pips(small);
        this.add_child(this._pips);

        if (isNew && small) {
            this.add_child(new St.Widget({
                style_class: 'cubby-new-dot',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
                translation_x: 3,
                translation_y: -3,
            }));
        } else if (isNew) {
            this.add_child(new St.Label({
                style_class: 'cubby-new',
                text: _('New'),
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
                translation_x: 12,
                translation_y: -6,
            }));
        }
    }

    updateRunning(focusApp) {
        this._pips.update(this.app, focusApp === this.app);
    }
});
