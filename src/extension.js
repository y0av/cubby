// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Cubby: a home screen for GNOME. Replaces the Show Apps grid with folder
// tiles you place and size yourself.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EntryPoints} from './lib/entryPoints.js';
import {Layer} from './lib/layer.js';
import {AppModel} from './lib/model.js';
import {Theme} from './lib/theme.js';

export default class CubbyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._theme = new Theme(this._settings);
        this._model = new AppModel(this._settings);
        this._layer = new Layer({
            settings: this._settings,
            model: this._model,
            theme: this._theme,
            extension: this,
        });
        this._entryPoints = new EntryPoints(this._layer, this._settings);
        this._entryPoints.enable();
    }

    disable() {
        this._entryPoints.disable();
        this._entryPoints = null;
        this._layer.destroy();
        this._layer = null;
        this._model.destroy();
        this._model = null;
        this._theme.destroy();
        this._theme = null;
        this._settings = null;
    }
}
