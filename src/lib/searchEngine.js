// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// Search: apps ranked the way the shell ranks them, plus results from the
// shell's own search providers (built-in and remote), reused from the
// overview so provider settings, sort order and extension providers apply.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

export const MAX_APPS = 10;
const PER_PROVIDER = 3;
const MAX_OTHER = 8;
const PROVIDER_DELAY_MS = 150;
const SOFTWARE_IDS = ['org.gnome.Software.desktop'];
const APP_CENTER_IDS = ['snap-store_snap-store.desktop', 'io.elementary.appcenter.desktop'];

/** Same splitting as ui/searchController.js getTermsForSearchString. */
export function termsFor(text) {
    const s = text.trim();
    return s ? s.split(/\s+/) : [];
}

/**
 * Emits 'apps' (apps[]) synchronously on each query and 'others'
 * (results[]) as providers answer. An "other" result is
 * {kind, id, name, source, createIcon(size), provider}.
 */
export class SearchEngine extends Signals.EventEmitter {
    constructor() {
        super();
        this._appSys = Shell.AppSystem.get_default();
        this._usage = Shell.AppUsage.get_default();
        this._parental = ParentalControlsManager.getDefault();
        this._systemActions = SystemActions.getDefault();
        this._terms = [];
        this._cancellable = null;
        this._timeoutId = 0;
        this._previous = {};
        this.apps = [];
        this.others = [];
    }

    destroy() {
        this.reset();
    }

    get terms() {
        return this._terms;
    }

    reset() {
        this._cancel();
        this._terms = [];
        this._previous = {};
        this.apps = [];
        this.others = [];
    }

    _cancel() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    setQuery(text) {
        const terms = termsFor(text);
        const prev = this._terms;
        this._terms = terms;
        this._cancel();
        if (!terms.length) {
            this.reset();
            this.emit('apps', []);
            this.emit('others', []);
            return;
        }
        // like the overview: a query that only extends the last one can
        // narrow the previous provider results
        const sub = prev.length > 0 && terms.length >= prev.length &&
            prev.every((t, i) => terms[i].startsWith(t));
        if (!sub)
            this._previous = {};

        this.apps = this._searchApps(terms);
        this.emit('apps', this.apps);

        this.others = this._systemResults(terms);
        this.emit('others', this.others);

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROVIDER_DELAY_MS, () => {
            this._timeoutId = 0;
            this._runProviders(terms, sub).catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'homescreen: search provider');
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _searchApps(terms) {
        const groups = Shell.AppSystem.search(terms.join(' '));
        const out = [];
        for (const group of groups) {
            const apps = group
                .map(id => this._appSys.lookup_app(id))
                .filter(app => app && this._parental.shouldShowApp(app.app_info));
            apps.sort((a, b) => this._usage.compare(a.id, b.id));
            out.push(...apps);
            if (out.length >= MAX_APPS)
                break;
        }
        return out.slice(0, MAX_APPS);
    }

    _systemResults(terms) {
        return this._systemActions.getMatchingActions(terms).map(id => ({
            kind: 'action',
            id,
            name: this._systemActions.getName(id),
            source: '',
            iconName: this._systemActions.getIconName(id),
        }));
    }

    _providers() {
        const list = Main.overview.searchController?._searchResults?._providers ?? [];
        return list.filter(p => p.id !== 'applications');
    }

    async _runProviders(terms, sub) {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const providers = this._providers();
        const results = new Map();
        const publish = () => {
            if (cancellable.is_cancelled())
                return;
            const others = [...this._systemResults(terms)];
            for (const p of providers)
                others.push(...(results.get(p) ?? []));
            this.others = others.slice(0, MAX_OTHER);
            this.emit('others', this.others);
        };
        await Promise.all(providers.map(async provider => {
            try {
                const prev = this._previous[provider.id];
                let ids = sub && prev
                    ? await provider.getSubsearchResultSet(prev, terms, cancellable)
                    : await provider.getInitialResultSet(terms, cancellable);
                if (cancellable.is_cancelled())
                    return;
                this._previous[provider.id] = ids;
                ids = provider.filterResults(ids, PER_PROVIDER);
                if (!ids.length)
                    return;
                const metas = await provider.getResultMetas(ids, cancellable);
                if (cancellable.is_cancelled())
                    return;
                const source = provider.appInfo?.get_name() ?? '';
                results.set(provider, metas.map(m => ({
                    kind: 'provider',
                    id: m.id,
                    name: m.name,
                    source,
                    createIcon: m.createIcon,
                    provider,
                })));
                publish();
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.debug(`homescreen: provider ${provider.id}: ${e.message}`);
            }
        }));
    }

    activate(result) {
        if (result.kind === 'action')
            this._systemActions.activateAction(result.id);
        else
            result.provider.activateResult(result.id, this._terms);
    }

    /**
     * Where Enter goes when nothing matches: GNOME Software's search, or
     * App Center (which has no search entry point, so it just opens).
     *
     * @returns {{name: string, run: Function}|null}
     */
    softwareFallback() {
        const software = this._providers().find(p => SOFTWARE_IDS.includes(p.appInfo?.get_id()));
        if (software?.canLaunchSearch) {
            const terms = this._terms;
            return {name: software.appInfo.get_name(), run: () => software.launchSearch(terms)};
        }
        for (const id of APP_CENTER_IDS) {
            const app = this._appSys.lookup_app(id);
            if (app)
                return {name: app.get_name(), run: () => app.activate(), open: true};
        }
        return null;
    }
}
