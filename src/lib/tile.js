// One folder tile: big icons for the most used apps, and an overflow preview
// (mini 2x2 plus "+N") in the last slot when they don't all fit. A 1x1 tile
// is only the preview. The folder name sits on a chip under the tile.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {tileContent} from './layoutEngine.js';

const SLOT_MARGIN = 8;
const NAME_GAP = 11;
const CHIP_GAP = 8;
const CHIP_H = 28;
const MAX_PIPS = 3;

/** Accessible description of an app's running state. */
export function runningText(app) {
    if (app.state !== Shell.AppState.RUNNING)
        return '';
    const n = app.get_n_windows();
    return ngettext('running, %d window', 'running, %d windows', n).format(n);
}

/**
 * Bar of window pips under an icon: one per window up to three, the focused
 * app's first pip wide. Neutral colour; the accent means "selected" only.
 */
export const Pips = GObject.registerClass(
class Pips extends St.BoxLayout {
    _init(small = false) {
        super._init({
            style_class: small ? 'hs-pips hs-pips-small' : 'hs-pips',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        this._small = small;
    }

    update(app, focused) {
        const n = app.state === Shell.AppState.RUNNING
            ? Math.max(1, Math.min(MAX_PIPS, app.get_n_windows())) : 0;
        const count = this._small ? Math.min(n, 1) : n;
        while (this.get_n_children() > count)
            this.get_last_child().destroy();
        while (this.get_n_children() < count)
            this.add_child(new St.Widget({style_class: 'hs-pip'}));
        this.get_children().forEach((p, i) => {
            if (i === 0 && focused && !this._small)
                p.add_style_class_name('hs-pip-focused');
            else
                p.remove_style_class_name('hs-pip-focused');
        });
        this.visible = count > 0;
    }
});

/** Icon with its pips (and an optional "New" marker). */
const AppIconBox = GObject.registerClass(
class AppIconBox extends St.Widget {
    _init(app, size, {small = false, isNew = false} = {}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            width: size,
            height: size,
        });
        this.app = app;
        this.icon = new St.Icon({
            style_class: small ? 'hs-mini-icon' : 'hs-icon',
            gicon: app.get_icon(),
            fallback_icon_name: 'application-x-executable',
            icon_size: size,
        });
        this.add_child(this.icon);
        this.pips = new Pips(small);
        this.pips.translation_y = small ? 6 : 8;
        this.add_child(this.pips);
        if (isNew && small) {
            this.add_child(new St.Widget({
                style_class: 'hs-new-dot',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
                translation_x: 3,
                translation_y: -3,
            }));
        } else if (isNew) {
            this.add_child(new St.Label({
                style_class: 'hs-new',
                text: _('New'),
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
                translation_x: 12,
                translation_y: -6,
            }));
        }
    }
});

/** A big-icon slot: icon, pips, name. */
const AppSlot = GObject.registerClass(
class AppSlot extends St.Button {
    _init(tile, app, size, names, labelWidth, isNew) {
        super._init({
            style_class: 'hs-slot hs-focusable',
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE,
        });
        this.tile = tile;
        this.app = app;
        this.kind = 'app';
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            style: `spacing: ${NAME_GAP}px;`,
        });
        this.iconBox = new AppIconBox(app, size, {isNew});
        box.add_child(this.iconBox);
        if (names) {
            const label = new St.Label({
                style_class: 'hs-name',
                text: app.get_name(),
                x_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.style = `max-width: ${labelWidth}px;`;
            box.add_child(label);
        }
        this.set_child(box);
        this.connect('clicked', () => tile.controller.activateApp(app, this));
        this.connect('notify::hover', () => tile.controller.onSlotHover?.(this));
    }

    get tooltipText() {
        const run = runningText(this.app);
        return run ? [this.app.get_name(), run] : [this.app.get_name(), ''];
    }

    updateRunning(focusApp) {
        this.iconBox.pips.update(this.app, focusApp === this.app);
        const run = runningText(this.app);
        this.accessible_name = run ? `${this.app.get_name()}, ${run}` : this.app.get_name();
    }
});

/**
 * Overflow preview: up to four mini icons on an inset background with a
 * "+N" badge for apps not visible anywhere on the tile. Opens the folder.
 */
