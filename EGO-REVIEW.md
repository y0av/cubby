# extensions.gnome.org review checklist

Checked against the [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) for the packed zip (`tools/build.sh`).

| Rule | Status | How it was checked |
|---|---|---|
| No work in the constructor | Pass | `extension.js` has no constructor; everything starts in `enable()`. |
| Everything created in `enable()` is destroyed in `disable()` | Pass | `disable()` destroys the entry-point hooks (keybinding re-added, `InjectionManager.clear()`), the layer actor (which destroys the board, tiles, results, folder view, menu, clock, wallpaper watcher and search engine, pops its modal grab and restores dimmed windows), the model and the theme. `tools/test-enable-cycle.sh` enables and disables 20 times and checks that the overridden methods, the uiGroup children and the modal count are exactly as before, that Super+A opens the stock grid again, and that no errors are logged. |
| Signals disconnected | Pass | All connections use `connectObject` with an owner that is disconnected in `destroy()`/`disable()`. The same cycle test then emits the signals the extension listened to. |
| Main loop sources removed | Pass | Every `timeout_add`/`idle_add` id is stored and removed on disable (model reload, search delay, long-press, edge page-flip and its follow-up). |
| No synchronous file I/O on the main loop | Pass | The wallpaper is read with `Gio.File.read_async` and decoded with `GdkPixbuf.Pixbuf.new_from_stream_at_scale_async`. Folder names go through `Shell.util_get_translated_folder_name`, the call the stock app grid makes for the same folders. |
| No `eval`, `Function()` or remote code | Pass | `grep` of `src/`. |
| No bundled binaries or libraries | Pass | The zip holds only JavaScript, CSS, the schema and the metadata. |
| Minimal logging | Pass | One `logError` for an unexpected search-provider failure and one `console.debug` for a provider error. Nothing on the normal path. |
| Uses the extension's own GSettings schema | Pass | `org.gnome.shell.extensions.homescreen`; the schema is compiled by `gnome-extensions install` (checked) and by extensions.gnome.org. |
| Never writes other components' settings | Pass | `org.gnome.desktop.app-folders`, `favorite-apps` and the shell keybinding settings are only read. The `toggle-application-view` keybinding is re-registered with the shell's own setting, not changed. |
| Preferences in `prefs.js` with libadwaita | Pass | `ExtensionPreferences.fillPreferencesWindow`. |
| Translations | Pass | `gettext-domain` in metadata; `po/homescreen.pot` generated with xgettext. |
| Licence | Pass | GPL-2.0-or-later (`COPYING`, SPDX headers). |
| `shell-version` | Pass | `["50"]` only, the version it was tested on. |
| Linter | Pass | `tools/lint.sh` (shexli 0.2.1): 0 findings. Note: shexli 0.2.1 crashes with tree-sitter 0.26 on this package; the script pins tree-sitter 0.25.2. |

## Things a reviewer may ask about

- **Private shell API.** The extension overrides `Overview.prototype.show/hide/toggle` and `ControlsManager.prototype._onShowAppsButtonToggled` through `InjectionManager`, re-registers `toggle-application-view`, and reads `Main.overview.searchController._searchResults._providers` (the overview's live search provider list) so that provider settings and other extensions' providers apply. `DECISIONS.md` gives the line references in GNOME Shell 50.1.
- **Modal grab.** While open it holds `Main.pushModal(global.stage, {actionMode: OVERVIEW})`, the same as the overview, and releases it on close, lock, monitor change, a notification taking focus and disable.
- **Window actors.** While open, window actors on the primary monitor are eased to opacity 0 and scale 0.965; the exact previous opacity, scale and pivot are restored on close and on disable.
