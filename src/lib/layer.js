// The full-screen layer that replaces Show Apps on the primary monitor. It
// owns the scrim, the board, the search field and the overlays, and keeps
// the state machine (open, search, folder, edit) and keyboard handling.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Board} from './board.js';
import {computeGrid} from './layoutEngine.js';
import {SearchPill} from './searchPill.js';
import {WindowDimmer} from './windowDimmer.js';

const SCRIM_FADE_MS = 450;
const WINDOW_DIM_MS = 350;
const CLOSE_MS = 260;

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

export const Layer = GObject.registerClass({
    Signals: {
        'open-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Layer extends St.Widget {
    _init({settings, model, theme}) {
        super._init({
            name: 'homescreenLayer',
            style_class: 'hs-layer',
            reactive: true,
            can_focus: true,
            visible: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._settings = settings;
        this._model = model;
        this._theme = theme;
        this._isOpen = false;
        this._grab = null;
        this._dimmer = new WindowDimmer();

        this._scrim = new St.Widget({opacity: 0, layout_manager: new Clutter.FixedLayout()});
        this._scrimParts = [new St.Widget(), new St.Widget(), new St.Widget()];
        this._scrimParts.forEach(p => this._scrim.add_child(p));
        this.add_child(this._scrim);

        this.board = new Board(this, model, settings);
        this.add_child(this.board);

        this.pill = new SearchPill();
        this.add_child(this.pill);

        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this);
        uiGroup.set_child_above_sibling(this, global.window_group);

        this._monitorIndex = Main.layoutManager.primaryIndex;
        this._syncTheme();
        this._syncGeometry();

        this._theme.connectObject('changed', () => this._syncTheme(), this);
        this._settings.connectObject('changed::show-clock', () => this._syncGeometry(), this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this.close({instant: true});
            this._monitorIndex = Main.layoutManager.primaryIndex;
            this._syncGeometry();
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

    // ---- controller interface used by tiles ----

    get focusApp() {
        return this._model.focusApp;
    }

    isNew(appId) {
        return this._model.isNew(appId);
    }

    activateApp(app, _actor) {
        app.activate();
        this.close();
    }

    openFolder(_id, _actor) {
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

        this.board.set_position(0, 0);
        this.board.setGrid(grid, m.width, m.height);

        this.pill.set_position(grid.pillX, grid.pillY);
        this.pill.set_size(grid.pillW, Math.round(60 * sf));
    }

    _syncTheme() {
        const dark = this._theme.dark;
        this.remove_style_class_name(dark ? 'hs-light' : 'hs-dark');
        this.add_style_class_name(dark ? 'hs-dark' : 'hs-light');
        this.pill.setAccent(this._theme);
        this._applyScrim(this._scrimStrength ?? 0.25);
    }

    // Vertical scrim: strong at the top, light in the middle, a little
    // stronger at the bottom. Strength comes from the wallpaper's luminance.
    _applyScrim(lum) {
        this._scrimStrength = lum;
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
        this.show();
        this.grab_key_focus();

        this._dimmer.dim(this._monitorIndex, {duration: WINDOW_DIM_MS});
        this._scrim.ease({
            opacity: 255,
            duration: SCRIM_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.emit('open-changed', true);
    }

    close({instant = false} = {}) {
        if (!this._isOpen)
            return;
        this._isOpen = false;

        const duration = instant ? 0 : CLOSE_MS;
        this._dimmer.restore({duration});
        this._scrim.remove_all_transitions();
        if (instant) {
            this._finishClose();
        } else {
            this._scrim.ease({
                opacity: 0,
                duration,
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
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._model.markAllSeen();
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
        if (event.get_button() === Clutter.BUTTON_PRIMARY) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onDestroy() {
        this._isOpen = false;
        this._dimmer.restore({duration: 0});
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._theme.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
    }
});
