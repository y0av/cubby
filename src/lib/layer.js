// The full-screen layer that replaces Show Apps on the primary monitor. It
// owns the scrim, the board, the search field and the overlays, and keeps
// the state machine (board, search, folder, edit) and keyboard handling.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Board} from './board.js';
import {computeGrid, pickNeighbor} from './layoutEngine.js';
import {ResultsPanel, appCaption} from './results.js';
import {SearchEngine} from './searchEngine.js';
import {SearchPill} from './searchPill.js';
import {Tooltip} from './tooltip.js';
import {WindowDimmer} from './windowDimmer.js';

const SCRIM_FADE_MS = 450;
const WINDOW_DIM_MS = 350;
const CLOSE_MS = 260;
const SEARCH_FADE_MS = 220;
const SEARCH_BOARD_OPACITY = 36; // about 14%
const SEARCH_BLUR_RADIUS = 16;
const RESULTS_GAP = 12;

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
        this.mode = Mode.BOARD;
        this._selected = null;
        this._kb = false;
        this._engine = new SearchEngine();

        this._scrim = new St.Widget({opacity: 0, layout_manager: new Clutter.FixedLayout()});
        this._scrimParts = [new St.Widget(), new St.Widget(), new St.Widget()];
        this._scrimParts.forEach(p => this._scrim.add_child(p));
        this.add_child(this._scrim);

        this.board = new Board(this, model, settings);
        this.add_child(this.board);

        // catches clicks outside the results panel or folder while those
        // are shown; clicks fall through to the layer (close / step back)
        this._shield = new St.Widget({reactive: true, visible: false});
        this.add_child(this._shield);

        this.pill = new SearchPill();
        this.add_child(this.pill);

        this.results = new ResultsPanel(this);
        this.add_child(this.results);

        this.tooltip = new Tooltip();
        this.add_child(this.tooltip);

        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this);
        uiGroup.set_child_above_sibling(this, global.window_group);

        this._monitorIndex = Main.layoutManager.primaryIndex;
        this._syncTheme();
        this._syncGeometry();

        this.connect('captured-event', this._onCapturedEvent.bind(this));
        this.pill.connect('text-changed', (_p, text) => this._onQueryChanged(text));
        this._engine.connectObject('apps', () => this._renderResults(),
            'others', () => this._renderResults(), this);
        global.stage.connectObject('notify::key-focus', () => this._onKeyFocusChanged(), this);
        this.board.connectObject('layout-changed', () => this._onBoardRebuilt(), this);

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

    activateApp(app, _actor, {newWindow = false} = {}) {
        if (this.mode === Mode.EDIT)
            return;
        if (newWindow && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
        this.close();
    }

    openFolder(_id, _actor) {
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

        this.board.set_position(0, 0);
        this.board.setGrid(grid, m.width, m.height);

        const pillH = Math.round(60 * sf);
        this.pill.set_position(grid.pillX, grid.pillY);
        this.pill.set_size(grid.pillW, pillH);
        this.results.set_position(grid.pillX, grid.pillY + pillH + Math.round(RESULTS_GAP * sf));
        this.results.width = grid.pillW;
    }

    _syncTheme() {
        const dark = this._theme.dark;
        this.remove_style_class_name(dark ? 'hs-light' : 'hs-dark');
        this.add_style_class_name(dark ? 'hs-dark' : 'hs-light');
        this.pill.setAccent(this._theme);
        this._applyScrim(this._scrimStrength ?? 0.25);
        this._paint(this._selected, !!this._selected && this._showSelection());
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
        this._kb = false;
        this._setSelected(null);
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
        this._resetState();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._model.markAllSeen();
    }

    // back to a clean board for the next open
    _resetState() {
        this.pill.text = '';
        this._leaveSearch(true);
        this._setSelected(null);
        this.tooltip.showFor(null);
        this.board.setPage(0, false);
        this.mode = Mode.BOARD;
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
        this.tooltip.showFor(null);
        this.pill.setSearching(true);
        this._shield.show();
        this.set_child_above_sibling(this._shield, this.board);
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
        this.pill.setSearching(false);
        this.pill.setHint('', '');
        this._shield.hide();
        this._engine.reset();
        this.results.clear();
        this.results.remove_all_transitions();
        this.results.hide();
        if (this._selected && this.results.contains(this._selected))
            this._setSelected(null);
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
            this.closeFolder?.({instant: false});
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
        if (focus && this.contains(focus) && focus.has_style_class_name?.('hs-focusable'))
            this._setSelected(focus);
        else if (this.mode !== Mode.SEARCH && focus !== this.pill.entry.clutter_text)
            this._setSelected(null);
    }

    _onBoardRebuilt() {
        if (this._selected && !this._selected.get_stage())
            this._setSelected(null);
    }

    // Candidates for arrow and Tab navigation in the current mode.
    _candidates() {
        if (this.mode === Mode.SEARCH)
            return this.results.items;
        if (this.mode === Mode.BOARD) {
            const p = this.board.page;
            return [p - 1, p, p + 1].flatMap(i => this.board.focusables(i));
        }
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
    }

    // ---- input ----

    _onCapturedEvent(_actor, event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this._onKeyPress(event);
        if (type === Clutter.EventType.MOTION && this._kb && this.mode !== Mode.SEARCH) {
            this._kb = false;
            this._paint(this._selected, false);
            this.tooltip.showFor(null);
        }
        return Clutter.EVENT_PROPAGATE;
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

        const dir = {
            [Clutter.KEY_Left]: [-1, 0], [Clutter.KEY_Right]: [1, 0],
            [Clutter.KEY_Up]: [0, -1], [Clutter.KEY_Down]: [0, 1],
        }[sym];

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
        return Clutter.EVENT_PROPAGATE;
    }

    // Esc: menu, then edit mode, then folder, then search, then close.
    _stepBack() {
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
        if (this.mode === Mode.SEARCH && this._shield.visible) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        this._isOpen = false;
        this._dimmer.restore({duration: 0});
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._engine.disconnectObject(this);
        this._engine.destroy();
        global.stage.disconnectObject(this);
        this._theme.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
    }
});
