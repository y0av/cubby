// Small pieces of the layer: the right-click menu, the edit-mode banner and
// the first-run tip.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/** Right-click menu: Edit layout, Show app names, Show clock, Reset, Preferences. */
export class ContextMenu {
    /**
     * @param {St.Widget} owner - the layer
     * @param {object} actions - {edit, reset, prefs}
     * @param {Gio.Settings} settings
     */
    constructor(owner, actions, settings) {
        this._settings = settings;
        this.menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        this.menu.actor.add_style_class_name('hs-menu');
        this._manager = new PopupMenu.PopupMenuManager(owner);
        this._manager.addMenu(this.menu);
        Main.layoutManager.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();

        const edit = this.menu.addAction(_('Edit layout'), () => actions.edit());
        edit.add_child(new St.Label({
            style_class: 'hs-menu-accel',
            text: _('Ctrl E'),
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._names = this.menu.addAction(_('Show app names'),
            () => settings.set_boolean('show-app-names', !settings.get_boolean('show-app-names')));
        this._clock = this.menu.addAction(_('Show clock'),
            () => settings.set_boolean('show-clock', !settings.get_boolean('show-clock')));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const reset = this.menu.addAction(_('Reset layout'), () => actions.reset());
        const prefs = this.menu.addAction(_('Preferences…'), () => actions.prefs());
        // same indent for every item, checkable or not
        for (const item of [edit, reset, prefs])
            item.setOrnament(PopupMenu.Ornament.NONE);
    }

    get isOpen() {
        return this.menu.isOpen;
    }

    setDark(dark) {
        this.menu.actor.remove_style_class_name(dark ? 'hs-light' : 'hs-dark');
        this.menu.actor.add_style_class_name(dark ? 'hs-dark' : 'hs-light');
    }

    /** Opens at stage coordinates. */
    open(x, y) {
        const check = on => (on ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._names.setOrnament(check(this._settings.get_boolean('show-app-names')));
        this._clock.setOrnament(check(this._settings.get_boolean('show-clock')));
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this.menu.open(BoxPointer.PopupAnimation.FULL);
        this.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    close() {
        this.menu.close(BoxPointer.PopupAnimation.NONE);
    }

    destroy() {
        this.menu.destroy();
    }
}

/** Banner that replaces the search field in edit mode. */
export const EditBar = GObject.registerClass(
class EditBar extends St.BoxLayout {
    _init(onDone) {
        super._init({style_class: 'hs-editbar', reactive: true, visible: false});
        this.add_child(new St.Label({
            style_class: 'hs-editbar-title',
            text: _('Editing layout'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(new St.Label({
            style_class: 'hs-editbar-text',
            text: _('drag a folder to move it · drag the round corner handle to resize'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.done = new St.Button({
            style_class: 'hs-done',
            label: _('Done'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.done.connect('clicked', () => onDone());
        this.add_child(this.done);
    }

    setAccent(theme) {
        this.done.style = `background-color: ${theme.accent}; color: ${theme.accentInk};`;
        this.style = `border-color: ${theme.accentRgba(0.5)};`;
    }
});

/** One-time tip near the bottom, dismissed for good with "Got it". */
export const Coach = GObject.registerClass(
class Coach extends St.BoxLayout {
    _init(onDismiss) {
        super._init({style_class: 'hs-coach', reactive: true, visible: false});
        const label = new St.Label({style_class: 'hs-coach-text', y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.set_markup(_('<b>Tip:</b> right-click or long-press a folder to resize and arrange'));
        this.add_child(label);
        const ok = new St.Button({style_class: 'hs-coach-ok', label: _('Got it'), can_focus: true});
        ok.connect('clicked', () => onDismiss());
        this.add_child(ok);
    }
});
