// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Folder view: the tile's rectangle grows into a centred glass panel with
// every app in the folder; closing shrinks it back into the tile.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Pips, runningText} from './tile.js';

const PITCH_X = 166;
const PITCH_Y = 158;
const ITEM_H = 150;
const MAX_COLS = 6;
const ICON = 72;
const PAD_X = 40;
const TOP = 86;
const BOTTOM = 34;
const GROW_MS = 420;
const ITEM_STAGGER_MS = 18;

const FolderItem = GObject.registerClass(
class FolderItem extends St.Button {
    _init(view, app, focusApp) {
        super._init({
            style_class: 'hs-folder-item hs-focusable',
            can_focus: true,
            reactive: true,
            track_hover: true,
            width: PITCH_X,
            height: ITEM_H,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.kind = 'app';
        this.app = app;
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'hs-folder-item-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        const iconBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: ICON,
            height: ICON,
            x_align: Clutter.ActorAlign.CENTER,
        });
        iconBox.add_child(new St.Icon({
            style_class: 'hs-icon',
            gicon: app.get_icon(),
            fallback_icon_name: 'application-x-executable',
            icon_size: ICON,
        }));
        const pips = new Pips();
        pips.translation_y = 8;
        pips.update(app, focusApp === app);
        iconBox.add_child(pips);
        box.add_child(iconBox);
        const name = new St.Label({style_class: 'hs-folder-name', text: app.get_name(), x_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(name);
        this.set_child(box);
        const run = runningText(app);
        this.accessible_name = run ? `${app.get_name()}, ${run}` : app.get_name();
        this.connect('clicked', () => view.controller.activateApp(app, this));
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

        this._panel = new St.Widget({
            style_class: 'hs-folder',
            reactive: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.add_child(this._panel);

        this._inner = new St.Widget({layout_manager: new Clutter.FixedLayout(), opacity: 0});
        this._panel.add_child(this._inner);

        this._title = new St.BoxLayout({style_class: 'hs-folder-title'});
        this._titleName = new St.Label({style_class: 'hs-folder-title-name', y_align: Clutter.ActorAlign.END});
        this._titleCount = new St.Label({style_class: 'hs-folder-title-count', y_align: Clutter.ActorAlign.END});
        this._title.add_child(this._titleName);
        this._title.add_child(this._titleCount);
        this._inner.add_child(this._title);

        this._close = new St.Button({
            style_class: 'hs-folder-close',
            can_focus: false,
            accessible_name: _('Close folder'),
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        });
        this._close.connect('clicked', () => controller.closeFolder());
        this._inner.add_child(this._close);

        this._scroll = new St.ScrollView({
            style_class: 'hs-folder-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._grid = new St.Viewport({layout_manager: new Clutter.FixedLayout()});
        this._scroll.child = this._grid;
        this._inner.add_child(this._scroll);
    }

    get isOpen() {
        return this.folder !== null;
    }

    /**
     * @param {object} folder - {id, name, apps}
     * @param {object} from - tile rect in this actor's coordinates
     * @param {object} area - {width, height, top} space for the panel
     */
    open(folder, from, area, {focusApp = null} = {}) {
        this.folder = folder;
        this._from = from;
        const n = folder.apps.length;
        const cols = Math.max(1, Math.min(MAX_COLS, n));
        const rows = Math.ceil(n / MAX_COLS);
        const W = cols * PITCH_X + 2 * PAD_X;
        const maxH = area.height - area.top - 40;
        const gridH = rows * PITCH_Y;
        const H = Math.min(TOP + gridH + BOTTOM, maxH);
        const to = {
            x: Math.round((area.width - W) / 2),
            y: Math.round(Math.max(area.top, (area.height - H) / 2 + 20)),
            width: W,
            height: H,
        };
        this._to = to;

        this._titleName.text = folder.name;
        this._titleCount.text = ngettext('%d app', '%d apps', n).format(n);
        this._inner.set_size(W, H);
        const [, tw] = this._title.get_preferred_width(-1);
        this._title.set_position(Math.round((W - tw) / 2), 28);
        this._close.set_position(W - 18 - 40, 18);
        this._scroll.set_position(PAD_X, TOP);
        this._scroll.set_size(W - 2 * PAD_X, H - TOP - BOTTOM / 2);

        this._grid.destroy_all_children();
        this.items = folder.apps.map((app, i) => {
            const item = new FolderItem(this, app, focusApp);
            const row = Math.floor(i / MAX_COLS);
            const inRow = row === rows - 1 ? n - row * MAX_COLS : Math.min(MAX_COLS, n);
            // the last row is centred
            const offset = (cols - inRow) * PITCH_X / 2;
            item.set_position(Math.round(offset + (i % MAX_COLS) * PITCH_X), row * PITCH_Y);
            this._grid.add_child(item);
            return item;
        });
        this._grid.set_size(cols * PITCH_X, gridH);

        this.show();
        this._panel.remove_all_transitions();
        this._inner.remove_all_transitions();
        this._panel.set_position(from.x, from.y);
        this._panel.set_size(from.width, from.height);
        this._inner.opacity = 0;
        this._panel.ease({
            x: to.x, y: to.y, width: to.width, height: to.height,
            duration: GROW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUART,
        });
        this._inner.ease({opacity: 255, delay: 120, duration: 200});
        this.items.forEach((item, i) => {
            item.opacity = 0;
            item.set_scale(0.8, 0.8);
            item.ease({
                opacity: 255, scale_x: 1, scale_y: 1,
                delay: 100 + Math.min(i, 24) * ITEM_STAGGER_MS,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        });
    }

    /** The panel actor, for hit tests. */
    get panel() {
        return this._panel;
    }

    /** Shrinks back into `to` (the tile's current rect), then hides. */
    close(to, {instant = false, onDone = null} = {}) {
        if (!this.folder)
            return;
        this.folder = null;
        this.items = [];
        to ??= this._from;
        this._inner.remove_all_transitions();
        this._panel.remove_all_transitions();
        const done = () => {
            this.hide();
            this._grid.destroy_all_children();
            onDone?.();
        };
        if (instant) {
            done();
            return;
        }
        this._inner.ease({opacity: 0, duration: 120});
        this._panel.ease({
            x: to.x, y: to.y, width: to.width, height: to.height,
            duration: GROW_MS - 60,
            mode: Clutter.AnimationMode.EASE_OUT_QUART,
            onStopped: done,
        });
    }
});
