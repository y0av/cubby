// The full-screen layer that replaces Show Apps on the primary monitor.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WindowDimmer} from './windowDimmer.js';

const SCRIM_FADE_MS = 450;
const WINDOW_DIM_MS = 350;
const CLOSE_MS = 260;

export const Layer = GObject.registerClass({
    Signals: {
        'open-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Layer extends St.Widget {
    _init(extension) {
        super._init({
            name: 'homescreenLayer',
            style_class: 'hs-layer',
            reactive: true,
            can_focus: true,
            visible: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._extension = extension;
        this._settings = extension.getSettings();
        this._isOpen = false;
        this._grab = null;
        this._dimmer = new WindowDimmer();

        this._scrim = new St.Widget({style_class: 'hs-scrim', opacity: 0});
        this.add_child(this._scrim);

        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this);
        uiGroup.set_child_above_sibling(this, global.window_group);

        this._monitorIndex = Main.layoutManager.primaryIndex;
        this._syncGeometry();

        Main.layoutManager.connectObject('monitors-changed', () => {
            this.close({instant: true});
            this._monitorIndex = Main.layoutManager.primaryIndex;
            this._syncGeometry();
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
        global.display.connectObject('notify::focus-window', () => {
            if (this._isOpen && global.display.focus_window)
                this.close();
        }, this);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    get isOpen() {
        return this._isOpen;
    }

    get monitor() {
        return Main.layoutManager.monitors[this._monitorIndex];
    }

    _syncGeometry() {
        const m = this.monitor;
        if (!m)
            return;
        this.set_position(m.x, m.y);
        this.set_size(m.width, m.height);
        this._scrim.set_size(m.width, m.height);
    }

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
        Main.layoutManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._settings = null;
    }
});
