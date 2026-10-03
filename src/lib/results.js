// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// The results panel under the search field: apps in a 5-column grid, then
// settings, files and other provider results as chips.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Pips, runningText} from './tile.js';

const APP_COLS = 5;
const RESULT_ICON = 56;
const CHIP_ICON = 18;
const POP_STAGGER_MS = 20;

/** Left-to-right layout that wraps children onto new rows. */
const WrapLayout = GObject.registerClass(
class WrapLayout extends Clutter.LayoutManager {
    _init(spacing = 8, rowSpacing = 8) {
        super._init();
        this._spacing = spacing;
        this._rowSpacing = rowSpacing;
    }

    _rows(container, width) {
        const rows = [];
        let row = null;
        for (const child of container) {
            if (!child.visible)
                continue;
            const [, natW] = child.get_preferred_width(-1);
            const w = Math.min(natW, width);
            const [, natH] = child.get_preferred_height(w);
            if (!row || (row.items.length && row.width + this._spacing + w > width)) {
                row = {items: [], width: 0, height: 0};
                rows.push(row);
            }
            row.width += (row.items.length ? this._spacing : 0) + w;
            row.height = Math.max(row.height, natH);
            row.items.push([child, w, natH]);
        }
        return rows;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        let min = 0, nat = 0, n = 0;
        for (const child of container) {
            if (!child.visible)
                continue;
            const [cMin, cNat] = child.get_preferred_width(-1);
            min = Math.max(min, cMin);
            nat += cNat + (n++ ? this._spacing : 0);
        }
        return [min, nat];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const rows = this._rows(container, forWidth < 0 ? Infinity : forWidth);
        const h = rows.reduce((a, r, i) => a + r.height + (i ? this._rowSpacing : 0), 0);
        return [h, h];
    }

    vfunc_allocate(container, box) {
        const rows = this._rows(container, box.get_width());
        let y = 0;
        for (const row of rows) {
            let x = 0;
            for (const [child, w, h] of row.items) {
                child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
                x += w + this._spacing;
            }
            y += row.height + this._rowSpacing;
        }
    }
});

const AppResult = GObject.registerClass(
class AppResult extends St.Button {
    _init(app, caption, live, focusApp) {
        super._init({
            style_class: 'hs-result hs-focusable',
            can_focus: false,
            reactive: true,
            track_hover: true,
            x_expand: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.kind = 'app';
        this.app = app;
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            style_class: 'hs-result-box',
        });
        const iconBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: RESULT_ICON,
            height: RESULT_ICON,
            x_align: Clutter.ActorAlign.CENTER,
        });
        iconBox.add_child(new St.Icon({
            style_class: 'hs-icon',
            gicon: app.get_icon(),
            fallback_icon_name: 'application-x-executable',
            icon_size: RESULT_ICON,
        }));
        const pips = new Pips();
        pips.translation_y = 8;
        pips.update(app, focusApp === app);
        iconBox.add_child(pips);
        box.add_child(iconBox);
        const texts = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'hs-result-texts',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(texts);
        const name = new St.Label({style_class: 'hs-result-name', text: app.get_name(), x_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(name);
        const cap = new St.Label({
            style_class: live ? 'hs-result-caption hs-live' : 'hs-result-caption',
            text: caption,
            x_align: Clutter.ActorAlign.CENTER,
        });
        cap.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(cap);
        this.set_child(box);
        const run = runningText(app);
        this.accessible_name = [app.get_name(), caption, run].filter(Boolean).join(', ');
    }
});

