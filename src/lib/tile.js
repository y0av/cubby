// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// One folder tile: big icons for the most used apps, and an overflow preview
// (mini 2x2 plus "+N") in the last slot when they don't all fit. A 1x1 tile
// is only the preview. The folder name sits on a chip under the tile.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppIcon, accessibleName, addPressFeedback, runningText} from './appIcon.js';
import {drawDashed} from './drawing.js';
import {tileContent} from './layoutEngine.js';
import {cairoRgba} from './theme.js';

const SLOT_MARGIN = 8;
const NAME_GAP = 11;
const CHIP_GAP = 8;
const CHIP_H = 28;
const CORNER_RADIUS = 32;
const OUTLINE_OFFSET = 5;
const WIGGLE_DEG = 0.35;
const WIGGLE_MS = 1100;
const MOVE_MS = 380;
const DECOR_FADE_MS = 180;

/** A big-icon slot: icon, pips, name. */
const AppSlot = GObject.registerClass(
class AppSlot extends St.Button {
    _init(tile, app, {size, names, labelWidth, isNew}) {
        super._init({
            style_class: 'cubby-slot cubby-focusable',
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE,
        });
        this.kind = 'app';
        this.app = app;
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            style: `spacing: ${NAME_GAP}px;`,
        });
        this.appIcon = new AppIcon(app, size, {isNew});
        box.add_child(this.appIcon);
        if (names) {
            const label = new St.Label({
                style_class: 'cubby-name',
                text: app.get_name(),
                x_align: Clutter.ActorAlign.CENTER,
                style: `max-width: ${labelWidth}px;`,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(label);
        }
        this.set_child(box);
        addPressFeedback(this);
        this.connect('clicked', () => tile.controller.activateApp(app, this));
        this.connect('notify::hover', () => tile.controller.onSlotHover(this));
    }

    get tooltipText() {
        return [this.app.get_name(), runningText(this.app)];
    }

    updateRunning(focusApp) {
        this.appIcon.updateRunning(focusApp);
        this.accessible_name = accessibleName(this.app);
    }
});

/**
 * Overflow preview: up to four mini icons on an inset background with a
 * "+N" badge for apps not visible anywhere on the tile. Opens the folder.
 */
const MoreSlot = GObject.registerClass(
class MoreSlot extends St.Button {
    _init(tile, apps, {badge, miniSize, single}) {
        super._init({
            style_class: 'cubby-slot cubby-focusable',
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE,
        });
        this.kind = 'more';
        this.tile = tile;
        this.apps = apps;
        this._badge = badge;

        // a 1x1 tile is all preview, so it has no inset and more room
        const gap = single ? 12 : 6;
        const pad = single ? 0 : 8;
        const inner = 2 * miniSize + gap;
        const mini = new St.Widget({
            style_class: single ? 'cubby-mini cubby-mini-bare' : 'cubby-mini',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        const grid = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: inner + 2 * pad,
            height: (apps.length > 2 ? inner : miniSize) + 2 * pad,
        });
        mini.add_child(grid);
        this._minis = apps.map((app, i) => {
            const icon = new AppIcon(app, miniSize, {small: true, isNew: tile.controller.isNew(app.id)});
            // one app, or the third of three, sits centred in its row
            const col = apps.length === 1 || (apps.length === 3 && i === 2) ? 0.5 : i % 2;
            icon.set_position(pad + col * (miniSize + gap), pad + Math.floor(i / 2) * (miniSize + gap));
            grid.add_child(icon);
            return icon;
        });
        if (badge > 0) {
            mini.add_child(new St.Label({
                style_class: 'cubby-badge',
                text: `+${badge}`,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
                translation_x: 12,
                translation_y: 10,
            }));
        }
        this.set_child(mini);
        addPressFeedback(this);
        this.connect('clicked', () => tile.controller.openFolder(tile.folder.id));
        this.connect('notify::hover', () => tile.controller.onSlotHover(this));
    }

    get tooltipText() {
        const n = this.tile.folder.apps.length;
        return [_('Open %s').format(this.tile.folder.name),
            ngettext('%d app', '%d apps', n).format(n)];
    }

    updateRunning(focusApp) {
        for (const icon of this._minis)
            icon.updateRunning(focusApp);
        const {name, apps} = this.tile.folder;
        this.accessible_name = this._badge > 0
            ? _('%s, %d apps, %d more').format(name, apps.length, this._badge)
            : _('%s, %d apps').format(name, apps.length);
    }
});

