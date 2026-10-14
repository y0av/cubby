// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// An app dragged out of a folder, carried over the board until it is dropped
// on another folder's tile.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {AppIcon} from './appIcon.js';
import {PAGE_MS} from './board.js';
import {extents, setStyleClass} from './util.js';

const ICON = 72;
const EDGE_PX = 48;
const EDGE_FLIP_MS = 600;
const DROP_MS = 200;
const TARGET_SCALE = 1.04;

function highlight(tile, on) {
    if (!tile)
        return;
    setStyleClass(tile, 'cubby-tile-drop', on);
    const scale = on ? TARGET_SCALE : 1;
    tile.ease({scale_x: scale, scale_y: scale, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
}

export class AppCarry {
    constructor(layer, board) {
        this._layer = layer;
        this._board = board;
        this._drag = null;
        this._edgeId = 0;
        this._followId = 0;
    }

    destroy() {
        this.end(false);
    }

    get active() {
        return this._drag !== null;
    }

    // sourceId is the folder the app came from, which is no target
    begin(app, sourceId, x, y) {
        const ghost = new AppIcon(app, ICON);
        ghost.set_pivot_point(0.5, 0.5);
        this._layer.add_child(ghost);
        this._layer.set_child_above_sibling(ghost, null);
        this._drag = {app, sourceId, ghost, target: null, last: [x, y]};
        this.motion(x, y);
        ghost.opacity = 0;
        ghost.set_scale(0.8, 0.8);
        ghost.ease({opacity: 255, scale_x: 1.08, scale_y: 1.08, duration: 150});
    }

    // x, y are the pointer's stage coordinates
    motion(x, y) {
        const d = this._drag;
        if (!d)
            return;
        d.last = [x, y];
        const [, lx, ly] = this._layer.transform_stage_point(x, y);
        d.ghost.set_position(Math.round(lx - ICON / 2), Math.round(ly - ICON / 2));
        this._setTarget(this._tileAt(x, y));
        this._edgeCheck(x);
    }

    // returns {appId, folderId} to move, or null
    end(commit) {
        const d = this._drag;
        if (!d)
            return null;
        this._drag = null;
        this._cancelEdge();
        const target = d.target;
        highlight(target, false);
        const ghost = d.ghost;
        const drop = commit && target ? {appId: d.app.id, folderId: target.folder.id} : null;
        // fall into the tile, or fade where it was let go
        let to = {};
        if (drop) {
            const r = extents(target);
            const [, cx, cy] = this._layer.transform_stage_point(r.x + r.width / 2, r.y + r.height / 2);
            to = {x: Math.round(cx - ICON / 2), y: Math.round(cy - ICON / 2)};
        }
        ghost.remove_all_transitions();
        ghost.ease({
            ...to,
            opacity: 0,
            scale_x: 0.6,
            scale_y: 0.6,
            duration: DROP_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => ghost.destroy(),
        });
        return drop;
    }

    _tileAt(x, y) {
        for (const tile of this._board.tiles.values()) {
            if (tile.folder.id === this._drag.sourceId)
                continue;
            const r = extents(tile);
            if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
                return tile;
        }
        return null;
    }

    _setTarget(tile) {
        const d = this._drag;
        if (d.target === tile)
            return;
        highlight(d.target, false);
        highlight(tile, true);
        d.target = tile;
    }

    // holding the app near the left or right edge flips the page
    _edgeCheck(x) {
        const b = this._board;
        const [lx] = b.get_transformed_position();
        const rel = x - lx;
        const dir = rel < EDGE_PX ? -1 : rel > b.pageWidth - EDGE_PX ? 1 : 0;
        if (!dir || b.page + dir < 0 || b.page + dir >= b.nPages) {
            this._cancelEdge();
            return;
        }
        if (this._edgeId)
            return;
        this._edgeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EDGE_FLIP_MS, () => {
            this._edgeId = 0;
            if (!this._drag)
                return GLib.SOURCE_REMOVE;
            b.setPage(b.page + dir);
            // the tiles have moved under the pointer
            this._followId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAGE_MS + 40, () => {
                this._followId = 0;
                if (this._drag)
                    this.motion(...this._drag.last);
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelEdge() {
        if (this._edgeId)
            GLib.source_remove(this._edgeId);
        this._edgeId = 0;
        if (this._followId)
            GLib.source_remove(this._followId);
        this._followId = 0;
    }
}
