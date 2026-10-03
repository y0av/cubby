// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Searching: the board fades back and blurs, results appear under the
// field, and the field says what Enter will do.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {appCaption} from './results.js';
import {SearchEngine} from './searchEngine.js';
import {easeBlur} from './transitions.js';

const FADE_MS = 220;
const BOARD_OPACITY = 36; // about 14%
const BLUR_RADIUS = 16;
const RESULTS_IN_MS = 300;
const RESULTS_OUT_MS = 140;

export class SearchMode {
    /**
     * @param {Layer} layer - provides pill, results, board, searchShield,
     *   searching, selected, select(), activateApp() and close()
     * @param {AppModel} model
     */
    constructor(layer, model) {
        this._layer = layer;
        this._model = model;
        this._engine = new SearchEngine();
        this._fallback = null;
        // once the user moves the selection it stays on the same result
        // while they type; until then the first result is selected
        this._moved = false;
        this._engine.connectObject(
            'apps', () => this._render(),
            'others', () => this._render(), this);
    }

    destroy() {
        this._engine.disconnectObject(this);
        this._engine.destroy();
    }

    setQuery(text) {
        this._engine.setQuery(text);
    }

    selectionMoved() {
        this._moved = true;
    }

    enter() {
        const {pill, results, board, searchShield} = this._layer;
        pill.setSearching(true);
        searchShield.show();
        board.remove_transition('opacity');
        board.ease({opacity: BOARD_OPACITY, duration: FADE_MS});
        easeBlur(board, 'search-blur', BLUR_RADIUS, FADE_MS);
        results.remove_all_transitions();
        results.show();
        results.opacity = 0;
        results.translation_y = -8;
        results.ease({
            opacity: 255,
            translation_y: 0,
            duration: RESULTS_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    leave({instant = false} = {}) {
        const {pill, results, board, searchShield} = this._layer;
        pill.setSearching(false);
        pill.setHint('', '');
        searchShield.hide();
        this._engine.reset();
        this._fallback = null;
        this._moved = false;

        results.remove_all_transitions();
        if (instant) {
            results.clear();
            results.hide();
        } else {
            results.ease({
                opacity: 0,
                translation_y: -6,
                duration: RESULTS_OUT_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    results.clear();
                    results.hide();
                },
            });
        }
        const duration = instant ? 0 : FADE_MS;
        board.remove_transition('opacity');
        board.ease({opacity: 255, duration});
        easeBlur(board, 'search-blur', 0, duration);
    }

    activate(item, {newWindow = false} = {}) {
        if (item.kind === 'app') {
            this._layer.activateApp(item.app, item, {newWindow});
        } else if (item.kind === 'other') {
            this._engine.activate(item.result);
            this._layer.close();
        }
    }

    /** Enter: the selected result, or the software search when nothing matched. */
    activateSelection({newWindow = false} = {}) {
        if (this._layer.selected) {
            this.activate(this._layer.selected, {newWindow});
        } else if (this._fallback) {
            this._fallback.run();
            this._layer.close();
        }
    }

    _render() {
        const layer = this._layer;
        if (!layer.searching)
            return;
        const apps = this._engine.apps.map(app => ({app, ...appCaption(app, this._model)}));
        const others = this._engine.others;
        let none = null;
        this._fallback = null;
        if (!apps.length && !others.length) {
            const query = layer.pill.text.trim();
            this._fallback = this._engine.softwareFallback();
            if (this._fallback?.open)
                none = _('Nothing matches “%s”. Enter opens %s.').format(query, this._fallback.name);
            else if (this._fallback)
                none = _('Nothing matches “%s”. Enter searches %s.').format(query, this._fallback.name);
            else
                none = _('Nothing matches “%s”.').format(query);
        }

        const keyOf = item => item?.app?.id ?? item?.result?.id;
        const previous = keyOf(layer.selected);
        layer.results.setResults(apps, others, none, {focusApp: this._model.focusApp});
        const items = layer.results.items;
        const same = this._moved ? items.find(item => keyOf(item) === previous) : null;
        layer.select(same ?? items[0] ?? null);
        this.syncHint();
    }

    /** "10 apps · 4 other", then what Enter will do. */
    syncHint() {
        const apps = this._engine.apps.length;
        const others = this._engine.others.length;
        const counts = [];
        if (apps)
            counts.push(ngettext('%d app', '%d apps', apps).format(apps));
        if (others)
            counts.push(ngettext('%d other', '%d other', others).format(others));

        const selected = this._layer.selected;
        let action = '';
        if (selected?.kind === 'app') {
            const name = selected.app.get_name();
            action = selected.app.state === Shell.AppState.RUNNING
                ? _('Switch to %s').format(name) : _('Open %s').format(name);
        } else if (selected?.kind === 'other') {
            action = _('Open %s').format(selected.result.name);
        } else if (this._fallback) {
            action = this._fallback.open
                ? _('Open %s').format(this._fallback.name) : _('Search %s').format(this._fallback.name);
        }
        this._layer.pill.setHint(counts.join(' · '), action);
    }
}
