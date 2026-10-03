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

import {Pips, addPressFeedback, runningText} from './tile.js';

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
        this._pips = new Pips();
        this._pips.translation_y = 8;
        this._pips.update(app, focusApp === app);
        iconBox.add_child(this._pips);
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
        this._cap = new St.Label({style_class: 'hs-result-caption', x_align: Clutter.ActorAlign.CENTER});
        this._cap.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(this._cap);
        this.set_child(box);
        addPressFeedback(this);
        this.setCaption(caption, live, focusApp);
    }

    setCaption(caption, live, focusApp) {
        this._cap.text = caption;
        if (live)
            this._cap.add_style_class_name('hs-live');
        else
            this._cap.remove_style_class_name('hs-live');
        this._pips.update(this.app, focusApp === this.app);
        const run = runningText(this.app);
        this.accessible_name = [this.app.get_name(), caption, run].filter(Boolean).join(', ');
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
        addPressFeedback(this);
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
            clip_to_allocation: true,
        });
        this._controller = controller;
        this.items = [];

        this._appsLabel = new St.Label({style_class: 'hs-sec', text: _('Apps').toUpperCase()});
        this._appsGrid = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this._otherLabel = new St.Label({style_class: 'hs-sec', text: _('Settings and files').toUpperCase()});
        this._otherFlow = new St.Widget({
            style_class: 'hs-other-flow',
            layout_manager: new WrapLayout(8, 8),
        });
        this._none = new St.Label({style_class: 'hs-none'});
        this._none.clutter_text.line_wrap = true;
        [this._appsLabel, this._appsGrid, this._otherLabel, this._otherFlow, this._none]
            .forEach(a => this.add_child(a));
        this._appItems = new Map();
        this._otherItems = new Map();
        this._apps = [];
        this._others = [];
    }

    // Result items are kept across keystrokes: results that stay slide to
    // their new place, only new ones pop in, so typing does not flash.

    /**
     * @param {Array} apps - [{app, caption, live}]
     * @param {Array} others - provider and system results
     * @param {string|null} none - message when nothing matches
     * @param {object} opts - {animate, focusApp}
     */
    setResults(apps, others, none, {animate = true, focusApp = null} = {}) {
        const wasEmpty = this.items.length === 0 && !this._none.visible;
        this._updateApps(apps, animate, focusApp);
        this._updateOthers(others, animate);
        this._appsLabel.visible = this._appsGrid.visible = this._apps.length > 0;
        this._otherLabel.visible = this._otherFlow.visible = this._others.length > 0;
        this._none.visible = !!none;
        this._none.text = none ?? '';
        this.items = [...this._apps, ...this._others];
        this._syncHeight(animate && !wasEmpty);
    }

    _updateApps(apps, animate, focusApp) {
        const inner = Math.max(0, this.width - 26);
        const cellW = Math.floor((inner - 4 * (APP_COLS - 1)) / APP_COLS);
        const live = new Set(apps.map(a => a.app.id));
        for (const [id, item] of this._appItems) {
            if (!live.has(id)) {
                item.destroy();
                this._appItems.delete(id);
            }
        }
        let fresh = 0;
        this._apps = apps.map((a, i) => {
            const x = (i % APP_COLS) * (cellW + 4), y = Math.floor(i / APP_COLS) * (122 + 4);
            let item = this._appItems.get(a.app.id);
            if (item) {
                item.setCaption(a.caption, a.live, focusApp);
                item.width = cellW;
                if (item.x !== x || item.y !== y) {
                    item.ease({x, y, duration: animate ? 180 : 0, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                }
            } else {
                item = new AppResult(a.app, a.caption, a.live, focusApp);
                item.connect('clicked', () => this._controller.activateResult(item));
                item.width = cellW;
                item.set_position(x, y);
                this._appsGrid.add_child(item);
                this._appItems.set(a.app.id, item);
                this._pop(item, fresh++, animate);
            }
            return item;
        });
        const rows = Math.ceil(apps.length / APP_COLS);
        this._appsGrid.set_size(inner, rows ? rows * 122 + (rows - 1) * 4 : 0);
    }

    _updateOthers(others, animate) {
        const keyOf = o => `${o.kind}|${o.provider?.id ?? ''}|${o.id}`;
        const live = new Set(others.map(keyOf));
        for (const [key, item] of this._otherItems) {
            if (!live.has(key)) {
                item.destroy();
                this._otherItems.delete(key);
            }
        }
        this._others = others.map((o, i) => {
            const key = keyOf(o);
            let item = this._otherItems.get(key);
            if (!item) {
                item = new OtherResult(o);
                item.connect('clicked', () => this._controller.activateResult(item));
                this._otherFlow.add_child(item);
                this._otherItems.set(key, item);
                if (animate) {
                    item.opacity = 0;
                    item.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                }
            }
            this._otherFlow.set_child_at_index(item, i);
            return item;
        });
    }

    // grow and shrink smoothly instead of jumping as results arrive
    _syncHeight(animate) {
        this.remove_transition('height');
        // measure the natural height without the fixed height we set last time
        const current = this.get_height();
        this.set_height(-1);
        const [, natH] = this.get_preferred_height(this.width);
        if (!animate || !this.visible) {
            this.set_height(natH);
            return;
        }
        this.set_height(current);
        this.ease({height: natH, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _pop(item, i, animate) {
        if (!animate)
            return;
        item.opacity = 0;
        item.set_scale(0.88, 0.88);
        item.translation_y = 10;
        const delay = i * POP_STAGGER_MS;
        // opacity must not overshoot: it would wrap past 255 and blink
        item.ease({opacity: 255, delay, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        item.ease({
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            delay,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    clear() {
        this.remove_transition('height');
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
