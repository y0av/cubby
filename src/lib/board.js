// The board: folder tiles on the shared cell grid, split into pages when
// they don't fit, with the layout read from and saved to the extension's
// settings.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Tile, drawDashed} from './tile.js';
import * as L from './layoutEngine.js';

const PAGE_MS = 380;
const DOTS_GAP = 18;

export const Board = GObject.registerClass({
    Signals: {
        'page-changed': {param_types: [GObject.TYPE_INT]},
        'layout-changed': {},
    },
}, class Board extends St.Widget {
    _init(controller, model, settings) {
        super._init({
            name: 'homescreenBoard',
            style_class: 'hs-board',
            reactive: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._controller = controller;
        this._model = model;
        this._settings = settings;
        this.tiles = new Map();
        this.rects = {};
        this.grid = null;
        this.page = 0;
        this.nPages = 1;

        this._strip = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.add_child(this._strip);
        this.editing = false;
        this._placeholders = null;
        this._ghost = null;

        this._dots = new St.BoxLayout({style_class: 'hs-dots', reactive: true});
        this.add_child(this._dots);

        this._model.connectObject(
            'changed', (_m, structural, ids) => this._onModelChanged(structural, ids),
            'running-changed', (_m, app) => this._updateRunning(app),
            'focus-changed', (_m, oldApp, newApp) => {
                this._updateRunning(oldApp);
                this._updateRunning(newApp);
            }, this);
        this._settings.connectObject('changed::show-app-names', () => this.relayout(true), this);
        this.connect('destroy', () => {
            this._model.disconnectObject(this);
            this._settings.disconnectObject(this);
        });
    }

    get names() {
        return this._settings.get_boolean('show-app-names');
    }

    get strip() {
        return this._strip;
    }

    get pageWidth() {
        return this._monW;
    }

    /** New grid metrics (monitor, work area, clock or scale changed). */
    setGrid(grid, monitorWidth, monitorHeight) {
        this.grid = grid;
        this._monW = monitorWidth;
        this.set_size(monitorWidth, monitorHeight);
        this._resolve();
    }

    _stored() {
        try {
            return JSON.parse(this._settings.get_string('layouts') || '{}');
        } catch {
            return {};
        }
    }

    _resolve() {
        if (!this.grid)
            return;
        const {cols, rows} = this.grid;
        const folders = this._model.foldersByUsage();
        const stored = this._stored();
        const {tiles, source} = L.resolveLayout(stored, folders, cols, rows);
        if (source === 'generated' && folders.length) {
            this._settings.set_string('layouts',
                JSON.stringify(L.storeLayout(stored, cols, rows, tiles, {generated: true})));
        }
        this._apply(tiles);
    }

    /** Saves the current layout for this grid (after an edit). */
    save(tiles = this.rects) {
        const {cols, rows} = this.grid;
        this._settings.set_string('layouts', JSON.stringify(L.storeLayout(this._stored(), cols, rows, tiles)));
    }

    /** Forgets every stored layout and generates a new one. */
    reset() {
        this._settings.set_string('layouts', '{}');
        this._resolve();
    }

    _apply(tiles) {
        this.rects = tiles;
        const live = new Set(Object.keys(tiles));
        for (const [id, tile] of this.tiles) {
            if (!live.has(id)) {
                tile.destroy();
                this.tiles.delete(id);
            }
        }
        for (const f of this._model.folders) {
            if (!live.has(f.id))
                continue;
            let tile = this.tiles.get(f.id);
            if (!tile) {
                tile = new Tile(this._controller, f);
                this._strip.add_child(tile);
                this.tiles.set(f.id, tile);
            } else if (tile.folder !== f) {
                tile.folder = f;
            }
        }
        this.relayout();
        this.emit('layout-changed');
    }

    /** Pixel rect of a grid rect on its page, in board coordinates. */
    pixelRect(r) {
        const c = L.cellRect(this.grid, r);
        return {
            x: r.page * this._monW + this.grid.boardX + c.x,
            y: this.grid.boardY + c.y,
            width: c.width,
            height: c.height,
        };
    }

    relayout(force = false) {
        if (!this.grid)
            return;
        const names = this.names;
        for (const [id, tile] of this.tiles) {
            const r = this.rects[id];
            tile.layout(r, this.pixelRect(r), this.grid, names, {force});
        }
        // edit mode offers one empty page to move tiles onto
        this.nPages = L.pageCount(this.rects) + (this.editing ? 1 : 0);
        this._syncDots();
        this._syncPlaceholders();
        this.setPage(Math.min(this.page, this.nPages - 1), false);
    }

    // ---- edit mode ----

    setEditing(on) {
        this.editing = on;
        if (on)
            this.add_style_class_name('hs-board-editing');
        else
            this.remove_style_class_name('hs-board-editing');
        if (on) {
            this._placeholders = new St.DrawingArea({reactive: false});
            this._placeholders.connect('repaint', a => this._drawPlaceholders(a));
            this._strip.insert_child_below(this._placeholders, null);
            this._ghost = new St.Widget({style_class: 'hs-ghost', reactive: false, visible: false});
            this._strip.add_child(this._ghost);
        } else {
            this._placeholders?.destroy();
            this._ghost?.destroy();
            this._placeholders = this._ghost = null;
        }
        this.relayout();
    }

    _syncPlaceholders() {
        if (!this._placeholders)
            return;
        const g = this.grid;
        this._placeholders.set_position(0, g.boardY - 2);
        this._placeholders.set_size(this.nPages * this._monW, g.boardH + 4);
        this._placeholders.queue_repaint();
    }

    repaintPlaceholders() {
        this._placeholders?.queue_repaint();
    }

    _drawPlaceholders(area) {
        const g = this.grid;
        const taken = new Set();
        for (const r of Object.values(this.rects)) {
            for (let y = r.y; y < r.y + r.h; y++) {
                for (let x = r.x; x < r.x + r.w; x++)
                    taken.add(`${r.page},${x},${y}`);
            }
        }
        const rects = [];
        for (let p = 0; p < this.nPages; p++) {
            for (let y = 0; y < g.rows; y++) {
                for (let x = 0; x < g.cols; x++) {
                    if (taken.has(`${p},${x},${y}`))
                        continue;
                    const r = this.pixelRect({page: p, x, y, w: 1, h: 1});
                    rects.push({x: r.x, y: r.y - g.boardY + 2, width: r.width, height: r.height});
                }
            }
        }
        drawDashed(area, rects, {rgba: [1, 1, 1, 0.3], fill: [12 / 255, 12 / 255, 20 / 255, 0.16]});
    }

    showGhost(rect, ok) {
        if (!this._ghost)
            return;
        const r = this.pixelRect(rect);
        const first = !this._ghost.visible;
        this._ghost.show();
        this._ghost.set_style_class_name(ok ? 'hs-ghost' : 'hs-ghost hs-ghost-bad');
        this._strip.set_child_below_sibling(this._ghost, null);
        this._strip.set_child_above_sibling(this._ghost, this._placeholders);
        this._ghost.ease({
            x: r.x, y: r.y, width: r.width, height: r.height,
            duration: first ? 0 : 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hideGhost() {
        this._ghost?.hide();
    }

    /** Moves or resizes one tile (edit mode), optionally saving. */
    moveTile(id, rect, {animate = false, save = false} = {}) {
        this.rects = {...this.rects, [id]: {...rect}};
        const tile = this.tiles.get(id);
        tile?.layout(this.rects[id], this.pixelRect(this.rects[id]), this.grid, this.names, {animate});
        const n = L.pageCount(this.rects) + (this.editing ? 1 : 0);
        if (n !== this.nPages) {
            this.nPages = n;
            this._syncDots();
        }
        this._syncPlaceholders();
        if (save)
            this.save();
    }

    _onModelChanged(structural, ids) {
        if (structural) {
            this._resolve();
            return;
        }
        for (const id of ids) {
            const f = this._model.folder(id);
            const tile = this.tiles.get(id);
            if (f && tile)
                tile.setFolder(f);
        }
    }

    _updateRunning(app) {
        if (!app)
            return;
        const g = this._model.groupOf(app.id);
        const tile = g && this.tiles.get(g.id);
        tile?.updateRunning(app);
    }

    // ---- pages ----

    _syncDots() {
        this._dots.destroy_all_children();
        this._dots.visible = this.nPages > 1;
        if (this.nPages < 2)
            return;
        for (let i = 0; i < this.nPages; i++) {
            const dot = new St.Button({
                style_class: 'hs-dot',
                can_focus: false,
                accessible_name: `Page ${i + 1}`,
            });
            dot.connect('clicked', () => this.setPage(i, true));
            this._dots.add_child(dot);
        }
        const [, natW] = this._dots.get_preferred_width(-1);
        this._dots.set_position(Math.round((this._monW - natW) / 2), this.grid.bottomY + DOTS_GAP);
        this._syncDotState();
    }

    _syncDotState() {
        this._dots.get_children().forEach((d, i) => {
            if (i === this.page)
                d.add_style_pseudo_class('checked');
            else
                d.remove_style_pseudo_class('checked');
        });
    }

    setPage(page, animate = true) {
        page = Math.max(0, Math.min(this.nPages - 1, page));
        const changed = page !== this.page;
        this.page = page;
        this._strip.remove_transition('translation-x');
        this._strip.ease({
            translation_x: -page * this._monW,
            duration: animate ? PAGE_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._syncDotState();
        if (changed)
            this.emit('page-changed', page);
    }

    vfunc_scroll_event(event) {
        const dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            step = 1;
        else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            step = -1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            this._scrollAcc = (this._scrollAcc ?? 0) + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
            if (Math.abs(this._scrollAcc) >= 1) {
                step = Math.sign(this._scrollAcc);
                this._scrollAcc = 0;
            }
        }
        if (step && this.nPages > 1)
            this.setPage(this.page + step);
        return Clutter.EVENT_STOP;
    }

    /** All slot actors on the current page, in reading order. */
    focusables(page = this.page) {
        return L.readingOrder(this.rects)
            .filter(id => this.rects[id].page === page)
            .flatMap(id => this.tiles.get(id)?.focusables ?? []);
    }

    tileFor(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            if (a instanceof Tile)
                return a;
        }
        return null;
    }
});
