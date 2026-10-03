// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// What goes on the board: folders from org.gnome.desktop.app-folders (read
// only), an "Unsorted" group for the rest, or generated category groups for
// people who never made folders. Apps inside a group are ordered by usage.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const FOLDERS_SCHEMA = 'org.gnome.desktop.app-folders';
const FOLDER_SCHEMA = 'org.gnome.desktop.app-folders.folder';
const UNSORTED_ID = 'cubby:unsorted';
const VIRTUAL_PREFIX = 'cubby:cat:';

// GNOME's own default folders (ui/appDisplay.js DEFAULT_FOLDERS). A user
// with only these has not organised anything, so the rest of their apps get
// category groups instead of one huge "Unsorted".
const DEFAULT_FOLDER_IDS = ['System', 'Utilities', 'YaST', 'Pardus'];

// freedesktop main categories, in the order an app is assigned to them
const CATEGORY_GROUPS = [
    {id: 'Game', cats: ['Game'], name: () => _('Games')},
    {id: 'Development', cats: ['Development'], name: () => _('Development')},
    {id: 'Graphics', cats: ['Graphics'], name: () => _('Graphics')},
    {id: 'AudioVideo', cats: ['AudioVideo', 'Audio', 'Video'], name: () => _('Media')},
    {id: 'Network', cats: ['Network'], name: () => _('Internet')},
    {id: 'Office', cats: ['Office'], name: () => _('Office')},
    {id: 'Education', cats: ['Education', 'Science'], name: () => _('Education')},
    {id: 'Settings', cats: ['Settings'], name: () => _('Settings')},
    {id: 'System', cats: ['System'], name: () => _('System')},
    {id: 'Utility', cats: ['Utility', 'Accessibility'], name: () => _('Utilities')},
];
const OTHER_GROUP = {id: 'Other', name: () => _('Other')};

function categoriesOf(appInfo) {
    const s = appInfo.get_categories();
    return s ? s.split(';').filter(Boolean) : [];
}

function folderName(settings) {
    const name = settings.get_string('name');
    if (settings.get_boolean('translate')) {
        const translated = Shell.util_get_translated_folder_name(name);
        if (translated !== null)
            return translated;
    }
    return name;
}

/**
 * Emits:
 *  - 'changed' (structural: boolean, changedIds: Set) after folders reload
 *  - 'running-changed' (app) when an app starts, stops or changes windows
 *  - 'focus-changed' (oldApp, newApp)
 */
