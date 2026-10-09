// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Each folder's grid is built once and kept, so reopening it is instant.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppIcon, accessibleName, addPressFeedback} from './appIcon.js';
import {popIn} from './transitions.js';

const PITCH_X = 166;
const PITCH_Y = 158;
const ITEM_H = 150;
const MAX_COLS = 6;
const ICON = 72;
const PAD_X = 40;
const TOP = 86;
const BOTTOM = 34;
const CLOSE_INSET = 18;
const CLOSE_SIZE = 40;
const GROW_MS = 400;
const SHRINK_MS = 320;
// the shrink is nearly done this early; the panel fades into the tile from here
const LAND_MS = 90;
const PANEL_FADE_MS = 170;
const ITEM_STAGGER_MS = 18;
const REFLOW_MS = 200;
const AUTOSCROLL_EDGE = 48;

function gridSize(n) {
    return {cols: Math.max(1, Math.min(MAX_COLS, n)), rows: Math.ceil(n / MAX_COLS)};
}

// the last row is centred
function slotPos(i, n) {
    const {cols, rows} = gridSize(n);
    const row = Math.floor(i / MAX_COLS);
    const inRow = row === rows - 1 ? n - row * MAX_COLS : cols;
    const offset = (cols - inRow) * PITCH_X / 2;
    return {x: Math.round(offset + (i % MAX_COLS) * PITCH_X), y: row * PITCH_Y};
}