export const Tile = GObject.registerClass(
class Tile extends St.Widget {
    /**
     * @param {object} controller - the layer: activateApp(), openFolder(),
     *   onSlotHover(), isNew(), focusApp
     * @param {object} folder - {id, name, apps}
     */
    _init(controller, folder) {
        super._init({
            style_class: 'cubby-tile',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.FixedLayout(),
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.controller = controller;
        this.folder = folder;
        this.rect = null;
        this.slots = [];
        this.editing = false;
        this.dragging = false;
        this._key = '';

        this._content = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.add_child(this._content);

        this._chipBin = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.chip = new St.Button({
            style_class: 'cubby-chip',
            label: folder.name,
            can_focus: false,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this.chip.connect('clicked', () => controller.openFolder(this.folder.id));
        this._chipBin.add_child(this.chip);
        this.add_child(this._chipBin);

        this.connect('notify::hover', () => this._syncHandles());
        this.connect('key-focus-in', () => this._syncHandles());
        this.connect('key-focus-out', () => this._syncHandles());
    }

    /**
     * Places the tile and rebuilds its slots if anything they show changed.
     *
     * @param {object} rect - {page, x, y, w, h} in cells
     * @param {object} px - {x, y, width, height} on the board
     * @param {object} grid - metrics from computeGrid
     * @param {boolean} names - show app names
     * @param {object} [params]
     * @param {boolean} [params.force] - rebuild even if nothing changed
     * @param {boolean} [params.animate] - move and resize smoothly (edit mode)
     */
    layout(rect, px, grid, names, {force = false, animate = false} = {}) {
        this.rect = {...rect};
        this._px = {...px};
        this._grid = grid;
        this._names = names;
        if (animate) {
            const mode = Clutter.AnimationMode.EASE_OUT_BACK;
            this.ease({x: px.x, y: px.y, width: px.width, height: px.height, duration: MOVE_MS, mode});
            this._chipBin.ease({y: px.height + CHIP_GAP, duration: MOVE_MS, mode});
        } else {
            for (const prop of ['x', 'y', 'width', 'height'])
                this.remove_transition(prop);
            this.set_position(px.x, px.y);
            this.set_size(px.width, px.height);
            this._chipBin.remove_transition('y');
            this._chipBin.set_position(0, px.height + CHIP_GAP);
        }
        this._content.set_size(px.width, px.height);
        this._chipBin.set_size(px.width, CHIP_H);
        this._syncDecorations();

        const {apps} = this.folder;
        const key = [rect.w, rect.h, px.width, px.height, names, grid.U, this.folder.name,
            apps.map(a => a.id).join(','), apps.map(a => this.controller.isNew(a.id)).join('')].join('|');
        if (key === this._key && !force)
            return;
        this._key = key;
        this._build();
        // resized in edit mode: the new arrangement fades in as the frame moves
        if (animate) {
            this._content.opacity = 0;
            this._content.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    setFolder(folder) {
        this.folder = folder;
        this.chip.label = folder.name;
        if (this.rect)
            this.layout(this.rect, this._px, this._grid, this._names);
    }

    _build() {
        this._content.destroy_all_children();
        this.slots = [];
        this.chip.label = this.folder.name;
        const {w, h} = this.rect;
        const g = this._grid;
        const apps = this.folder.apps;
        const content = tileContent(apps.length, w, h);
        const rowH = this._px.height / h;
        const slotRect = i => ({
            x: (i % w) * (g.U + g.GX) + SLOT_MARGIN,
            y: Math.floor(i / w) * rowH + SLOT_MARGIN,
            width: g.U - 2 * SLOT_MARGIN,
            height: rowH - 2 * SLOT_MARGIN,
        });
        const place = (slot, r) => {
            slot.set_position(Math.round(r.x), Math.round(r.y));
            slot.set_size(Math.round(r.width), Math.round(r.height));
            this._content.add_child(slot);
            this.slots.push(slot);
        };

        const slotParams = {
            size: g.iconSize(this._names),
            names: this._names,
            labelWidth: g.U - 2 * SLOT_MARGIN - 12,
        };
        for (let i = 0; i < content.big; i++) {
            const isNew = this.controller.isNew(apps[i].id);
            place(new AppSlot(this, apps[i], {...slotParams, isNew}), slotRect(i));
        }
        if (content.mini > 0) {
            const single = w * h === 1;
            const more = new MoreSlot(this, apps.slice(content.big, content.big + content.mini), {
                badge: content.badge,
                miniSize: single ? g.oneMiniSize : g.miniSize(this._names),
                single,
            });
            place(more, single ? {
                x: SLOT_MARGIN,
                y: SLOT_MARGIN,
                width: this._px.width - 2 * SLOT_MARGIN,
                height: this._px.height - 2 * SLOT_MARGIN,
            } : slotRect(content.big));
        }
        this.updateRunning();
    }

    /** Refreshes pips and accessible names, of every slot or one app's. */
    updateRunning(app = null) {
        const focus = this.controller.focusApp;
        for (const slot of this.slots) {
            if (!app || slot.app === app || slot.apps?.includes(app))
                slot.updateRunning(focus);
        }
    }

    // ---- edit mode ----

    /**
     * Turns the edit decorations on or off: wiggle, dashed accent outline,
     * and the grip and resize handle (shown on hover or focus only).
     *
     * @param {boolean} on
     * @param {object} theme - accent source
     * @param {number} phase - wiggle phase in ms
     * @param {boolean} wiggle - false when animations are off
     */
    setEditing(on, theme, phase = 0, wiggle = true) {
        this.editing = on;
        this._theme = theme;
        this.can_focus = on;
        this.accessible_name = on
            ? _('%s folder, %d by %d').format(this.folder.name, this.rect.w, this.rect.h) : '';
        this.remove_transition('rotation-angle-z');
        if (on) {
            if (!this._outline)
                this._createDecorations();
            this.syncAccent();
            this._syncDecorations();
            this._outline.show();
            this._outline.remove_all_transitions();
            this._outline.ease({opacity: 255, duration: DECOR_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            if (wiggle) {
                this.rotation_angle_z = -WIGGLE_DEG;
                this.ease({
                    rotation_angle_z: WIGGLE_DEG,
                    duration: WIGGLE_MS,
                    delay: phase % WIGGLE_MS,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    repeatCount: -1,
                    autoReverse: true,
                });
            }
        } else {
            // settle from wherever the wiggle was; the decorations are kept
            // for next time
            this.ease({rotation_angle_z: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._outline?.ease({
                opacity: 0,
                duration: DECOR_FADE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._outline.hide(),
            });
        }
        this._syncHandles();
    }

    _createDecorations() {
        this._outline = new St.DrawingArea({reactive: false, opacity: 0});
        this._outline.connect('repaint', area => {
            const [w, h] = area.get_surface_size();
            drawDashed(area, [{x: 0, y: 0, width: w, height: h}], {
                rgba: cairoRgba(this._theme.accent),
                radius: CORNER_RADIUS + OUTLINE_OFFSET,
            });
        });
        this.insert_child_below(this._outline, null);

        this._grip = new St.Widget({
            style_class: 'cubby-grip',
            reactive: true,
            layout_manager: new Clutter.GridLayout({column_spacing: 4, row_spacing: 4}),
        });
        for (let i = 0; i < 6; i++) {
            this._grip.layout_manager.attach(new St.Widget({style_class: 'cubby-grip-dot'}),
                i % 3, Math.floor(i / 3), 1, 1);
        }
        this._grip.handleKind = 'move';
        this.add_child(this._grip);

        this._resizeHandle = new St.Widget({
            style_class: 'cubby-resize',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });
        // an L in the accent's ink colour
        this._resizeGlyph = new St.DrawingArea({
            width: 14,
            height: 14,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._resizeGlyph.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            cr.setSourceRGBA(...cairoRgba(this._theme.accentInk));
            cr.setLineWidth(2.5);
            cr.setLineCap(1); // round
            cr.setLineJoin(1); // round
            cr.moveTo(w - 2, 2);
            cr.lineTo(w - 2, h - 2);
            cr.lineTo(2, h - 2);
            cr.stroke();
            cr.$dispose();
        });
        this._resizeHandle.add_child(this._resizeGlyph);
        this._resizeHandle.handleKind = 'resize';
        this.add_child(this._resizeHandle);
    }

    /** Pauses the wiggle and lifts the tile while it is dragged. */
    setDragging(on) {
        this.dragging = on;
        if (on) {
            this.remove_transition('rotation-angle-z');
            this.rotation_angle_z = 0;
            this.add_style_class_name('cubby-tile-dragging');
            this.ease({scale_x: 1.03, scale_y: 1.03, duration: 150});
        } else {
            this.remove_style_class_name('cubby-tile-dragging');
            this.ease({scale_x: 1, scale_y: 1, duration: 200});
        }
        this._syncHandles();
    }

    syncAccent() {
        if (!this.editing || !this._outline)
            return;
        this._outline.queue_repaint();
        this._resizeHandle.style = `background-color: ${this._theme.accent};`;
        this._resizeGlyph.queue_repaint();
    }

    _syncDecorations() {
        if (!this._outline || !this._px)
            return;
        const {width: w, height: h} = this._px;
        const pad = OUTLINE_OFFSET + 1;
        this._outline.set_position(-pad, -pad);
        this._outline.set_size(w + 2 * pad, h + 2 * pad);
        this._grip.set_position(Math.round(w / 2 - 23), -15);
        this._grip.set_size(46, 28);
        this._resizeHandle.set_position(w - 17, h - 17);
        this._resizeHandle.set_size(34, 34);
    }

    _syncHandles() {
        if (!this._grip)
            return;
        const show = this.editing && (this.hover || this.has_key_focus() || this.dragging);
        this._grip.visible = show;
        this._resizeHandle.visible = show;
    }

    /** 'move', 'resize' or null: which handle an event source belongs to. */
    handleFor(actor) {
        for (let a = actor; a && a !== this; a = a.get_parent()) {
            if (a.handleKind)
                return a.handleKind;
        }
        return null;
    }
});