const MoreSlot = GObject.registerClass(
class MoreSlot extends St.Button {
    _init(tile, apps, badge, miniSize, single) {
        super._init({
            style_class: `hs-slot hs-more hs-focusable${single ? ' hs-more-single' : ''}`,
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE,
        });
        this.tile = tile;
        this.kind = 'more';
        this.apps = apps;
        const gap = single ? 12 : 6;
        const pad = single ? 0 : 8;
        const inner = 2 * miniSize + gap;
        const mini = new St.Widget({
            style_class: single ? 'hs-mini hs-mini-bare' : 'hs-mini',
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
        this.minis = apps.map((app, i) => {
            const b = new AppIconBox(app, miniSize, {small: true, isNew: tile.controller.isNew(app.id)});
            const col = apps.length === 3 && i === 2 ? 0.5 : i % 2;
            b.set_position(pad + col * (miniSize + gap), pad + Math.floor(i / 2) * (miniSize + gap));
            grid.add_child(b);
            return b;
        });
        if (badge > 0) {
            mini.add_child(new St.Label({
                style_class: 'hs-badge',
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
        this._badge = badge;
        this.connect('clicked', () => tile.controller.openFolder(tile.folder.id, this));
        this.connect('notify::hover', () => tile.controller.onSlotHover?.(this));
    }

    get tooltipText() {
        const n = this.tile.folder.apps.length;
        return [_('Open %s').format(this.tile.folder.name),
            ngettext('%d app', '%d apps', n).format(n)];
    }

    updateRunning(focusApp) {
        for (const m of this.minis)
            m.pips.update(m.app, focusApp === m.app);
        const n = this.tile.folder.apps.length;
        this.accessible_name = this._badge > 0
            ? _('%s, %d apps, %d more').format(this.tile.folder.name, n, this._badge)
            : _('%s, %d apps').format(this.tile.folder.name, n);
    }
});

export const Tile = GObject.registerClass(
class Tile extends St.Widget {
    /**
     * @param {object} controller - activateApp(app, actor), openFolder(id, actor),
     *   isNew(appId), focusApp
     * @param {object} folder - {id, name, apps}
     */
    _init(controller, folder) {
        super._init({
            style_class: 'hs-tile',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.controller = controller;
        this.folder = folder;
        this.rect = null;
        this.slots = [];
        this._content = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.add_child(this._content);

        this._chipBin = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.chip = new St.Button({
            style_class: 'hs-chip',
            label: folder.name,
            can_focus: false,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this.chip.connect('clicked', () => controller.openFolder(this.folder.id, this));
        this._chipBin.add_child(this.chip);
        this.add_child(this._chipBin);
        this._key = '';
    }

    /**
     * Lays the tile out for a grid rect and pixel geometry.
     *
     * @param {object} rect - {w, h} in cells
     * @param {object} px - {x, y, width, height}
     * @param {object} grid - metrics from computeGrid
     * @param {boolean} names - show app names
     */
    layout(rect, px, grid, names, {force = false} = {}) {
        this.rect = {...rect};
        this.set_position(px.x, px.y);
        this.set_size(px.width, px.height);
        this._content.set_size(px.width, px.height);
        this._chipBin.set_position(0, px.height + CHIP_GAP);
        this._chipBin.set_size(px.width, CHIP_H);
        const key = [rect.w, rect.h, px.width, px.height, names, grid.U,
            this.folder.name, this.folder.apps.map(a => a.id).join(','),
            this.folder.apps.map(a => this.controller.isNew(a.id)).join('')].join('|');
        if (key === this._key && !force)
            return;
        this._key = key;
        this._grid = grid;
        this._names = names;
        this._build();
    }

    setFolder(folder) {
        this.folder = folder;
        this.chip.label = folder.name;
        if (this.rect)
            this.layout(this.rect, {x: this.x, y: this.y, width: this.width, height: this.height}, this._grid, this._names);
    }

    _build() {
        this._content.destroy_all_children();
        this.slots = [];
        const {w, h} = this.rect;
        const g = this._grid;
        const apps = this.folder.apps;
        const c = tileContent(apps.length, w, h);
        this.set_style_class_name(w * h === 1 ? 'hs-tile hs-tile-one' : 'hs-tile');
        this.chip.label = this.folder.name;
        const rowH = this.height / h;
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

        const size = g.iconSize(this._names);
        const labelWidth = g.U - 2 * SLOT_MARGIN - 12;
        for (let i = 0; i < c.big; i++)
            place(new AppSlot(this, apps[i], size, this._names, labelWidth, this.controller.isNew(apps[i].id)), slotRect(i));
        if (c.mini > 0) {
            const single = w * h === 1;
            const more = new MoreSlot(this, apps.slice(c.big, c.big + c.mini), c.badge,
                single ? g.oneMiniSize : g.miniSize(this._names), single);
            place(more, single ? {
                x: SLOT_MARGIN, y: SLOT_MARGIN,
                width: this.width - 2 * SLOT_MARGIN, height: this.height - 2 * SLOT_MARGIN,
            } : slotRect(c.big));
        }
        this.updateRunning();
    }

    /** Refresh pips and accessible names (all slots, or one app's). */
    updateRunning(app = null) {
        const focus = this.controller.focusApp;
        for (const s of this.slots) {
            if (!app || s.app === app || s.apps?.includes(app))
                s.updateRunning(focus);
        }
    }

    /** Slot actors in reading order, for keyboard navigation. */
    get focusables() {
        return this.slots;
    }
});
