// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Routes every "show the app grid" request to the layer.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const TOGGLE_KEY = 'toggle-application-view';
const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const KEY_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

export class EntryPoints {
    /**
     * @param {object} layer - the Layer; needs isOpen, open(), close(), toggle()
     * @param {Gio.Settings} settings - the extension's settings
     */
    constructor(layer, settings) {
        this._layer = layer;
        this._settings = settings;
        this._syncing = false;
        this._injections = new InjectionManager();
    }

    get _active() {
        return !this._settings.get_boolean('use-stock-grid');
    }

    get _controls() {
        return Main.overview._overview.controls;
    }

    enable() {
        const self = this;
        const overviewProto = Object.getPrototypeOf(Main.overview);

        this._injections.overrideMethod(overviewProto, 'show', show =>
            function (state = ControlsState.WINDOW_PICKER) {
                if (state === ControlsState.APP_GRID && self._active) {
                    self._request();
                    return;
                }
                show.call(this, state);
            });

        // Dash to Panel closes "its" app grid with hide(). Calls made while
        // the overview itself is visible are about the overview (Ubuntu Dock
        // calls hide() as the overview finishes hiding).
        this._injections.overrideMethod(overviewProto, 'hide', hide =>
            function () {
                if (self._layer.isOpen && !self._syncing && !this.visible)
                    self._layer.close();
                hide.call(this);
            });

        // Activities button, hot corner and Super all toggle the overview;
        // from the stock app grid they return to the desktop
        this._injections.overrideMethod(overviewProto, 'toggle', toggle =>
            function () {
                if (self._layer.isOpen) {
                    self._layer.close();
                    return;
                }
                toggle.call(this);
            });

        this._injections.overrideMethod(Object.getPrototypeOf(this._controls),
            '_onShowAppsButtonToggled', onToggled =>
                function () {
                    if (!self._active) {
                        onToggled.call(this);
                        return;
                    }
                    if (this._ignoreShowAppsButtonToggle || self._syncing)
                        return;
                    // Dash to Panel flips this button before calling
                    // show(APP_GRID), which is where the request lands
                    if (!Main.overview.visible)
                        return;
                    if (this.dash.showAppsButton.checked)
                        self._request();
                });

        Main.wm.removeKeybinding(TOGGLE_KEY);
        Main.wm.addKeybinding(TOGGLE_KEY,
            new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, KEY_MODES,
            () => this._onKeybinding());

        this._layer.connectObject('open-changed',
            (_l, open) => this._syncButton(open), this);
        Main.overview.connectObject('showing', () => {
            if (this._layer.isOpen && !this._syncing)
                this._layer.close({instant: true});
        }, 'hidden', () => {
            // the overview resets the button when it finishes hiding
            this._syncButton(this._layer.isOpen);
        }, this);
        this._settings.connectObject('changed::use-stock-grid', () => {
            if (!this._active && this._layer.isOpen)
                this._layer.close({instant: true});
        }, this);
    }

    disable() {
        this._layer.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._injections.clear();

        const controls = this._controls;
        Main.wm.removeKeybinding(TOGGLE_KEY);
        Main.wm.addKeybinding(TOGGLE_KEY,
            new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, KEY_MODES,
            controls._toggleAppsPage.bind(controls));
    }

    _onKeybinding() {
        if (!this._active) {
            this._controls._toggleAppsPage();
            return;
        }
        this._request();
    }

    _request() {
        if (this._syncing)
            return;
        if (Main.overview.visible || Main.overview.animationInProgress) {
            this._syncing = true;
            try {
                Main.overview.hide();
            } finally {
                this._syncing = false;
            }
            this._layer.open();
            return;
        }
        this._layer.toggle();
    }

    // Mirror the layer's state into the Show Apps button so Dash to Panel and
    // Ubuntu Dock highlight theirs. Ubuntu Dock answers every flip of its
    // button with show(APP_GRID), hence the guard.
    _syncButton(open) {
        const button = Main.overview.dash?.showAppsButton;
        if (!button || button.checked === open)
            return;
        this._syncing = true;
        try {
            button.checked = open;
        } finally {
            this._syncing = false;
        }
    }
}
