// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Preferences for Cubby (libadwaita).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEFAULT_CUSTOM_ACCENT = '#cba6f7';

function rgbaToHex(rgba) {
    const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(rgba.red)}${h(rgba.green)}${h(rgba.blue)}`;
}

export default class CubbyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);

        const page = new Adw.PreferencesPage({
            title: _('Cubby'),
            icon_name: 'view-app-grid-symbolic',
        });
        window.add(page);

        // ---- appearance ----
        const look = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(look);

        const switchRow = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            look.add(row);
            return row;
        };
        switchRow('show-app-names', _('Show app names'), _('Names under the big icons on tiles'));
        switchRow('show-clock', _('Show clock'), _('A large clock and the date under the search field'));
        switchRow('frosted-glass', _('Frosted glass'),
            _('Show a blurred copy of the wallpaper inside tiles. Uses more graphics memory.'));

        const accentRow = new Adw.SwitchRow({
            title: _('Custom accent colour'),
            subtitle: _('Off follows the system accent colour'),
        });
        const color = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false, title: _('Accent colour')}),
            valign: Gtk.Align.CENTER,
        });
        accentRow.add_suffix(color);
        look.add(accentRow);

        const syncAccent = () => {
            const hex = settings.get_string('accent-override');
            accentRow.active = hex !== '';
            color.sensitive = hex !== '';
            const rgba = new Gdk.RGBA();
            if (rgba.parse(hex || DEFAULT_CUSTOM_ACCENT))
                color.rgba = rgba;
        };
        syncAccent();
        settings.connect('changed::accent-override', syncAccent);
        accentRow.connect('notify::active', () => {
            const on = accentRow.active;
            const cur = settings.get_string('accent-override');
            if (on && !cur)
                settings.set_string('accent-override', rgbaToHex(color.rgba));
            else if (!on && cur)
                settings.set_string('accent-override', '');
        });
        color.connect('notify::rgba', () => {
            if (accentRow.active)
                settings.set_string('accent-override', rgbaToHex(color.rgba));
        });

        // ---- behaviour ----
        const behaviour = new Adw.PreferencesGroup({title: _('Behaviour')});
        page.add(behaviour);
        const stock = new Adw.SwitchRow({
            title: _('Use the stock app grid instead'),
            subtitle: _('Show Apps and Super+A open GNOME’s own app grid again'),
        });
        settings.bind('use-stock-grid', stock, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(stock);

        const reset = new Adw.ActionRow({
            title: _('Reset layout'),
            subtitle: _('Forget every arrangement and size the folders by use again'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset the layout?'),
                body: _('Your tile positions and sizes on every screen size will be replaced by a generated layout.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response === 'reset')
                    settings.set_string('layouts', '{}');
            });
            dialog.present(window);
        });
        reset.add_suffix(resetButton);
        behaviour.add(reset);

        // ---- how to use ----
        const help = new Adw.PreferencesGroup({
            title: _('How to use'),
            description: _('Folders come from your app folders; arranging them never changes the folders themselves.'),
        });
        page.add(help);
        const tips = [
            [_('Open'), _('Super+A, or the Show Apps button in the dash, Dash to Panel or Ubuntu Dock')],
            [_('Search'), _('Start typing. Arrows and Tab move through results, Enter opens, Ctrl+Enter opens a new window')],
            [_('Edit layout'), _('Right-click and choose Edit layout, long-press a folder, or press Ctrl+E')],
            [_('Move and resize'), _('Drag a folder to move it and drag its round corner handle to resize. With the keyboard, arrows move the focused folder and Shift+arrows resize it')],
            [_('Leave'), _('Esc steps back: menu, edit mode, folder, search, then closes')],
        ];
        for (const [title, subtitle] of tips)
            help.add(new Adw.ActionRow({title, subtitle, subtitle_lines: 3, activatable: false}));
    }
}
