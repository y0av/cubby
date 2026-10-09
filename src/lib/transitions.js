// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

// Tiles open in a wave from the top-left, where Show Apps usually is. The
// wave takes as long on a big grid as on a small one.
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

// Fades in while settling from `scale` and a translation of `dy`. Only the
// settle overshoots, since an overshooting opacity wraps past 255 and blinks.
export function popIn(actor, {scale = 1, dy = 0, delay = 0, fade, settle}) {
    actor.opacity = 0;
    actor.set_scale(scale, scale);
    actor.translation_y = dy;
    actor.ease({opacity: 255, delay, duration: fade, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    actor.ease({
        scale_x: 1, scale_y: 1, translation_y: 0,
        delay,
        duration: settle,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    });
}

export function settleTile(tile) {
    for (const prop of ['opacity', 'scale-x', 'scale-y', 'translation-y'])
        tile.remove_transition(prop);
    tile.opacity = 255;
    tile.set_scale(1, 1);
    tile.translation_y = 0;
}

// only the tiles on `page` animate; field is the search field
export function animateOpen(tiles, page, grid, field) {
    for (const tile of tiles) {
        settleTile(tile);
        if (tile.rect.page !== page)
            continue;
        popIn(tile, {
            scale: 0.88,
            dy: 26,
            delay: Math.round(OPEN_SPREAD_MS * waveOrder(tile.rect, grid)),
            fade: OPEN_FADE_MS,
            settle: OPEN_TILE_MS,
        });
    }
    field.remove_all_transitions();
    field.set_pivot_point(0.5, 0.5);
    popIn(field, {scale: 0.97, dy: -14, delay: 40, fade: 300, settle: 420});
}

// The opening wave reversed and faster. Returns its length in ms.
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

// The icon swells and fades while the layer zooms in a little towards it,
// as if going into the app. Returns the length in ms.
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

export function resetLaunchIcon(icon) {
    icon.remove_all_transitions();
    icon.set_scale(1, 1);
    icon.opacity = 255;
}

// adds the effect when needed and removes it once back at 0
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
