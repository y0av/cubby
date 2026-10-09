// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Small helpers shared by the layer's modules.

import Gio from 'gi://Gio';

/** A JSON object stored in a string setting, or {} if empty or unreadable. */
export function readJson(settings, key) {
    try {
        const value = JSON.parse(settings.get_string(key) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

/** The actor or its nearest ancestor, below `stop`, for which `test` holds. */
export function findAncestor(actor, test, stop = null) {
    for (let a = actor; a && a !== stop; a = a.get_parent()) {
        if (test(a))
            return a;
    }
    return null;
}

/** An actor's transformed extents as {x, y, width, height} in stage pixels. */
export function extents(actor) {
    const e = actor.get_transformed_extents();
    return {x: e.get_x(), y: e.get_y(), width: e.get_width(), height: e.get_height()};
}

export function setStyleClass(actor, name, on) {
    if (on)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

export function isCancelled(error) {
    return !!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}
