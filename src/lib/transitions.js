// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// How the layer opens, closes and launches apps.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

// Opening, the tiles rise in a wave from the top-left corner, where the
// Show Apps button usually is. The wave takes the same time whatever the
// size of the grid.
const OPEN_SPREAD_MS = 220;
const OPEN_TILE_MS = 480;
const OPEN_FADE_MS = 320;
const CLOSE_SPREAD_MS = 110;
const CLOSE_TILE_MS = 220;
const CLOSE_FADE_MS = 180;
const LAUNCH_MS = 280;
const LAUNCH_ZOOM = 1.06;
const LAUNCH_ICON_SCALE = 1.4;

// 0 for the top-left cell, 1 for the bottom-right one
function waveOrder(rect, {cols, rows}) {
    const far = cols - 1 + 1.4 * (rows - 1);
    return far > 0 ? Math.min(1, (rect.x + 1.4 * rect.y) / far) : 0;
}

/** Puts a tile back at rest, stopping any open or close animation. */
export function settleTile(tile) {
    for (const prop of ['opacity', 'scale-x', 'scale-y', 'translation-y'])
        tile.remove_transition(prop);
    tile.opacity = 255;
    tile.set_scale(1, 1);
    tile.translation_y = 0;
}

/**
 * @param {Tile[]} tiles - every tile; only those on `page` animate
 * @param {number} page - the page being shown
 * @param {object} grid - metrics from computeGrid
 * @param {St.Widget} field - the search field, which drops in
 */
export function animateOpen(tiles, page, grid, field) {
    for (const tile of tiles) {
        settleTile(tile);
        if (tile.rect.page !== page)
            continue;
        const delay = Math.round(OPEN_SPREAD_MS * waveOrder(tile.rect, grid));
        tile.opacity = 0;
        tile.set_scale(0.88, 0.88);
        tile.translation_y = 26;
        // opacity must not overshoot: it would wrap past 255 and blink
        tile.ease({opacity: 255, delay, duration: OPEN_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        tile.ease({
            scale_x: 1, scale_y: 1, translation_y: 0,
            delay,
            duration: OPEN_TILE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }
    field.remove_all_transitions();
    field.set_pivot_point(0.5, 0.5);
    field.opacity = 0;
    field.translation_y = -14;
    field.set_scale(0.97, 0.97);
    field.ease({opacity: 255, delay: 40, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    field.ease({
        translation_y: 0, scale_x: 1, scale_y: 1,
        delay: 40,
        duration: 420,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    });
}

/**
 * The reverse wave, faster, with the tiles sinking. Everything in `faders`
 * fades out with them.
 *
 * @returns {number} how long it takes, in ms
 */
export function animateClose(tiles, page, grid, faders) {
    let longest = 0;
    for (const tile of tiles) {
        if (tile.rect.page !== page || !tile.visible)
            continue;
        const delay = Math.round(CLOSE_SPREAD_MS * (1 - waveOrder(tile.rect, grid)));
        tile.ease({opacity: 0, delay, duration: CLOSE_FADE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        tile.ease({
            scale_x: 0.92, scale_y: 0.92, translation_y: 14,
            delay,
            duration: CLOSE_TILE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        longest = Math.max(longest, delay + CLOSE_TILE_MS);
    }
    for (const actor of faders) {
        if (actor.visible)
            actor.ease({opacity: 0, duration: CLOSE_FADE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
    }
    return longest;
}

/**
 * Launching an app: its icon swells and fades while `layer` grows a little
 * towards it and everything in `faders` fades, as if going into the app.
 *
 * @returns {number} how long it takes, in ms
 */
export function animateLaunch(layer, icon, faders) {
    icon.set_pivot_point(0.5, 0.5);
    icon.ease({
        scale_x: LAUNCH_ICON_SCALE,
        scale_y: LAUNCH_ICON_SCALE,
        duration: LAUNCH_MS,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
    icon.ease({opacity: 0, duration: LAUNCH_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});

    const [x, y] = icon.get_transformed_position();
    const [w, h] = icon.get_transformed_size();
    const [lx, ly] = layer.get_transformed_position();
    layer.set_pivot_point((x + w / 2 - lx) / layer.width, (y + h / 2 - ly) / layer.height);
    layer.ease({
        scale_x: LAUNCH_ZOOM,
        scale_y: LAUNCH_ZOOM,
        duration: LAUNCH_MS,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
    for (const actor of faders) {
        if (actor.visible)
            actor.ease({opacity: 0, duration: LAUNCH_MS, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
    }
    return LAUNCH_MS;
}

/** Puts a launched icon back the way it was. */
export function resetLaunchIcon(icon) {
    icon.remove_all_transitions();
    icon.set_scale(1, 1);
    icon.opacity = 255;
}

/** Eases a blur on an actor, adding the effect first and dropping it at 0. */
export function easeBlur(actor, name, radius, duration) {
    if (!actor.get_effect(name)) {
        if (radius === 0)
            return;
        actor.add_effect_with_name(name, new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: 0,
            brightness: 1,
        }));
    }
    actor.ease_property(`@effects.${name}.radius`, radius, {
        duration,
        onComplete: () => {
            if (radius === 0)
                actor.remove_effect_by_name(name);
        },
    });
}