export class AppModel extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._appSys = Shell.AppSystem.get_default();
        this._usage = Shell.AppUsage.get_default();
        this._tracker = Shell.WindowTracker.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._parental = ParentalControlsManager.getDefault();
        this._folderSettings = new Gio.Settings({schema_id: FOLDERS_SCHEMA});
        this._childSettings = new Map();
        this.folders = [];
        this._groupOf = new Map();
        this._newApps = new Set();
        this._reloadId = 0;
        this._focusApp = this._tracker.focus_app;

        const queue = () => this._queueReload();
        this._settings.connectObject('changed::folder-orders', () => {
            if (!this._writingOrders)
                this.refreshUsage();
        }, this);
        this._appSys.connectObject('installed-changed', queue, this);
        this._folderSettings.connectObject('changed::folder-children', queue, this);
        this._favorites.connectObject('changed', queue, this);
        this._parental.connectObject('app-filter-changed', queue, this);
        this._appSys.connectObject('app-state-changed',
            (_s, app) => this.emit('running-changed', app), this);
        this._tracker.connectObject('tracked-windows-changed', () => {
            for (const app of this._appSys.get_running())
                this.emit('running-changed', app);
        }, 'notify::focus-app', () => {
            const old = this._focusApp;
            this._focusApp = this._tracker.focus_app;
            this.emit('focus-changed', old, this._focusApp);
        }, this);

        this._initKnownApps();
        this._reload();
    }

    destroy() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = 0;
        this._appSys.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._folderSettings.disconnectObject(this);
        this._favorites.disconnectObject(this);
        this._parental.disconnectObject(this);
        this._tracker.disconnectObject(this);
        for (const s of this._childSettings.values())
            s.disconnectObject(this);
        this._childSettings.clear();
        this.folders = [];
        this._groupOf.clear();
    }

    get focusApp() {
        return this._focusApp;
    }

    /** Folder (group) containing an app, or null (pinned or hidden). */
    groupOf(appId) {
        return this._groupOf.get(appId) ?? null;
    }

    isFavorite(appId) {
        return this._favorites.isFavorite(appId);
    }

    isNew(appId) {
        return this._newApps.has(appId);
    }

    folder(id) {
        return this.folders.find(f => f.id === id) ?? null;
    }

    /** Re-sort apps by usage; emits 'changed' for folders whose order moved. */
    refreshUsage() {
        const orders = this._orders();
        const changed = new Set();
        for (const f of this.folders) {
            const before = f.apps.map(a => a.id).join('\n');
            this._sortApps(f, orders);
            if (f.apps.map(a => a.id).join('\n') !== before)
                changed.add(f.id);
        }
        if (changed.size)
            this.emit('changed', false, changed);
    }

    /** Whether the user has put this folder's apps in their own order. */
    hasCustomOrder(folderId) {
        return Array.isArray(this._orders()[folderId]);
    }

    /**
     * Stores the user's order for a folder (null goes back to most used
     * first) and re-sorts it. Kept in the extension's own settings.
     */
    setFolderOrder(folderId, appIds) {
        const orders = this._orders();
        if (appIds)
            orders[folderId] = appIds;
        else
            delete orders[folderId];
        this._writingOrders = true;
        try {
            this._settings.set_string('folder-orders', JSON.stringify(orders));
        } finally {
            this._writingOrders = false;
        }
        this.refreshUsage();
    }

    _orders() {
        try {
            const o = JSON.parse(this._settings.get_string('folder-orders') || '{}');
            return o && typeof o === 'object' ? o : {};
        } catch {
            return {};
        }
    }

    // the user's order first (if any), then the rest most used first
    _sortApps(folder, orders) {
        const saved = orders[folder.id];
        const pos = new Map(Array.isArray(saved) ? saved.map((id, i) => [id, i]) : []);
        folder.apps.sort((a, b) => {
            const pa = pos.get(a.id) ?? Infinity, pb = pos.get(b.id) ?? Infinity;
            if (pa !== pb)
                return pa - pb;
            return this._compareApps(a, b);
        });
    }

    /** Folders most used first, as {id, count} for layout generation. */
    foldersByUsage() {
        const rank = new Map(this._usage.get_most_used().map((app, i) => [app.id, i]));
        const n = rank.size || 1;
        const score = f => f.apps.reduce((a, app) =>
            a + (rank.has(app.id) ? (n - rank.get(app.id)) / n : 0), 0);
        return this.folders
            .map((f, i) => ({id: f.id, count: f.apps.length, score: score(f), i}))
            .sort((a, b) => b.score - a.score || b.count - a.count || a.i - b.i);
    }

    /** Records the current apps as seen, clearing "New" markers. */
    markAllSeen() {
        const ids = this._visibleAppInfos().map(i => i.get_id()).sort();
        const known = this._settings.get_strv('known-apps').slice().sort();
        if (ids.join('\n') !== known.join('\n'))
            this._settings.set_strv('known-apps', ids);
        if (this._newApps.size) {
            const was = new Set([...this._newApps].map(id => this._groupOf.get(id)?.id).filter(Boolean));
            this._newApps.clear();
            this.emit('changed', false, was);
        }
    }

    _initKnownApps() {
        // first run: nothing is "new"
        if (this._settings.get_strv('known-apps').length === 0) {
            const ids = this._visibleAppInfos().map(i => i.get_id());
            if (ids.length)
                this._settings.set_strv('known-apps', ids);
        }
    }

    _queueReload() {
        if (this._reloadId)
            return;
        this._reloadId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reloadId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _compareApps(a, b) {
        return this._usage.compare(a.id, b.id) || a.get_name().localeCompare(b.get_name());
    }

    _visibleAppInfos() {
        return this._appSys.get_installed().filter(info => {
            try {
                info.get_id();
            } catch {
                return false;
            }
            return this._parental.shouldShowApp(info);
        });
    }

    _folderChild(id) {
        let s = this._childSettings.get(id);
        if (!s) {
            s = new Gio.Settings({
                schema_id: FOLDER_SCHEMA,
                path: `${this._folderSettings.path}folders/${id}/`,
            });
            s.connectObject('changed', () => this._queueReload(), this);
            this._childSettings.set(id, s);
        }
        return s;
    }

    _reload() {
        const infos = this._visibleAppInfos();
        const visible = new Map(infos.map(i => [i.get_id(), i]));
        const lookup = id => (visible.has(id) ? this._appSys.lookup_app(id) : null);
        const known = new Set(this._settings.get_strv('known-apps'));
        this._newApps = new Set([...visible.keys()].filter(id => known.size && !known.has(id)));

        const groups = [];
        const placed = new Set();
        const folderIds = this._folderSettings.get_strv('folder-children');
        for (const [id, s] of this._childSettings) {
            if (!folderIds.includes(id)) {
                s.disconnectObject(this);
                this._childSettings.delete(id);
            }
        }

        // real folders, the way FolderView._loadApps builds them
        for (const id of folderIds) {
            const s = this._folderChild(id);
            const excluded = s.get_strv('excluded-apps');
            const apps = [];
            const add = appId => {
                if (excluded.includes(appId) || this._favorites.isFavorite(appId))
                    return;
                const app = lookup(appId);
                if (app && !apps.includes(app))
                    apps.push(app);
            };
            s.get_strv('apps').forEach(add);
            const cats = s.get_strv('categories');
            if (cats.length) {
                for (const info of infos) {
                    if (categoriesOf(info).some(c => cats.includes(c)))
                        add(info.get_id());
                }
            }
            if (!apps.length)
                continue;
            apps.forEach(a => placed.add(a.id));
            groups.push({id, name: folderName(s), apps});
        }

        const rest = [...visible.keys()]
            .filter(id => !placed.has(id) && !this._favorites.isFavorite(id))
            .map(id => this._appSys.lookup_app(id))
            .filter(Boolean);
        const organised = groups.some(g => !DEFAULT_FOLDER_IDS.includes(g.id));
        if (organised) {
            if (rest.length)
                groups.push({id: UNSORTED_ID, name: _('Unsorted'), apps: rest});
        } else {
            // a category named like an existing folder (GNOME's default
            // "System") joins that folder instead of showing twice
            for (const g of this._categoryGroups(rest, visible)) {
                const same = groups.find(f => f.name.toLocaleLowerCase() === g.name.toLocaleLowerCase());
                if (same)
                    same.apps.push(...g.apps.filter(a => !same.apps.includes(a)));
                else
                    groups.push(g);
            }
        }

        const orders = this._orders();
        for (const g of groups)
            this._sortApps(g, orders);

        this._groupOf.clear();
        for (const g of groups) {
            for (const app of g.apps) {
                if (!this._groupOf.has(app.id))
                    this._groupOf.set(app.id, g);
            }
        }

        // diff against the previous folders
        const prev = new Map(this.folders.map(f => [f.id, f]));
        const structural = this.folders.map(f => f.id).join('\n') !== groups.map(g => g.id).join('\n');
        const changed = new Set();
        for (const g of groups) {
            const p = prev.get(g.id);
            if (!p || p.name !== g.name || p.apps.map(a => a.id).join('\n') !== g.apps.map(a => a.id).join('\n'))
                changed.add(g.id);
        }
        this.folders = groups;
        if (structural || changed.size)
            this.emit('changed', structural, changed);
    }

    // Category groups for people without folders, kept stable in the
    // extension's own settings (never in org.gnome.desktop.app-folders).
    _categoryGroups(apps, visible) {
        let stored;
        try {
            stored = JSON.parse(this._settings.get_string('virtual-groups') || '{}');
        } catch {
            stored = {};
        }
        const assign = stored.assign ?? {};
        let dirty = false;
        const byGroup = new Map();
        for (const app of apps) {
            let gid = assign[app.id];
            if (!gid) {
                const cats = categoriesOf(visible.get(app.id));
                gid = (CATEGORY_GROUPS.find(g => g.cats.some(c => cats.includes(c))) ?? OTHER_GROUP).id;
                assign[app.id] = gid;
                dirty = true;
            }
            if (!byGroup.has(gid))
                byGroup.set(gid, []);
            byGroup.get(gid).push(app);
        }
        for (const id of Object.keys(assign)) {
            if (!visible.has(id)) {
                delete assign[id];
                dirty = true;
            }
        }
        if (dirty)
            this._settings.set_string('virtual-groups', JSON.stringify({version: 1, assign}));

        return [...CATEGORY_GROUPS, OTHER_GROUP]
            .filter(g => byGroup.has(g.id))
            .map(g => ({
                id: `${VIRTUAL_PREFIX}${g.id}`,
                name: Shell.util_get_translated_folder_name(`${g.id}.directory`) ?? g.name(),
                apps: byGroup.get(g.id),
            }));
    }
}
