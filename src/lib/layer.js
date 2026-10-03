// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// The full-screen layer that replaces Show Apps on the primary monitor. It
// owns the scrim, the board, the search field and the overlays, and keeps
// the state machine (board, search, folder, edit) and keyboard handling.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {Board} from './board.js';
import {Coach, ContextMenu, EditBar} from './chrome.js';
import {Clock} from './clock.js';
import {WallpaperWatcher} from './wallpaper.js';
import {contrast, luminance} from './theme.js';
import {EditMode} from './editMode.js';
import {FolderView} from './folderView.js';
import {computeGrid, pickNeighbor} from './layoutEngine.js';
import {ResultsPanel, appCaption} from './results.js';
import {SearchEngine} from './searchEngine.js';
import {SearchPill} from './searchPill.js';
import {Tooltip} from './tooltip.js';
import {WindowDimmer} from './windowDimmer.js';

const SCRIM_FADE_MS = 400;
const WINDOW_DIM_MS = 350;
const CLOSE_MS = 260;
// Opening, tiles rise in a wave from the top-left corner; the wave takes
// the same time whatever the grid size.
const OPEN_SPREAD_MS = 220;
const OPEN_TILE_MS = 480;
const OPEN_FADE_MS = 320;
const CLOSE_SPREAD_MS = 110;
const CLOSE_TILE_MS = 220;
const CLOSE_FADE_MS = 180;
// launching zooms the whole layer towards the icon
const LAUNCH_MS = 280;
const LAUNCH_ZOOM = 1.06;
const FOLDER_CROSSFADE_MS = 160;
const SEARCH_FADE_MS = 220;
const RESULTS_FADE_MS = 140;
const SEARCH_BOARD_OPACITY = 36; // about 14%
const SEARCH_BLUR_RADIUS = 16;
const RESULTS_GAP = 12;
const FOLDER_BLUR_RADIUS = 24;
const FOLDER_FADE_MS = 300;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;
const COACH_BOTTOM = 72;

export const Mode = {BOARD: 'board', SEARCH: 'search', FOLDER: 'folder', EDIT: 'edit'};

/** Scales the pixel fields of grid metrics by the St scale factor. */
function scaleGrid(g, sf) {
    if (sf === 1)
        return {...g, sf};
    const px = ['U', 'V', 'GX', 'GY', 'boardX', 'boardY', 'boardW', 'boardH',
        'pillX', 'pillY', 'pillW', 'clockY', 'bottomY', 'headerGap'];
    const out = {...g, sf};
    for (const k of px)
        out[k] = Math.round(g[k] * sf);
    return out;
}

function extents(actor) {
    const e = actor.get_transformed_extents();
    return {x: e.get_x(), y: e.get_y(), width: e.get_width(), height: e.get_height()};
}

function isPrintable(event) {
    const state = event.get_state();
    if (state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
        Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK))
        return false;
    const sym = event.get_key_symbol();
    if (sym === Clutter.KEY_Multi_key)
        return true;
    const uc = Clutter.keysym_to_unicode(sym);
    return uc !== 0 && String.fromCharCode(uc).trim() !== '';
}

