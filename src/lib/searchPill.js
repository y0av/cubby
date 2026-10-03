// The search field: a fixed-width glass pill. While typing, its right side
// shows the result count, an Enter keycap and what Enter will do.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const SearchPill = GObject.registerClass({
    Signals: {
        'text-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class SearchPill extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'hs-pill',
            reactive: true,
            x_align: Clutter.ActorAlign.START,
        });
        this.add_child(new St.Icon({
            style_class: 'hs-pill-icon',
            icon_name: 'edit-find-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.entry = new St.Entry({
            style_class: 'hs-entry',
            hint_text: _('Type to search apps, settings and files'),
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.entry.clutter_text.connect('text-changed', () => this.emit('text-changed', this.text));
        this.add_child(this.entry);

        this._hint = new St.BoxLayout({
            style_class: 'hs-pill-hint',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._count = new St.Label({style_class: 'hs-pill-count', y_align: Clutter.ActorAlign.CENTER});
        this._keycap = new St.Label({style_class: 'hs-keycap', text: _('Enter'), y_align: Clutter.ActorAlign.CENTER});
        this._action = new St.Label({style_class: 'hs-pill-action', y_align: Clutter.ActorAlign.CENTER});
        this._hint.add_child(this._count);
        this._hint.add_child(this._keycap);
        this._hint.add_child(this._action);
        this.add_child(this._hint);
    }

    get text() {
        return this.entry.get_text();
    }

    set text(t) {
        this.entry.set_text(t);
    }

    /**
     * @param {string} count - "10 apps · 4 other", or ''
     * @param {string} action - "Switch to Telegram", or '' for none
     */
    setHint(count, action) {
        this._hint.visible = !!(count || action);
        this._count.text = count;
        this._count.visible = !!count;
        this._keycap.visible = !!action;
        this._action.text = action;
        this._action.visible = !!action;
    }

    setAccent(theme) {
        this._keycap.style = `background-color: ${theme.accentRgba(0.22)}; border: 1px solid ${theme.accentRgba(0.55)};`;
        this.entry.style = `caret-color: ${theme.accent}; selection-background-color: ${theme.accentRgba(0.4)};`;
        this._searchBorder = theme.accentRgba(0.6);
        this.setSearching(this._searching ?? false);
    }

    setSearching(on) {
        this._searching = on;
        this.style = on && this._searchBorder ? `border-color: ${this._searchBorder};` : null;
    }

});
