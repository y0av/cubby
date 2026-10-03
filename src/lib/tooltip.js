// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Tooltip shown above overflow previews (and icons when names are hidden),
// for the hovered or keyboard-selected item.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const GAP = 8;

export const Tooltip = GObject.registerClass(
class Tooltip extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'cubby-tooltip',
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._main = new St.Label({style_class: 'cubby-tooltip-main', y_align: Clutter.ActorAlign.CENTER});
        this._sub = new St.Label({style_class: 'cubby-tooltip-sub', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._main);
        this.add_child(this._sub);
        this.target = null;
    }

    /** Shows [main, secondary] text above `target`, or hides with null. */
    showFor(target, [main, sub] = []) {
        this.target = target;
        if (!target) {
            this.remove_all_transitions();
            this.ease({opacity: 0, duration: 120, onComplete: () => this.hide()});
            return;
        }
        this._main.text = main;
        this._sub.text = sub ?? '';
        this._sub.visible = !!sub;
        if (!this.visible)
            this.opacity = 0;
        this.show();
        const parent = this.get_parent();
        const [px, py] = parent.get_transformed_position();
        const ext = target.get_transformed_extents();
        const [, natW] = this.get_preferred_width(-1);
        const [, natH] = this.get_preferred_height(natW);
        const x = Math.round(ext.get_x() - px + (ext.get_width() - natW) / 2);
        const y = Math.round(ext.get_y() - py - natH - GAP);
        this.set_position(Math.max(8, Math.min(parent.width - natW - 8, x)), Math.max(8, y));
        this.remove_all_transitions();
        this.translation_y = 4;
        this.ease({opacity: 255, translation_y: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
});
