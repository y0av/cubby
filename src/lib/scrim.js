// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Darkest behind the search field, light over the middle of the board and
// a bit darker again at the bottom. Brighter wallpapers get more shade.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const TOP_END = 0.36;
const BOTTOM_START = 0.64;
const SHADE = '12, 12, 20';

// fy goes from 0 at the top of the monitor to 1 at the bottom
export function scrimAlpha(fy, luminance) {
    const top = 0.38 + luminance * 0.42;
    const middle = 0.04 + luminance * 0.3;
    if (fy < TOP_END)
        return top + (middle - top) * (fy / TOP_END);
    if (fy < BOTTOM_START)
        return middle;
    return middle + (top * 0.8 - middle) * ((fy - BOTTOM_START) / (1 - BOTTOM_START));
}

// St gradients have two stops, so the scrim is drawn as three bands.
export const Scrim = GObject.registerClass(
class Scrim extends St.Widget {
    _init() {
        super._init({opacity: 0, layout_manager: new Clutter.FixedLayout()});
        this._bands = [new St.Widget(), new St.Widget(), new St.Widget()];
        for (const band of this._bands)
            this.add_child(band);
    }

    setArea(width, height) {
        this.set_size(width, height);
        const y1 = Math.round(height * TOP_END);
        const y2 = Math.round(height * BOTTOM_START);
        const [top, middle, bottom] = this._bands;
        top.set_position(0, 0);
        top.set_size(width, y1);
        middle.set_position(0, y1);
        middle.set_size(width, y2 - y1);
        bottom.set_position(0, y2);
        bottom.set_size(width, height - y2);
    }

    setLuminance(luminance) {
        const alpha = fy => scrimAlpha(fy, luminance).toFixed(3);
        const gradient = (from, to) => 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgba(${SHADE}, ${from}); ` +
            `background-gradient-end: rgba(${SHADE}, ${to});`;
        const [top, middle, bottom] = this._bands;
        top.style = gradient(alpha(0), alpha(TOP_END));
        middle.style = `background-color: rgba(${SHADE}, ${alpha(0.5)});`;
        bottom.style = gradient(alpha(BOTTOM_START), alpha(1));
    }
});