const OtherResult = GObject.registerClass(
class OtherResult extends St.Button {
    _init(result) {
        super._init({
            style_class: 'hs-other hs-focusable',
            can_focus: false,
            reactive: true,
            track_hover: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.kind = 'other';
        this.result = result;
        const box = new St.BoxLayout({style_class: 'hs-other-box', y_align: Clutter.ActorAlign.CENTER});
        let icon = null;
        try {
            icon = result.iconName
                ? new St.Icon({icon_name: result.iconName, icon_size: CHIP_ICON})
                : result.createIcon?.(CHIP_ICON);
        } catch {
            icon = null;
        }
        if (icon) {
            icon.y_align = Clutter.ActorAlign.CENTER;
            box.add_child(icon);
        }
        const name = new St.Label({style_class: 'hs-other-name', text: result.name, y_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        box.add_child(name);
        if (result.source) {
            box.add_child(new St.Label({
                style_class: 'hs-other-source',
                text: result.source,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this.set_child(box);
        this.accessible_name = [result.name, result.source].filter(Boolean).join(', ');
    }
});

export const ResultsPanel = GObject.registerClass(
class ResultsPanel extends St.BoxLayout {
    _init(controller) {
        super._init({
            style_class: 'hs-results',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
        });
        this._controller = controller;
        this.items = [];

        this._appsLabel = new St.Label({style_class: 'hs-sec', text: _('Apps').toUpperCase()});
        this._appsGrid = new St.Widget({
            layout_manager: new Clutter.GridLayout({
                column_homogeneous: true,
                column_spacing: 4,
                row_spacing: 4,
            }),
        });
        this._otherLabel = new St.Label({style_class: 'hs-sec', text: _('Settings and files').toUpperCase()});
        this._otherFlow = new St.Widget({
            style_class: 'hs-other-flow',
            layout_manager: new WrapLayout(8, 8),
        });
        this._none = new St.Label({style_class: 'hs-none'});
        this._none.clutter_text.line_wrap = true;
        [this._appsLabel, this._appsGrid, this._otherLabel, this._otherFlow, this._none]
            .forEach(a => this.add_child(a));
        this._apps = [];
        this._others = [];
    }

    /**
     * @param {Array} apps - [{app, caption, live}]
     * @param {Array} others - provider and system results
     * @param {string|null} none - message when nothing matches
     * @param {object} opts - {animate, focusApp}
     */
    setResults(apps, others, none, {animate = true, focusApp = null} = {}) {
        const appKey = apps.map(a => `${a.app.id}|${a.caption}`).join('\n');
        if (appKey !== this._appKey) {
            this._appKey = appKey;
            this._appsGrid.destroy_all_children();
            this._apps = apps.map((a, i) => {
                const item = new AppResult(a.app, a.caption, a.live, focusApp);
                item.connect('clicked', () => this._controller.activateResult(item));
                this._appsGrid.layout_manager.attach(item, i % APP_COLS, Math.floor(i / APP_COLS), 1, 1);
                this._pop(item, i, animate);
                return item;
            });
        }
        const otherKey = others.map(o => `${o.kind}|${o.provider?.id ?? ''}|${o.id}`).join('\n');
        if (otherKey !== this._otherKey) {
            this._otherKey = otherKey;
            this._otherFlow.destroy_all_children();
            this._others = others.map((o, i) => {
                const item = new OtherResult(o);
                item.connect('clicked', () => this._controller.activateResult(item));
                this._otherFlow.add_child(item);
                this._pop(item, this._apps.length + i, animate);
                return item;
            });
        }
        this._appsLabel.visible = this._appsGrid.visible = this._apps.length > 0;
        this._otherLabel.visible = this._otherFlow.visible = this._others.length > 0;
        this._none.visible = !!none;
        this._none.text = none ?? '';
        this.items = [...this._apps, ...this._others];
    }

    _pop(item, i, animate) {
        if (!animate)
            return;
        item.opacity = 0;
        item.set_scale(0.88, 0.88);
        item.translation_y = 10;
        item.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            delay: i * POP_STAGGER_MS,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    clear() {
        this.setResults([], [], null, {animate: false});
    }
});

/** Caption under an app result: "Running · Chat", "Pinned"... */
export function appCaption(app, model) {
    const running = app.state === Shell.AppState.RUNNING;
    const where = model.isFavorite(app.id) ? _('Pinned') : model.groupOf(app.id)?.name ?? '';
    return {
        caption: running ? (where ? _('Running · %s').format(where) : _('Running')) : where,
        live: running,
    };
}