export const Layer = GObject.registerClass({
    Signals: {
        'open-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Layer extends St.Widget {
    _init({settings, model, theme, extension}) {
        super._init({
            name: 'cubbyLayer',
            style_class: 'hs-layer',
            reactive: true,
            can_focus: true,
            visible: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._settings = settings;
        this._model = model;
        this._theme = theme;
        this._extension = extension;
        this._isOpen = false;
        this._longPress = null;
        this._grab = null;
        this._dimmer = new WindowDimmer();
        this.mode = Mode.BOARD;
        this._selected = null;
        this._kb = false;
        this._engine = new SearchEngine();

        this._scrim = new St.Widget({opacity: 0, layout_manager: new Clutter.FixedLayout()});
        this._scrimParts = [new St.Widget(), new St.Widget(), new St.Widget()];
        this._scrimParts.forEach(p => this._scrim.add_child(p));
        this.add_child(this._scrim);

        // board and header, so one blur covers both behind a folder
        this._content = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.add_child(this._content);

        this.board = new Board(this, model, settings);
        this._content.add_child(this.board);

        // while searching, takes clicks meant for the faded board; they
        // fall through to the layer, which closes
        this._searchShield = new St.Widget({reactive: true, visible: false});
        this._content.add_child(this._searchShield);

        this.pill = new SearchPill();
        this._content.add_child(this.pill);

        // soft halo behind the clock, as strong as this wallpaper needs for
        // the clock to reach 5:1 (often fully transparent)
        this._clockHalo = new St.Widget({reactive: false, visible: false});
        this._content.add_child(this._clockHalo);
        this.clock = new Clock();
        this._content.add_child(this.clock);

        // dims and catches clicks behind an open folder; a click closes it
        this._shield = new St.Widget({style_class: 'hs-shield', reactive: true, visible: false});
        this.add_child(this._shield);

        this.results = new ResultsPanel(this);
        this.add_child(this.results);

        this.folderView = new FolderView(this);
        this.add_child(this.folderView);

        this.editBar = new EditBar(() => this.setEditing(false));
        this.add_child(this.editBar);

        this.coach = new Coach(() => this._dismissCoach());
        this.add_child(this.coach);

        this.tooltip = new Tooltip();
        this.add_child(this.tooltip);

        this._edit = new EditMode(this.board, theme);
        this._appMenuManager = new PopupMenu.PopupMenuManager(this);
        this._appMenu = null;
        this._menu = new ContextMenu(this, {
            edit: () => this.setEditing(true),
            reset: () => this._resetLayout(),
            prefs: () => {
                this.close();
                this._extension?.openPreferences();
            },
        }, settings);

        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this);
        uiGroup.set_child_above_sibling(this, global.window_group);

        this._wallpaper = new WallpaperWatcher(() => {
            const m = this.monitor;
            return m ? m.width / m.height : 16 / 10;
        });
        this._wallpaper.connectObject('changed', (_w, lum) => {
            this._applyScrim(lum);
            this.board.setFrostSample(this._wallpaper.sample);
        }, this);

        this._monitorIndex = Main.layoutManager.primaryIndex;
        this._syncTheme();
        this._syncGeometry();

        this.connect('captured-event', this._onCapturedEvent.bind(this));
        this.pill.connect('text-changed', (_p, text) => this._onQueryChanged(text));
        this._engine.connectObject('apps', () => this._renderResults(),
            'others', () => this._renderResults(), this);
        global.stage.connectObject('notify::key-focus', () => this._onKeyFocusChanged(), this);
        this.board.connectObject('layout-changed', () => this._onBoardRebuilt(), this);
        this._model.connectObject('changed', (_m, structural) => {
            if (structural)
                this.folderView.retain(this._model.folders.map(f => f.id));
        }, this);
        this._settings.connectObject('changed::tip-dismissed', () => this._syncCoach(), this);

        this._theme.connectObject('changed', () => this._syncTheme(), this);
        this._settings.connectObject('changed::show-clock', () => {
            this._syncGeometry();
            this._syncClock();
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this.close({instant: true});
            this._monitorIndex = Main.layoutManager.primaryIndex;
            this._syncGeometry();
            this._wallpaper.refresh();
        }, this);
        global.display.connectObject('workareas-changed', () => this._syncGeometry(),
            'notify::focus-window', () => {
                if (this._isOpen && global.display.focus_window)
                    this.close();
            }, this);
        Main.sessionMode.connectObject('updated', () => {
            if (Main.sessionMode.isLocked)
                this.close({instant: true});
        }, this);
        Main.screenShield?.connectObject('locked-changed', () => {
            if (Main.screenShield.locked)
                this.close({instant: true});
        }, this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this.close({instant: true}), this);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    get isOpen() {
        return this._isOpen;
    }

    get monitor() {
        return Main.layoutManager.monitors[this._monitorIndex];
    }

    // ---- controller interface used by tiles and results ----

    get focusApp() {
        return this._model.focusApp;
    }

    get names() {
        return this._settings.get_boolean('show-app-names');
    }

    isNew(appId) {
        return this._model.isNew(appId);
    }

    activateApp(app, actor, {newWindow = false} = {}) {
        if (this.mode === Mode.EDIT || !this._isOpen)
            return;
        // Close first: activating a running app moves the focus, which
        // would close the layer without the launch animation.
        const icon = actor ? this._findIcon(actor) : null;
        if (icon) {
            // the icon swells and fades while the layer zooms towards it
            this._launchIcon = icon;
            icon.connectObject('destroy', () => {
                if (this._launchIcon === icon)
                    this._launchIcon = null;
            }, this);
            icon.set_pivot_point(0.5, 0.5);
            icon.ease({
                scale_x: 1.4,
                scale_y: 1.4,
                duration: LAUNCH_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            icon.ease({opacity: 0, duration: LAUNCH_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        }
        this.close({towards: icon});
        if (newWindow && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
    }

    _findIcon(actor) {
        if (actor instanceof St.Icon)
            return actor;
        for (const child of actor.get_children()) {
            const found = this._findIcon(child);
            if (found)
                return found;
        }
        return null;
    }

    openFolder(id, actor) {
        if (this.mode !== Mode.BOARD || this.folderView.isOpen)
            return;
        const folder = this._model.folder(id);
        const tile = this.board.tiles.get(id);
        if (!folder || !tile)
            return;
        this.mode = Mode.FOLDER;
        this._syncCoach();
        // the tile's slots may be rebuilt while the folder is open (a new
        // order), so remember the tile, not the slot actor
        this._folderOpener = tile;
        this._folderTile = tile;
        this.tooltip.showFor(null);
        this._setSelected(null);

        this._shield.show();
        this._shield.opacity = 0;
        this._shield.ease({opacity: 255, duration: FOLDER_FADE_MS});
        if (!this._content.get_effect('hs-fblur')) {
            this._content.add_effect_with_name('hs-fblur', new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1,
            }));
        }
        this._content.ease_property('@effects.hs-fblur.radius', FOLDER_BLUR_RADIUS, {duration: FOLDER_FADE_MS});

        // the tile fades out under the panel that grows from it
        const from = this._tileRect(tile);
        tile.remove_transition('opacity');
        tile.ease({opacity: 0, duration: FOLDER_CROSSFADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.folderView.open(folder, from, {
            width: this.width,
            height: this.height,
            top: this.grid.workArea.y * (this.grid.sf ?? 1) + 24,
        }, {focusApp: this._model.focusApp, customOrder: this._model.hasCustomOrder(id)});
        const first = this.folderView.items[0];
        if (first) {
            first.grab_key_focus();
            this._setSelected(first);
        }
    }

    closeFolder({instant = false} = {}) {
        if (this.mode !== Mode.FOLDER)
            return;
        this.mode = Mode.BOARD;
        this._syncCoach();
        const tile = this._folderTile;
        this._folderTile = null;
        this._setSelected(null);
        const to = tile?.get_stage() ? this._tileRect(tile) : null;
        const landing = this.folderView.close(to, {instant});
        // and fades back in as the panel lands on it
        if (tile) {
            tile.remove_transition('opacity');
            tile.ease({
                opacity: 255,
                delay: Math.max(0, landing - 20),
                duration: instant ? 0 : FOLDER_CROSSFADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        const duration = instant ? 0 : FOLDER_FADE_MS;
        this._shield.ease({opacity: 0, duration, onStopped: () => {
            if (this.mode !== Mode.FOLDER)
                this._shield.hide();
        }});
        if (this._content.get_effect('hs-fblur')) {
            this._content.ease_property('@effects.hs-fblur.radius', 0, {
                duration,
                onStopped: () => {
                    if (this.mode !== Mode.FOLDER)
                        this._content.remove_effect_by_name('hs-fblur');
                },
            });
        }
        const openerTile = this._folderOpener;
        this._folderOpener = null;
        const opener = openerTile?.get_stage()
            ? openerTile.slots.find(sl => sl.kind === 'more') ?? openerTile.slots.at(-1) : null;
        if (opener?.get_stage()) {
            opener.grab_key_focus();
            this._setSelected(opener);
        } else {
            this.grab_key_focus();
        }
    }

    resetFolderOrder(id) {
        if (!id)
            return;
        this._model.setFolderOrder(id, null);
        const folder = this._model.folder(id);
        if (folder)
            this.folderView.reorder(folder.apps.map(a => a.id), false);
    }

    _saveFolderOrder(order) {
        const id = this.folderView.folder?.id;
        if (!id || !order)
            return;
        this._model.setFolderOrder(id, order);
        this.folderView.reorder(order, true);
    }

    _tileRect(tile) {
        const [lx, ly] = this.get_transformed_position();
        const e = tile.get_transformed_extents();
        return {x: e.get_x() - lx, y: e.get_y() - ly, width: e.get_width(), height: e.get_height()};
    }

    activateResult(item, {newWindow = false} = {}) {
        if (item.kind === 'app') {
            this.activateApp(item.app, item, {newWindow});
        } else if (item.kind === 'other') {
            this._engine.activate(item.result);
            this.close();
        }
    }

    onSlotHover(slot) {
        if (this._kb || this.mode !== Mode.BOARD)
            return;
        if (slot.hover && this._wantsTooltip(slot))
            this.tooltip.showFor(slot, slot.tooltipText);
        else if (this.tooltip.target === slot)
            this.tooltip.showFor(null);
    }

    // ---- geometry and theme ----

    _syncGeometry() {
        const m = this.monitor;
        if (!m)
            return;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const wa = Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);
        const rel = {
            x: (wa.x - m.x) / sf,
            y: (wa.y - m.y) / sf,
            width: wa.width / sf,
            height: wa.height / sf,
        };
        const clock = this._settings.get_boolean('show-clock');
        const grid = scaleGrid(computeGrid(rel, {width: m.width / sf, height: m.height / sf}, {clock}), sf);
        this.grid = grid;

        this.set_position(m.x, m.y);
        this.set_size(m.width, m.height);
        this._scrim.set_size(m.width, m.height);
        const h1 = Math.round(m.height * 0.36), h2 = Math.round(m.height * 0.64);
        this._scrimParts[0].set_position(0, 0);
        this._scrimParts[0].set_size(m.width, h1);
        this._scrimParts[1].set_position(0, h1);
        this._scrimParts[1].set_size(m.width, h2 - h1);
        this._scrimParts[2].set_position(0, h2);
        this._scrimParts[2].set_size(m.width, m.height - h2);
        this._shield.set_size(m.width, m.height);
        this._searchShield.set_size(m.width, m.height);
        this._content.set_size(m.width, m.height);
        this.folderView.set_size(m.width, m.height);

        this.board.set_position(0, 0);
        this.board.setGrid(grid, m.width, m.height);

        const pillH = Math.round(60 * sf);
        this.pill.set_position(grid.pillX, grid.pillY);
        this.pill.set_size(grid.pillW, pillH);
        this.results.set_position(grid.pillX, grid.pillY + pillH + Math.round(RESULTS_GAP * sf));
        this.results.width = grid.pillW;
        this._centerX(this.editBar, grid.pillY);
        this.editBar.height = pillH;
        this.clock.width = m.width;
        this.clock.set_position(0, grid.clockY);
        // St's radial gradient is circular: draw a circle and stretch it
        // into an ellipse around the digits
        const haloD = Math.round(300 * sf);
        this._clockHalo.set_size(haloD, haloD);
        this._clockHalo.set_pivot_point(0.5, 0.5);
        this._clockHalo.scale_x = 8 / 3;
        this._clockHalo.set_position(Math.round((m.width - haloD) / 2), grid.clockY + Math.round(50 * sf) - haloD / 2);
        this._syncClockHalo();
        this._syncCoach();
    }

    _centerX(actor, y) {
        const [, natW] = actor.get_preferred_width(-1);
        actor.set_position(Math.round((this.width - natW) / 2), y);
    }

    _syncTheme() {
        const dark = this._theme.dark;
        this.editBar.setAccent(this._theme);
        this._menu?.setDark(dark);
        if (this._edit?.active)
            this._edit.syncAccent();
        this.remove_style_class_name(dark ? 'hs-light' : 'hs-dark');
        this.add_style_class_name(dark ? 'hs-dark' : 'hs-light');
        this.pill.setAccent(this._theme);
        this._applyScrim(this._wallpaper?.luminance ?? 0.3);
        this._paint(this._selected, !!this._selected && this._showSelection());
    }

    // Vertical scrim: strong at the top, light in the middle, a little
    // stronger at the bottom. Strength comes from the wallpaper's luminance.
    _scrimAlpha(fy, lum) {
        const a = 0.38 + lum * 0.42, b = 0.04 + lum * 0.3;
        if (fy < 0.36)
            return a + (b - a) * (fy / 0.36);
        if (fy < 0.64)
            return b;
        return b + (a * 0.8 - b) * ((fy - 0.64) / 0.36);
    }

    _syncClockHalo() {
        const m = this.monitor;
        const lum = this._wallpaper?.luminance;
        if (!m || !this.grid || lum === undefined)
            return;
        const bright = lum > 0.5;
        const half = 170 / m.width;
        const fy0 = this.grid.clockY / m.height, fy1 = (this.grid.clockY + 120) / m.height;
        const ext = this._wallpaper.regionExtremes(0.5 - half, fy0, 0.5 + half, fy1, luminance);
        let h = 0;
        const haloColor = bright ? [255, 255, 255] : [12, 12, 20];
        if (ext) {
            const s = this._scrimAlpha((fy0 + fy1) / 2, lum);
            const base = bright ? ext.darkest : ext.brightest;
            const over = (top, al, bot) => bot.map((v, i) => top[i] * al + v * (1 - al));
            const bg = over([12, 12, 20], s, base);
            const text = bright ? [30, 30, 46] : [255, 255, 255];
            while (h < 0.9 && contrast(text, over(haloColor, h, bg)) < 5)
                h += 0.02;
        }
        this._clockHalo.visible = h > 0 && this.clock.visible;
        const [r, g, b] = haloColor;
        // the outer digits sit at about 60% of the radius, where the
        // gradient has faded to 0.4 of its centre value
        const centre = Math.min(0.9, h / 0.4);
        this._clockHalo.style = `background-gradient-direction: radial; ` +
            `background-gradient-start: rgba(${r},${g},${b},${centre.toFixed(2)}); ` +
            `background-gradient-end: rgba(${r},${g},${b},0);`;
        this._clockHalo.opacity = this.clock.opacity;
    }

    _applyScrim(lum) {
        this._scrimStrength = lum;
        this.clock.setBright(lum > 0.5);
        this._syncClockHalo();
        const a = (0.38 + lum * 0.42).toFixed(3), b = (0.04 + lum * 0.3).toFixed(3);
        const a2 = (a * 0.8).toFixed(3);
        const grad = (from, to) => `background-gradient-direction: vertical; background-gradient-start: rgba(12,12,20,${from}); background-gradient-end: rgba(12,12,20,${to});`;
        this._scrimParts[0].style = grad(a, b);
        this._scrimParts[1].style = `background-color: rgba(12,12,20,${b});`;
        this._scrimParts[2].style = grad(b, a2);
    }

    // ---- open / close ----

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._isOpen)
            return;
        if (Main.sessionMode.isLocked || !Main.sessionMode.hasOverview)
            return;

        this._grab = Main.pushModal(global.stage, {actionMode: Shell.ActionMode.OVERVIEW});
        this._isOpen = true;
        this._model.refreshUsage();
        this.remove_all_transitions();
        this._scrim.remove_all_transitions();
        this.opacity = 255;
        this.set_scale(1, 1);
        // reopened while still closing
        this._settleOverlays();
        this.show();
        this._kb = false;
        this._setSelected(null);
        this.grab_key_focus();
        this._syncCoach();
        this._syncClock();

        // the layer covers one monitor; a press on another one closes it
        this._outsideWatch ??= {};
        global.stage.connectObject('captured-event', (_s, event) => {
            const type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const m = this.monitor;
            if (m && (x < m.x || y < m.y || x >= m.x + m.width || y >= m.y + m.height))
                this.close();
            return Clutter.EVENT_PROPAGATE;
        }, this._outsideWatch);
        this._dimmer.dim(this._monitorIndex, {duration: WINDOW_DIM_MS});
        this._scrim.ease({
            opacity: 255,
            duration: SCRIM_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._animateOpen();
        this.emit('open-changed', true);
    }

    // 0 for the top-left cell, 1 for the bottom-right one
    _waveOrder(rect) {
        const {cols, rows} = this.grid;
        const far = cols - 1 + 1.4 * (rows - 1);
        return far > 0 ? Math.min(1, (rect.x + 1.4 * rect.y) / far) : 0;
    }

    // Tiles pop in as a wave from the top-left, where the Show Apps button
    // usually is; the search field drops in.
    _animateOpen() {
        for (const tile of this.board.tiles.values()) {
            this._settleTile(tile);
            if (tile.rect.page !== this.board.page)
                continue;
            const delay = Math.round(OPEN_SPREAD_MS * this._waveOrder(tile.rect));
            tile.opacity = 0;
            tile.set_scale(0.88, 0.88);
            tile.translation_y = 26;
            tile.ease({opacity: 255, delay, duration: OPEN_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            tile.ease({
                scale_x: 1, scale_y: 1, translation_y: 0,
                delay,
                duration: OPEN_TILE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
        const pill = this.pill;
        pill.remove_all_transitions();
        pill.set_pivot_point(0.5, 0.5);
        pill.opacity = 0;
        pill.translation_y = -14;
        pill.set_scale(0.97, 0.97);
        pill.ease({opacity: 255, delay: 40, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        pill.ease({
            translation_y: 0, scale_x: 1, scale_y: 1,
            delay: 40,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    // The reverse wave, faster, tiles sinking. Returns its length in ms.
    _animateClose() {
        let longest = 0;
        for (const tile of this.board.tiles.values()) {
            if (tile.rect.page !== this.board.page || !tile.visible)
                continue;
            const delay = Math.round(CLOSE_SPREAD_MS * (1 - this._waveOrder(tile.rect)));
            tile.ease({opacity: 0, delay, duration: CLOSE_FADE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
            tile.ease({
                scale_x: 0.92, scale_y: 0.92, translation_y: 14,
                delay,
                duration: CLOSE_TILE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
            longest = Math.max(longest, delay + CLOSE_TILE_MS);
        }
        for (const a of this._overlays()) {
            if (a.visible)
                a.ease({opacity: 0, duration: CLOSE_FADE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        }
        return longest;
    }

    // Launching: everything grows a little towards the icon and fades, as
    // if going into the app. Returns the length in ms.
    _animateLaunch(icon) {
        const [x, y] = icon.get_transformed_position();
        const [w, h] = icon.get_transformed_size();
        const [lx, ly] = this.get_transformed_position();
        this.set_pivot_point((x + w / 2 - lx) / this.width, (y + h / 2 - ly) / this.height);
        this.ease({
            scale_x: LAUNCH_ZOOM,
            scale_y: LAUNCH_ZOOM,
            duration: LAUNCH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        for (const a of [this._content, ...this._overlays()]) {
            if (a.visible)
                a.ease({opacity: 0, duration: LAUNCH_MS, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
        }
        return LAUNCH_MS;
    }

    // everything over the board that fades with it
    _overlays() {
        return [this.pill, this.results, this.folderView, this.clock, this._clockHalo,
            this.coach, this.editBar, this._shield, this.tooltip];
    }

    _settleOverlays() {
        for (const a of [this._content, ...this._overlays()]) {
            a.remove_transition('opacity');
            a.opacity = 255;
        }
    }

    _settleTile(tile) {
        tile.remove_transition('opacity');
        tile.remove_transition('scale-x');
        tile.remove_transition('scale-y');
        tile.remove_transition('translation-y');
        tile.opacity = 255;
        tile.set_scale(1, 1);
        tile.translation_y = 0;
    }

    /**
     * @param {object} [params]
     * @param {boolean} [params.instant] - no animation
     * @param {Clutter.Actor} [params.towards] - the icon of an app being launched
     */
    close({instant = false, towards = null} = {}) {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        if (this._outsideWatch)
            global.stage.disconnectObject(this._outsideWatch);
        this._cancelLongPress();
        if (this._menu.isOpen)
            this._menu.close();
        if (this.mode === Mode.EDIT)
            this.setEditing(false);

        const duration = instant ? 0 : CLOSE_MS;
        this._dimmer.restore({duration});
        this._scrim.remove_all_transitions();
        if (instant) {
            this._finishClose();
        } else {
            const length = towards ? this._animateLaunch(towards) : this._animateClose();
            this._scrim.ease({
                opacity: 0,
                duration: Math.max(duration, length),
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => this._finishClose(),
            });
        }
        this.emit('open-changed', false);
    }

    _finishClose() {
        if (this._isOpen)
            return;
        this._scrim.opacity = 0;
        this.hide();
        this.remove_all_transitions();
        this.set_scale(1, 1);
        if (this._launchIcon) {
            this._launchIcon.disconnectObject(this);
            this._launchIcon.remove_all_transitions();
            this._launchIcon.set_scale(1, 1);
            this._launchIcon.opacity = 255;
            this._launchIcon = null;
        }
        this._resetState();
        this._settleOverlays();
        for (const tile of this.board.tiles.values())
            this._settleTile(tile);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._model.markAllSeen();
        this.clock.stop();
    }

    // back to a clean board for the next open
    _resetState() {
        if (this.mode === Mode.FOLDER)
            this.closeFolder({instant: true});
        this.pill.text = '';
        this._leaveSearch(true);
        this._shield.remove_all_transitions();
        this._shield.hide();
        this._setSelected(null);
        this.tooltip.showFor(null);
        this.board.setPage(0, false);
        this.mode = Mode.BOARD;
    }

    // ---- edit mode ----

    setEditing(on, {tile = null} = {}) {
        if (on === (this.mode === Mode.EDIT))
            return;
        if (on) {
            if (this.mode === Mode.SEARCH)
                this.pill.text = '';
            if (this.mode === Mode.FOLDER)
                this.closeFolder({instant: true});
            this.mode = Mode.EDIT;
            this._dismissCoach();
            this._setSelected(null);
            this.tooltip.showFor(null);
            this.pill.ease({opacity: 0, duration: 150, onComplete: () => this.pill.hide()});
            this._centerX(this.editBar, this.grid.pillY);
            this.editBar.show();
            this.editBar.opacity = 0;
            this.editBar.translation_y = -10;
            this.editBar.ease({opacity: 255, translation_y: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            this._edit.enter();
            this._syncClock();
            const first = tile ?? this.board.tiles.get(Object.keys(this.board.rects)
                .sort((a, b) => this.board.rects[a].page - this.board.rects[b].page)[0]);
            (tile ?? first)?.grab_key_focus();
        } else {
            this._edit.exit();
            this.mode = Mode.BOARD;
            this.editBar.ease({opacity: 0, duration: 150, onComplete: () => this.editBar.hide()});
            this.pill.show();
            this.pill.ease({opacity: 255, duration: 200});
            this.grab_key_focus();
            this._syncCoach();
            this._syncClock();
        }
    }

    _resetLayout() {
        const editing = this.mode === Mode.EDIT;
        if (editing)
            this._edit.exit();
        this.board.reset();
        if (editing)
            this._edit.enter();
    }

    _focusedTile() {
        const f = global.stage.key_focus;
        return f ? this.board.tileFor(f) : null;
    }

    _tabTiles(backward) {
        const order = Object.keys(this.board.rects).sort((a, b) => {
            const ra = this.board.rects[a], rb = this.board.rects[b];
            return ra.page - rb.page || ra.y - rb.y || ra.x - rb.x;
        }).map(id => this.board.tiles.get(id));
        if (!order.length)
            return;
        const i = order.indexOf(this._focusedTile());
        const next = order[(i + (backward ? -1 : 1) + order.length) % order.length] ?? order[0];
        if (next.rect.page !== this.board.page)
            this.board.setPage(next.rect.page);
        next.grab_key_focus();
    }

    // ---- clock ----

    _syncClock() {
        const want = this._settings.get_boolean('show-clock') && this._isOpen;
        const shown = want && (this.mode === Mode.BOARD || this.mode === Mode.FOLDER);
        if (want)
            this.clock.start();
        else
            this.clock.stop();
        this.clock.visible = this._settings.get_boolean('show-clock');
        this.clock.remove_transition('opacity');
        this.clock.ease({opacity: shown ? 255 : 0, duration: shown ? 250 : 120});
        this._syncClockHalo();
        this._clockHalo.remove_transition('opacity');
        this._clockHalo.ease({opacity: shown ? 255 : 0, duration: shown ? 250 : 120});
    }

    // ---- first-run tip ----

    _syncCoach() {
        const show = this._isOpen && !this._settings.get_boolean('tip-dismissed') &&
            this.mode === Mode.BOARD && !!this.grid;
        if (show) {
            const sf = this.grid.sf ?? 1;
            const [, natH] = this.coach.get_preferred_height(-1);
            const y = Math.max(this.grid.bottomY + Math.round(24 * sf), this.height - Math.round(COACH_BOTTOM * sf) - natH);
            this._centerX(this.coach, Math.min(y, this.height - natH - 8));
            if (!this.coach.visible) {
                this.coach.show();
                this.coach.opacity = 0;
                this.coach.ease({opacity: 255, delay: 600, duration: 300});
            } else if (this._coachLeaving) {
                this._coachLeaving = false;
                this.coach.remove_all_transitions();
                this.coach.ease({opacity: 255, duration: 150});
            }
        } else if (this.coach.visible && !this._isOpen) {
            this._coachLeaving = false;
            this.coach.remove_all_transitions();
            this.coach.hide();
        } else if (this.coach.visible && !this._coachLeaving) {
            this._coachLeaving = true;
            this.coach.remove_all_transitions();
            this.coach.ease({
                opacity: 0,
                duration: 150,
                onComplete: () => {
                    this._coachLeaving = false;
                    this.coach.hide();
                },
            });
        }
    }

    _dismissCoach() {
        if (!this._settings.get_boolean('tip-dismissed'))
            this._settings.set_boolean('tip-dismissed', true);
        this._syncCoach();
    }

    // ---- search ----

    _onQueryChanged(text) {
        const searching = text.trim() !== '';
        if (searching && this.mode !== Mode.SEARCH)
            this._enterSearch();
        else if (!searching && this.mode === Mode.SEARCH)
            this._leaveSearch();
        this._engine.setQuery(text);
    }

    _enterSearch() {
        this.mode = Mode.SEARCH;
        this._syncCoach();
        this._syncClock();
        this.tooltip.showFor(null);
        this.pill.setSearching(true);
        this._searchShield.show();
        if (!this.board.get_effect('hs-blur')) {
            this.board.add_effect_with_name('hs-blur', new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                radius: 0,
                brightness: 1,
            }));
        }
        this.board.remove_transition('opacity');
        this.board.ease({opacity: SEARCH_BOARD_OPACITY, duration: SEARCH_FADE_MS});
        this.board.ease_property('@effects.hs-blur.radius', SEARCH_BLUR_RADIUS, {duration: SEARCH_FADE_MS});
        this.results.remove_all_transitions();
        this.results.show();
        this.results.opacity = 0;
        this.results.translation_y = -8;
        this.results.ease({
            opacity: 255,
            translation_y: 0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _leaveSearch(instant = false) {
        if (this.mode === Mode.SEARCH)
            this.mode = Mode.BOARD;
        this._syncCoach();
        this._syncClock();
        this.pill.setSearching(false);
        this.pill.setHint('', '');
        this._searchShield.hide();
        this._engine.reset();
        if (this._selected && this.results.contains(this._selected))
            this._setSelected(null);
        this.results.remove_all_transitions();
        if (instant) {
            this.results.clear();
            this.results.hide();
        } else {
            this.results.ease({
                opacity: 0,
                translation_y: -6,
                duration: RESULTS_FADE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this.results.clear();
                    this.results.hide();
                },
            });
        }
        this.board.remove_transition('opacity');
        const duration = instant ? 0 : SEARCH_FADE_MS;
        this.board.ease({opacity: 255, duration});
        if (this.board.get_effect('hs-blur')) {
            this.board.ease_property('@effects.hs-blur.radius', 0, {
                duration,
                onStopped: () => {
                    if (this.mode !== Mode.SEARCH)
                        this.board.remove_effect_by_name('hs-blur');
                },
            });
        }
    }

    _renderResults() {
        if (this.mode !== Mode.SEARCH)
            return;
        const apps = this._engine.apps.map(app => ({app, ...appCaption(app, this._model)}));
        const others = this._engine.others;
        let none = null;
        this._fallback = null;
        if (!apps.length && !others.length) {
            const q = this.pill.text.trim();
            this._fallback = this._engine.softwareFallback();
            if (this._fallback?.open)
                none = _('Nothing matches “%s”. Enter opens %s.').format(q, this._fallback.name);
            else if (this._fallback)
                none = _('Nothing matches “%s”. Enter searches %s.').format(q, this._fallback.name);
            else
                none = _('Nothing matches “%s”.').format(q);
        }
        const prevSel = this._selected;
        const prevKey = prevSel?.app?.id ?? prevSel?.result?.id;
        this.results.setResults(apps, others, none, {focusApp: this._model.focusApp});
        // keep the selection on the same result if it is still there,
        // otherwise select the first one
        const items = this.results.items;
        const keep = items.find(i => (i.app?.id ?? i.result?.id) === prevKey);
        this._setSelected(this._kbInResults && keep ? keep : items[0] ?? null);
        this._syncSearchHint();
    }

    _syncSearchHint() {
        const n = this._engine.apps.length, o = this._engine.others.length;
        const parts = [];
        if (n)
            parts.push(ngettext('%d app', '%d apps', n).format(n));
        if (o)
            parts.push(ngettext('%d other', '%d other', o).format(o));
        const sel = this._selected;
        let action = '';
        if (sel?.kind === 'app') {
            action = sel.app.state === Shell.AppState.RUNNING
                ? _('Switch to %s').format(sel.app.get_name())
                : _('Open %s').format(sel.app.get_name());
        } else if (sel?.kind === 'other') {
            action = _('Open %s').format(sel.result.name);
        } else if (this._fallback) {
            action = this._fallback.open
                ? _('Open %s').format(this._fallback.name)
                : _('Search %s').format(this._fallback.name);
        }
        this.pill.setHint(parts.join(' · '), action);
    }

    _startSearch(event) {
        if (this.mode === Mode.FOLDER)
            this.closeFolder();
        const text = this.pill.entry.clutter_text;
        text.grab_key_focus();
        text.event(event, false);
    }

    // ---- selection ----

    _showSelection() {
        return this.mode === Mode.SEARCH || this._kb;
    }

    _paint(actor, on) {
        if (!actor)
            return;
        actor.style = on
            ? `background-color: ${this._theme.accentRgba(0.2)}; box-shadow: inset 0 0 0 2px ${this._theme.accent};`
            : null;
    }

    _setSelected(actor) {
        if (this._selected === actor) {
            this._paint(actor, !!actor && this._showSelection());
            return;
        }
        if (this._selected) {
            this._paint(this._selected, false);
            this._selected.disconnectObject(this);
        }
        this._selected = actor;
        if (actor) {
            actor.connectObject('destroy', () => {
                if (this._selected === actor)
                    this._selected = null;
            }, this);
            this._paint(actor, this._showSelection());
        }
        if (this.mode === Mode.SEARCH)
            this._syncSearchHint();
        this._syncTooltip();
    }

    _wantsTooltip(actor) {
        return actor?.kind === 'more' || (actor?.kind === 'app' && !this.names && this.board.contains(actor));
    }

    _syncTooltip() {
        const a = this._selected;
        if (this._kb && this._wantsTooltip(a) && this.mode === Mode.BOARD)
            this.tooltip.showFor(a, a.tooltipText);
        else if (this._kb || !a)
            this.tooltip.showFor(null);
    }

    _onKeyFocusChanged() {
        if (!this._isOpen)
            return;
        const focus = global.stage.key_focus;
        // the focused item was destroyed (an app removed, a tile rebuilt):
        // keep keys coming to the layer
        if (!focus && Main.modalCount > 0 && this._grab) {
            this.grab_key_focus();
            return;
        }
        // a notification banner took keyboard focus (Super+N)
        // (MessageTray overrides contains() for notification sources)
        if (focus && Main.messageTray && Clutter.Actor.prototype.contains.call(Main.messageTray, focus)) {
            this.close({instant: true});
            return;
        }
        if (focus && this.contains(focus) && focus.has_style_class_name?.('hs-focusable'))
            this._setSelected(focus);
        else if (this.mode !== Mode.SEARCH && focus !== this.pill.entry.clutter_text)
            this._setSelected(null);
    }

    _onBoardRebuilt() {
        if (this._selected && !this._selected.get_stage())
            this._setSelected(null);
        if (this.mode === Mode.EDIT)
            this._edit.refresh();
    }

    // Candidates for arrow and Tab navigation in the current mode.
    _candidates() {
        if (this.mode === Mode.SEARCH)
            return this.results.items;
        if (this.mode === Mode.BOARD) {
            const p = this.board.page;
            return [p - 1, p, p + 1].flatMap(i => this.board.focusables(i));
        }
        if (this.mode === Mode.FOLDER)
            return this.folderView.items;
        return [];
    }

    _move(dx, dy) {
        this._kb = true;
        const items = this._candidates();
        if (!items.length)
            return;
        const cur = this._selected && items.includes(this._selected) ? this._selected : null;
        let next;
        if (!cur) {
            next = this.mode === Mode.SEARCH ? items[0] : this.board.focusables()[0] ?? items[0];
        } else {
            const rects = items.map(extents);
            const i = pickNeighbor(rects[items.indexOf(cur)], rects, dx, dy);
            next = i >= 0 ? items[i] : cur;
        }
        this._focusItem(next);
    }

    _tab(backward) {
        this._kb = true;
        const items = this.mode === Mode.BOARD ? this.board.focusables() : this._candidates();
        if (!items.length)
            return;
        const i = items.indexOf(this._selected);
        const next = i < 0 ? items[backward ? items.length - 1 : 0]
            : items[(i + (backward ? -1 : 1) + items.length) % items.length];
        this._focusItem(next);
    }

    _focusItem(item) {
        if (this.mode === Mode.SEARCH) {
            this._kbInResults = true;
            this._setSelected(item);
            return;
        }
        const tile = this.board.tileFor(item);
        if (tile && tile.rect && tile.rect.page !== this.board.page)
            this.board.setPage(tile.rect.page);
        item.grab_key_focus();
        this._setSelected(item);
        if (this.mode === Mode.FOLDER)
            ensureActorVisibleInScrollView(this.folderView.scrollView, item);
    }

    // ---- app menu ----

    // The app item (tile slot, folder app or search result) an actor is in.
    _appItemFor(actor) {
        for (let a = actor; a && a !== this; a = a.get_parent()) {
            if (a.kind === 'app' && a.app)
                return a;
        }
        return null;
    }

    // GNOME's own app menu (New Window, app actions, Pin, App Details,
    // Quit). Its actions call Main.overview.hide(), which closes the layer.
    _openAppMenu(item, {keyboard = false} = {}) {
        // the previous menu is dropped only now: its App Details action
        // finishes asynchronously after the menu has closed
        this._appMenu?.destroy();
        this.tooltip.showFor(null);
        const menu = new AppMenu(item, St.Side.TOP, {
            favoritesSection: true,
            showSingleWindows: true,
        });
        menu.setApp(item.app);
        Main.uiGroup.add_child(menu.actor);
        this._appMenuManager.addMenu(menu);
        this._appMenu = menu;
        this._paint(item, true);
        let itemGone = false;
        // the item can go away under the menu (a tile rebuilt, results
        // replaced); the stock AppIcon drops its menu the same way
        item.connectObject('destroy', () => {
            itemGone = true;
            menu.close();
        }, menu.actor);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open && !itemGone)
                this._paint(item, item === this._selected && this._showSelection());
        });
        menu.connect('destroy', () => {
            if (this._appMenu === menu)
                this._appMenu = null;
        });
        menu.open(BoxPointer.PopupAnimation.FULL);
        if (keyboard)
            menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    // ---- input ----

    _onCapturedEvent(_actor, event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this._onKeyPress(event);
        if (type === Clutter.EventType.BUTTON_PRESS)
            return this._onButtonPress(event);
        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            if (this._edit.dragging) {
                this._edit.motion(x, y);
                return Clutter.EVENT_STOP;
            }
            if (this.folderView.dragging) {
                this.folderView.dragMotion(x, y);
                return Clutter.EVENT_STOP;
            }
            // a press on a folder app that moves far enough starts a drag
            const fp = this._folderPress;
            if (fp && Math.hypot(x - fp.x, y - fp.y) > St.Settings.get().drag_threshold) {
                this._folderPress = null;
                fp.item.fake_release();
                if (this.folderView.beginDrag(fp.item, fp.x, fp.y)) {
                    this.tooltip.showFor(null);
                    this._folderGrab = global.stage.grab(this);
                    this.folderView.dragMotion(x, y);
                    return Clutter.EVENT_STOP;
                }
            }
            if (this._longPress &&
                Math.hypot(x - this._longPress.x, y - this._longPress.y) > LONG_PRESS_SLOP)
                this._cancelLongPress();
            if (this._kb && this.mode !== Mode.SEARCH) {
                this._kb = false;
                this._paint(this._selected, false);
                this.tooltip.showFor(null);
            }
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._cancelLongPress();
            this._folderPress = null;
            if (this._edit.dragging) {
                this._edit.endDrag(true);
                return Clutter.EVENT_STOP;
            }
            if (this.folderView.dragging) {
                this._endFolderDrag(true);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _endFolderDrag(commit) {
        this._folderGrab?.dismiss();
        this._folderGrab = null;
        this._saveFolderOrder(this.folderView.endDrag(commit));
    }

    _onButtonPress(event) {
        const button = event.get_button();
        const [x, y] = event.get_coords();
        const source = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        const tile = source ? this.board.tileFor(source) : null;

        if (this.mode === Mode.FOLDER && button === Clutter.BUTTON_PRIMARY) {
            const item = source ? this.folderView.items.find(i => i === source || i.contains(source)) : null;
            this._folderPress = item ? {item, x, y} : null;
            return Clutter.EVENT_PROPAGATE;
        }

        if (button === Clutter.BUTTON_SECONDARY && this.mode !== Mode.EDIT) {
            // an app: GNOME's own app menu; anywhere else on the board: ours
            const appItem = this._appItemFor(source);
            if (appItem) {
                this._openAppMenu(appItem);
                return Clutter.EVENT_STOP;
            }
            if (this.mode === Mode.BOARD) {
                this._menu.open(x, y);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (this.mode === Mode.EDIT) {
            if (!tile)
                return Clutter.EVENT_PROPAGATE;
            const kind = tile.handleFor(source) === 'resize' ? 'resize' : 'move';
            this._edit.beginDrag(tile, kind, x, y, this);
            return Clutter.EVENT_STOP;
        }
        if (this.mode === Mode.BOARD && tile) {
            // long-press a tile to start arranging, like a phone launcher
            this._cancelLongPress();
            let pressed = source;
            while (pressed && !(pressed instanceof St.Button) && pressed !== tile)
                pressed = pressed.get_parent();
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
                const lp = this._longPress;
                this._longPress = null;
                if (!lp || this.mode !== Mode.BOARD)
                    return GLib.SOURCE_REMOVE;
                if (lp.pressed instanceof St.Button)
                    lp.pressed.fake_release();
                this.setEditing(true, {tile: lp.tile});
                const [px, py] = global.get_pointer();
                this._edit.beginDrag(lp.tile, 'move', px, py, this);
                return GLib.SOURCE_REMOVE;
            });
            this._longPress = {id, x, y, tile, pressed};
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _cancelLongPress() {
        if (this._longPress)
            GLib.source_remove(this._longPress.id);
        this._longPress = null;
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const text = this.pill.entry.clutter_text;
        if (global.stage.key_focus === text && text.has_preedit())
            return Clutter.EVENT_PROPAGATE;

        if (sym === Clutter.KEY_Escape) {
            this._stepBack();
            return Clutter.EVENT_STOP;
        }

        if (ctrl && (sym === Clutter.KEY_e || sym === Clutter.KEY_E)) {
            this.setEditing(this.mode !== Mode.EDIT);
            return Clutter.EVENT_STOP;
        }

        if ((sym === Clutter.KEY_Menu || (shift && sym === Clutter.KEY_F10)) && this.mode !== Mode.EDIT) {
            const appItem = this._selected ? this._appItemFor(this._selected) : null;
            if (appItem) {
                this._openAppMenu(appItem, {keyboard: true});
                return Clutter.EVENT_STOP;
            }
            if (this.mode === Mode.BOARD) {
                const at = this._selected ?? this.pill;
                const e = at.get_transformed_extents();
                this._menu.open(e.get_x() + e.get_width() / 2, e.get_y() + e.get_height() / 2);
                return Clutter.EVENT_STOP;
            }
        }

        const dir = {
            [Clutter.KEY_Left]: [-1, 0], [Clutter.KEY_Right]: [1, 0],
            [Clutter.KEY_Up]: [0, -1], [Clutter.KEY_Down]: [0, 1],
        }[sym];

        if (this.mode === Mode.EDIT) {
            const done = global.stage.key_focus === this.editBar.done;
            if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) && !done) {
                this.setEditing(false);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
                this._tabTiles(sym === Clutter.KEY_ISO_Left_Tab || shift);
                return Clutter.EVENT_STOP;
            }
            if (dir) {
                let tile = this._focusedTile();
                if (!tile) {
                    this._tabTiles(false);
                    tile = this._focusedTile();
                }
                this._edit.key(tile, sym, shift);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (this.mode === Mode.SEARCH) {
            if (dir) {
                this._move(...dir);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
                this._tab(sym === Clutter.KEY_ISO_Left_Tab || shift);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                if (this._selected)
                    this.activateResult(this._selected, {newWindow: ctrl});
                else if (this._fallback) {
                    this._fallback.run();
                    this.close();
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (this.mode === Mode.BOARD) {
            if (dir) {
                this._move(...dir);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
                this._tab(sym === Clutter.KEY_ISO_Left_Tab || shift);
                return Clutter.EVENT_STOP;
            }
            if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) && ctrl &&
                this._selected?.kind === 'app') {
                this.activateApp(this._selected.app, this._selected, {newWindow: true});
                return Clutter.EVENT_STOP;
            }
            if (global.stage.key_focus !== text && isPrintable(event)) {
                this._startSearch(event);
                return Clutter.EVENT_STOP;
            }
        }

        if (this.mode === Mode.FOLDER) {
            const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
            if (dir && alt) {
                // Alt+arrows move the focused app within the folder
                if (this._selected?.kind === 'app' && this.folderView.items.includes(this._selected)) {
                    const item = this._selected;
                    this._saveFolderOrder(this.folderView.moveItem(item, dir[0] + dir[1] * 6));
                    ensureActorVisibleInScrollView(this.folderView.scrollView, item);
                }
                return Clutter.EVENT_STOP;
            }
            if (dir) {
                this._move(...dir);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
                this._tab(sym === Clutter.KEY_ISO_Left_Tab || shift);
                return Clutter.EVENT_STOP;
            }
            if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) && ctrl &&
                this._selected?.kind === 'app') {
                this.activateApp(this._selected.app, this._selected, {newWindow: true});
                return Clutter.EVENT_STOP;
            }
            // typing inside a folder leaves it and searches everything
            if (isPrintable(event)) {
                this._startSearch(event);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Esc: menu, then edit mode, then folder, then search, then close.
    _stepBack() {
        if (this.folderView.dragging) {
            this._endFolderDrag(false);
            return;
        }
        if (this.mode === Mode.EDIT) {
            if (this._edit.dragging)
                this._edit.endDrag(false);
            else
                this.setEditing(false);
            return;
        }
        if (this.mode === Mode.FOLDER) {
            this.closeFolder();
            return;
        }
        if (this.mode === Mode.SEARCH) {
            this.pill.text = '';
            this._kbInResults = false;
            return;
        }
        this.close();
    }

    vfunc_button_release_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        // only a click on bare background steps back or closes; one that
        // lands on a tile, the field, the results or the folder panel
        // without hitting a button does nothing
        const source = global.stage.get_event_actor(event);
        const inside = [this.pill, this.results, this.folderView.panel, this.coach, this.editBar]
            .some(a => a.visible && a.contains(source)) || !!this.board.tileFor(source);
        if (inside)
            return Clutter.EVENT_STOP;
        if (this.mode === Mode.FOLDER) {
            this.closeFolder();
            return Clutter.EVENT_STOP;
        }
        if (this.mode === Mode.EDIT)
            return Clutter.EVENT_STOP;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        this._isOpen = false;
        this._cancelLongPress();
        this._edit.destroy();
        this._menu.destroy();
        this._appMenu?.destroy();
        this._wallpaper.disconnectObject(this);
        this._wallpaper.destroy();
        this._model.disconnectObject(this);
        this._dimmer.restore({duration: 0});
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._engine.disconnectObject(this);
        this._engine.destroy();
        global.stage.disconnectObject(this);
        if (this._outsideWatch)
            global.stage.disconnectObject(this._outsideWatch);
        this._theme.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
    }
});
