// Home Screen: replaces the Show Apps grid with folder tiles you place and
// size yourself.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EntryPoints} from './lib/entryPoints.js';
import {Layer} from './lib/layer.js';

export default class HomeScreenExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._layer = new Layer(this);
        this._entryPoints = new EntryPoints(this._layer, this._settings);
        this._entryPoints.enable();
    }

    disable() {
        this._entryPoints.disable();
        this._entryPoints = null;
        this._layer.destroy();
        this._layer = null;
        this._settings = null;
    }
}