const FolderItem = GObject.registerClass(
class FolderItem extends St.Button {
    _init(view, app) {
        super._init({
            style_class: 'cubby-folder-item cubby-focusable',
            can_focus: true,
            reactive: true,
            track_hover: true,
            width: PITCH_X,
            height: ITEM_H,
        });
        this.kind = 'app';
        this.app = app;
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'cubby-folder-item-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this.appIcon = new AppIcon(app, ICON);
        box.add_child(this.appIcon);
        const name = new St.Label({
            style_class: 'cubby-folder-name',
            text: app.get_name(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(name);
        this.set_child(box);
        addPressFeedback(this);
        this.connect('clicked', () => view.controller.activateApp(app, this));
    }

    updateRunning(focusApp) {
        this.appIcon.updateRunning(focusApp);
        this.accessible_name = accessibleName(this.app);
    }
});

const FolderGrid = GObject.registerClass(
class FolderGrid extends St.Viewport {
    _init(view, folder) {
        super._init({layout_manager: new Clutter.FixedLayout()});
        this.key = FolderGrid.keyFor(folder);
        this.itemFor = new Map();
        for (const app of folder.apps) {
            const item = new FolderItem(view, app);
            this.add_child(item);
            this.itemFor.set(app.id, item);
        }
        this.order = folder.apps.map(a => a.id);
        this.relayout(false);
    }

    // equal keys mean the same apps and names, so the grid can be reused
    static keyFor(folder) {
        return folder.apps.map(a => `${a.id}=${a.get_name()}`).sort().join('\n');
    }

    get items() {
        return this.order.map(id => this.itemFor.get(id));
    }

    relayout(animate, except = null) {
        const n = this.order.length;
        this.order.forEach((id, i) => {
            const item = this.itemFor.get(id);
            if (item === except)
                return;
            const p = slotPos(i, n);
            item.remove_transition('x');
            item.remove_transition('y');
            if (animate)
                item.ease({x: p.x, y: p.y, duration: REFLOW_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                item.set_position(p.x, p.y);
        });
        const {cols, rows} = gridSize(n);
        this.set_size(cols * PITCH_X, rows * PITCH_Y);
    }

    move(appId, to) {
        this.order.splice(this.order.indexOf(appId), 1);
        this.order.splice(to, 0, appId);
    }

    // nearest slot to (x, y), in grid pixels
    slotAt(x, y) {
        const n = this.order.length;
        let best = 0, bestD = Infinity;
        for (let i = 0; i < n; i++) {
            const p = slotPos(i, n);
            const d = (p.x + PITCH_X / 2 - x) ** 2 + (p.y + ITEM_H / 2 - y) ** 2;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    }
});

export const FolderView = GObject.registerClass(
class FolderView extends St.Widget {
    _init(controller) {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            visible: false,
            reactive: false,
        });
        this.controller = controller;
        this.folder = null;
        this.items = [];
        this._grids = new Map();
        this._grid = null;
        this._drag = null;

        this._panel = new St.Widget({
            style_class: 'cubby-folder',
            reactive: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.add_child(this._panel);

        this._inner = new St.Widget({layout_manager: new Clutter.FixedLayout(), opacity: 0});
        this._panel.add_child(this._inner);

        this._title = new St.BoxLayout({style_class: 'cubby-folder-title'});
        this._titleName = new St.Label({style_class: 'cubby-folder-title-name', y_align: Clutter.ActorAlign.END});
        this._titleCount = new St.Label({style_class: 'cubby-folder-title-count', y_align: Clutter.ActorAlign.END});
        this._title.add_child(this._titleName);
        this._title.add_child(this._titleCount);
        this._inner.add_child(this._title);

        // back to most used first, once the user has dragged things around
        this._sortButton = new St.Button({
            style_class: 'cubby-folder-sort',
            label: _('Sort by use'),
            can_focus: true,
            visible: false,
        });
        this._sortButton.connect('clicked', () => controller.resetFolderOrder(this.folder?.id));
        this._inner.add_child(this._sortButton);

        this._close = new St.Button({
            style_class: 'cubby-folder-close',
            can_focus: false,
            accessible_name: _('Close folder'),
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        });
        this._close.connect('clicked', () => controller.closeFolder());
        this._inner.add_child(this._close);

        this._scroll = new St.ScrollView({
            style_class: 'cubby-folder-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._inner.add_child(this._scroll);

        this.connect('destroy', () => {
            for (const g of this._grids.values()) {
                if (!g.get_parent())
                    g.destroy();
            }
            this._grids.clear();
        });
    }

    get isOpen() {
        return this.folder !== null;
    }

    get scrollView() {
        return this._scroll;
    }

    retain(folderIds) {
        const keep = new Set(folderIds);
        for (const [id, g] of this._grids) {
            if (keep.has(id) || g === this._grid)
                continue;
            g.destroy();
            this._grids.delete(id);
        }
    }

    _gridFor(folder) {
        let grid = this._grids.get(folder.id);
        if (grid && grid.key !== FolderGrid.keyFor(folder)) {
            if (grid === this._grid)
                this._scroll.child = null;
            grid.destroy();
            grid = null;
        }
        if (!grid) {
            grid = new FolderGrid(this, folder);
            this._grids.set(folder.id, grid);
        }
        return grid;
    }

    // from is the tile's rect in this actor's coordinates; area is the
    // {width, height, top} the panel may use
    open(folder, from, area, {focusApp = null, customOrder = false} = {}) {
        this.folder = folder;
        this._from = from;
        const n = folder.apps.length;
        const {cols, rows} = gridSize(n);
        const W = cols * PITCH_X + 2 * PAD_X;
        const maxH = area.height - area.top - 40;
        const H = Math.min(TOP + rows * PITCH_Y + BOTTOM, maxH);
        const to = {
            x: Math.round((area.width - W) / 2),
            y: Math.round(Math.max(area.top, (area.height - H) / 2 + 20)),
            width: W,
            height: H,
        };

        this._titleName.text = folder.name;
        this._titleCount.text = ngettext('%d app', '%d apps', n).format(n);
        this._inner.set_size(W, H);
        const [, tw] = this._title.get_preferred_width(-1);
        this._title.set_position(Math.round((W - tw) / 2), 28);
        this._close.set_position(W - CLOSE_INSET - CLOSE_SIZE, CLOSE_INSET);
        this._syncSortButton(customOrder);
        this._scroll.set_position(PAD_X, TOP);
        this._scroll.set_size(W - 2 * PAD_X, H - TOP - BOTTOM / 2);

        const grid = this._gridFor(folder);
        grid.order = folder.apps.map(a => a.id);
        grid.relayout(false);
        if (this._scroll.child !== grid)
            this._scroll.child = grid;
        this._grid = grid;
        this._scroll.vadjustment.value = 0;
        this.items = grid.items;
        for (const item of this.items)
            item.updateRunning(focusApp);

        this.show();
        this._panel.remove_all_transitions();
        this._inner.remove_all_transitions();
        this._panel.set_position(from.x, from.y);
        this._panel.set_size(from.width, from.height);
        this._panel.opacity = 0;
        this._inner.opacity = 0;
        this._panel.ease({
            x: to.x, y: to.y, width: to.width, height: to.height,
            duration: GROW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUART,
        });
        this._panel.ease({opacity: 255, duration: PANEL_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._inner.ease({opacity: 255, delay: 60, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.items.forEach((item, i) => {
            item.remove_all_transitions();
            popIn(item, {scale: 0.8, delay: 60 + Math.min(i, 24) * ITEM_STAGGER_MS, fade: 220, settle: 300});
        });
    }

    _syncSortButton(customOrder) {
        this._sortButton.visible = customOrder;
        if (!customOrder)
            return;
        const [, bw] = this._sortButton.get_preferred_width(-1);
        this._sortButton.set_position(this._inner.width - CLOSE_INSET - CLOSE_SIZE - 8 - bw, 22);
    }

    // the order changed elsewhere, e.g. Sort by use
    reorder(appIds, customOrder) {
        if (!this._grid)
            return;
        this._grid.order = appIds.filter(id => this._grid.itemFor.has(id));
        this._grid.relayout(true);
        this.items = this._grid.items;
        this._syncSortButton(customOrder);
    }

    get dragging() {
        return this._drag !== null;
    }

    // x, y are the pointer's stage coordinates
    beginDrag(item, x, y) {
        const grid = this._grid;
        if (!grid || !this.items.includes(item))
            return false;
        const [, gx, gy] = grid.transform_stage_point(x, y);
        this._drag = {
            item,
            dx: gx - item.x,
            dy: gy - item.y,
            startOrder: [...grid.order],
            last: [x, y],
        };
        item.remove_all_transitions();
        grid.set_child_above_sibling(item, null);
        item.add_style_class_name('cubby-folder-item-dragging');
        item.ease({scale_x: 1.08, scale_y: 1.08, duration: 120});
        return true;
    }

    dragMotion(x, y) {
        const d = this._drag;
        if (!d)
            return;
        d.last = [x, y];
        const grid = this._grid;
        this._autoScroll(y);
        const [, gx, gy] = grid.transform_stage_point(x, y);
        d.item.set_position(gx - d.dx, gy - d.dy);
        const target = grid.slotAt(gx - d.dx + PITCH_X / 2, gy - d.dy + ITEM_H / 2);
        const from = grid.order.indexOf(d.item.app.id);
        if (target !== from) {
            grid.move(d.item.app.id, target);
            grid.relayout(true, d.item);
        }
    }

    // scroll a long folder when the dragged app nears its top or bottom
    _autoScroll(y) {
        const [, sy] = this._scroll.get_transformed_position();
        const h = this._scroll.height;
        const adj = this._scroll.vadjustment;
        let step = 0;
        if (y < sy + AUTOSCROLL_EDGE)
            step = -12;
        else if (y > sy + h - AUTOSCROLL_EDGE)
            step = 12;
        if (step)
            adj.value = Math.max(adj.lower, Math.min(adj.upper - adj.page_size, adj.value + step));
    }

    // returns the new order, or null if it didn't change
    endDrag(commit = true) {
        const d = this._drag;
        if (!d)
            return null;
        this._drag = null;
        const grid = this._grid;
        if (!commit)
            grid.order = d.startOrder;
        d.item.remove_style_class_name('cubby-folder-item-dragging');
        d.item.ease({scale_x: 1, scale_y: 1, duration: 150});
        grid.relayout(true);
        this.items = grid.items;
        const changed = grid.order.join('\n') !== d.startOrder.join('\n');
        return commit && changed ? [...grid.order] : null;
    }

    // Alt+arrows; returns the new order, or null if nothing moved
    moveItem(item, [dx, dy]) {
        const grid = this._grid;
        if (!grid || this._drag)
            return null;
        const from = grid.order.indexOf(item.app.id);
        const to = Math.max(0, Math.min(grid.order.length - 1, from + dx + dy * MAX_COLS));
        if (from < 0 || to === from)
            return null;
        grid.move(item.app.id, to);
        grid.relayout(true);
        this.items = grid.items;
        return [...grid.order];
    }

    get panel() {
        return this._panel;
    }

    // Shrinks back into `to`, the tile's rect now. Returns when the panel
    // starts fading, in ms, so the tile can fade back in as it lands.
    close(to, {instant = false} = {}) {
        if (!this.folder)
            return 0;
        if (this._drag)
            this.endDrag(false);
        this.folder = null;
        this.items = [];
        to ??= this._from;
        this._inner.remove_all_transitions();
        this._panel.remove_all_transitions();
        if (instant) {
            this.hide();
            return 0;
        }
        this._inner.ease({opacity: 0, duration: 80, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        this._panel.ease({
            x: to.x, y: to.y, width: to.width, height: to.height,
            duration: SHRINK_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUART,
            onStopped: () => {
                if (!this.folder)
                    this.hide();
            },
        });
        this._panel.ease({
            opacity: 0,
            delay: LAND_MS,
            duration: PANEL_FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });
        return LAND_MS;
    }
});
