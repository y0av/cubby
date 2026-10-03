// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Edit mode: drag a tile to move it, drag its round corner handle to
// resize, or use the keyboard (arrows move, Shift+arrows resize). Every
// change is snapped to the grid, checked for overlap, and saved.

import GLib from 'gi://GLib';
import St from 'gi://St';

import {PAGE_MS} from './board.js';
import {canPlace, MAX_TILE_W, MAX_TILE_H} from './layoutEngine.js';

const EDGE_PX = 48;
const EDGE_FLIP_MS = 600;
const WIGGLE_PHASE_MS = 370;

export class EditMode {
    constructor(board, theme) {
        this._board = board;
        this._theme = theme;
        this.active = false;
        this._drag = null;
        this._edgeId = 0;
        this._followId = 0;
    }

    destroy() {
        this._cancelEdge();
        this._endGrab();
    }

    enter() {
        if (this.active)
            return;
        this.active = true;
        const wiggle = St.Settings.get().enable_animations;
        this._board.setEditing(true);
        [...this._board.tiles.values()].forEach((t, i) =>
            t.setEditing(true, this._theme, i * WIGGLE_PHASE_MS, wiggle));
    }

    /** Gives tiles created while editing (a new folder) their decorations. */
    refresh() {
        if (!this.active)
            return;
        const wiggle = St.Settings.get().enable_animations;
        [...this._board.tiles.values()].forEach((t, i) => {
            if (!t.editing)
                t.setEditing(true, this._theme, i * WIGGLE_PHASE_MS, wiggle);
        });
    }

    exit() {
        if (!this.active)
            return;
        if (this._drag)
            this.endDrag(false);
        this.active = false;
        for (const t of this._board.tiles.values())
            t.setEditing(false, this._theme);
        this._board.setEditing(false);
    }

    syncAccent() {
        for (const t of this._board.tiles.values())
            t.syncAccent();
        this._board.repaintPlaceholders();
    }

    get dragging() {
        return this._drag !== null;
    }

    // ---- pointer ----

    /**
     * @param {Tile} tile
     * @param {string} kind - 'move' or 'resize'
     * @param {number} x - stage x of the pointer
     * @param {number} y - stage y of the pointer
     * @param {Clutter.Actor} grabActor - receives all pointer events while dragging
     */
    beginDrag(tile, kind, x, y, grabActor) {
        const b = this._board;
        const [, sx, sy] = b.strip.transform_stage_point(x, y);
        this._drag = {
            tile, kind, sx, sy,
            id: tile.folder.id,
            start: {...tile.rect},
            px: {x: tile.x, y: tile.y, width: tile.width, height: tile.height},
            cand: {...tile.rect},
            last: [x, y],
        };
        b.strip.set_child_above_sibling(tile, null);
        tile.setDragging(true);
        tile.grab_key_focus();
        this._grab = global.stage.grab(grabActor);
        b.showGhost(tile.rect, true);
    }

    motion(x, y) {
        const d = this._drag;
        if (!d)
            return;
        d.last = [x, y];
        const b = this._board, g = b.grid;
        const [, lx, ly] = b.strip.transform_stage_point(x, y);
        const dx = lx - d.sx, dy = ly - d.sy;
        if (d.kind === 'move') {
            d.tile.set_position(d.px.x + dx, d.px.y + dy);
            const page = b.page;
            const cand = {
                page,
                x: Math.round((d.px.x + dx - page * b.pageWidth - g.boardX) / (g.U + g.GX)),
                y: Math.round((d.px.y + dy - g.boardY) / (g.V + g.GY)),
                w: d.start.w,
                h: d.start.h,
            };
            d.cand = cand;
            b.showGhost(cand, this._fits(d.id, cand));
            this._edgeCheck(x);
        } else {
            const w = Math.max(1, Math.min(MAX_TILE_W, g.cols,
                Math.round((d.px.width + dx + g.GX) / (g.U + g.GX))));
            const h = Math.max(1, Math.min(MAX_TILE_H, g.rows,
                Math.round((d.px.height + dy + g.GY) / (g.V + g.GY))));
            const cand = {...d.start, w, h};
            d.cand = cand;
            const ok = this._fits(d.id, cand);
            const cur = b.rects[d.id];
            // content re-flows live while the size is valid
            if (ok && (cur.w !== w || cur.h !== h))
                b.moveTile(d.id, cand, {animate: true});
            b.showGhost(cand, ok);
        }
    }

    endDrag(commit = true) {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        this._cancelEdge();
        this._endGrab();
        d.tile.setDragging(false);
        const b = this._board;
        b.hideGhost();
        if (d.kind === 'move') {
            if (commit && this._fits(d.id, d.cand))
                b.moveTile(d.id, d.cand, {animate: true, save: true});
            else
                b.moveTile(d.id, d.start, {animate: true}); // springs back
        } else if (commit) {
            b.save();
        } else {
            b.moveTile(d.id, d.start, {animate: true});
        }
    }

    _endGrab() {
        this._grab?.dismiss();
        this._grab = null;
    }

    _fits(id, r) {
        const b = this._board;
        return canPlace(b.rects, id, r, b.grid.cols, b.grid.rows) && r.page < b.nPages;
    }

    // Holding a dragged tile near the left or right edge flips the page.
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
            // keep the tile under the pointer once the strip has moved
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

    // ---- keyboard ----

    /**
     * Arrows move the focused tile one cell (skipping over tiles in the
     * way, onto the next page past the edge); Shift+arrows resize it.
     *
     * @param {Tile} tile
     * @param {number[]} dir - [dx, dy]
     * @param {boolean} resize
     */
    key(tile, dir, resize) {
        if (!tile)
            return;
        const b = this._board, g = b.grid, id = tile.folder.id;
        const r = b.rects[id];
        if (resize) {
            const cand = {...r, w: r.w + dir[0], h: r.h + dir[1]};
            const inLimits = cand.w >= 1 && cand.h >= 1 && cand.w <= MAX_TILE_W && cand.h <= MAX_TILE_H;
            if (inLimits && this._fits(id, cand))
                b.moveTile(id, cand, {animate: true, save: true});
            return;
        }
        for (let step = 1; step <= Math.max(g.cols, g.rows) * 2; step++) {
            let cand = {...r, x: r.x + dir[0] * step, y: r.y + dir[1] * step};
            if (cand.y < 0 || cand.y + cand.h > g.rows)
                return;
            if (cand.x < 0 || cand.x + cand.w > g.cols) {
                // past the side edge: continue on the neighbouring page
                const page = r.page + dir[0];
                if (dir[1] !== 0 || page < 0 || page >= b.nPages)
                    return;
                cand = {...r, page, x: dir[0] > 0 ? 0 : g.cols - r.w};
                for (let k = 0; k < g.cols && !this._fits(id, cand); k++)
                    cand = {...cand, x: cand.x + (dir[0] > 0 ? 1 : -1)};
                if (this._fits(id, cand)) {
                    b.moveTile(id, cand, {animate: true, save: true});
                    b.setPage(page);
                }
                return;
            }
            if (this._fits(id, cand)) {
                b.moveTile(id, cand, {animate: true, save: true});
                return;
            }
        }
    }
}
