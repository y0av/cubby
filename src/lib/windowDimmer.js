// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Fades and slightly shrinks the windows on one monitor while the layer is
// open. Each window actor gets a pivot chosen so that the per-actor scale
// matches scaling the whole monitor about one point, which leaves the
// wallpaper (also inside window_group) untouched.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DIM_SCALE = 0.965;

export class WindowDimmer {
    constructor() {
        // actor -> values before the first dim; kept until a restore finishes
        this._orig = new Map();
        this._dimmed = new Set();
    }

    /**
     * @param {number} monitorIndex
     * @param {object} anim - {duration, mode}
     */
    dim(monitorIndex, {duration = 0, mode = Clutter.AnimationMode.EASE_OUT_CUBIC} = {}) {
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor)
            return;
        const px = monitor.x + monitor.width * 0.5;
        const py = monitor.y + monitor.height * 0.4;
        const workspace = global.workspace_manager.get_active_workspace();

        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || this._dimmed.has(actor) || !actor.visible)
                continue;
            if (win.minimized || win.get_monitor() !== monitorIndex)
                continue;
            if (!win.is_on_all_workspaces() && win.get_workspace() !== workspace)
                continue;

            if (!this._orig.has(actor)) {
                this._orig.set(actor, {
                    opacity: actor.opacity,
                    scaleX: actor.scale_x,
                    scaleY: actor.scale_y,
                    pivot: actor.pivot_point,
                });
                actor.connectObject('destroy', () => {
                    this._orig.delete(actor);
                    this._dimmed.delete(actor);
                }, this);
            }
            this._dimmed.add(actor);
            const w = Math.max(actor.width, 1), h = Math.max(actor.height, 1);
            actor.remove_all_transitions();
            actor.pivot_point = new Graphene.Point({x: (px - actor.x) / w, y: (py - actor.y) / h});
            actor.ease({opacity: 0, scale_x: DIM_SCALE, scale_y: DIM_SCALE, duration, mode});
        }
    }

    restore({duration = 0, mode = Clutter.AnimationMode.EASE_OUT_CUBIC} = {}) {
        const actors = [...this._dimmed];
        this._dimmed.clear();
        for (const actor of actors) {
            const saved = this._orig.get(actor);
            actor.remove_all_transitions();
            if (duration === 0) {
                this._finish(actor, saved);
                continue;
            }
            actor.ease({
                opacity: saved.opacity,
                scale_x: saved.scaleX,
                scale_y: saved.scaleY,
                duration,
                mode,
                onStopped: () => {
                    if (!this._dimmed.has(actor) && this._orig.get(actor) === saved)
                        this._finish(actor, saved);
                },
            });
        }
        if (duration === 0) {
            // also settle anything still easing back from an earlier restore
            for (const [actor, saved] of [...this._orig]) {
                actor.remove_all_transitions();
                if (this._orig.has(actor))
                    this._finish(actor, saved);
            }
        }
    }

    _finish(actor, saved) {
        actor.disconnectObject(this);
        actor.pivot_point = saved.pivot;
        actor.set_scale(saved.scaleX, saved.scaleY);
        actor.opacity = saved.opacity;
        this._orig.delete(actor);
    }
}
