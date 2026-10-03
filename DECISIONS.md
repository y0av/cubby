# Decisions

Working notes for the Home Screen extension. Each entry says what was decided and why. Shell file references are to the GNOME Shell 50.1 sources extracted from `/usr/lib/gnome-shell/libshell-18.so` (`gresource extract`), paths under `/org/gnome/shell/`. Line numbers are from that build (Ubuntu package 50.1-0ubuntu1.3).

## Sources read (M0)

`ui/main.js`, `ui/overview.js`, `ui/overviewControls.js`, `ui/appDisplay.js`, `ui/dash.js`, `ui/search.js`, `ui/searchController.js`, `ui/remoteSearch.js`, `ui/windowManager.js`, `ui/layout.js`, `ui/background.js`, `ui/backgroundMenu.js`, `ui/popupMenu.js`, `ui/screenShield.js`, `extensions/extension.js`, `extensions/sharedInternals.js`. Theme CSS from `/usr/share/gnome-shell/gnome-shell-theme.gresource`. Dash to Panel v74 (`taskbar.js`, `appIcons.js`, `panel.js`) and Ubuntu Dock (`docking.js`, `dash.js`, `appIcons.js`) read only.

## Entry points

The extension owns "show the app grid". Every route into the stock grid ends in one of four places, and each is intercepted once.

| Route | Where it lands | Hook |
|---|---|---|
| Super+A | `ui/overviewControls.js:515-520` registers `toggle-application-view` with `this._toggleAppsPage.bind(this)`. The bound function cannot be patched, so the binding is replaced. | `Main.wm.removeKeybinding('toggle-application-view')`, then `Main.wm.addKeybinding` with our handler and the same flags (`IGNORE_AUTOREPEAT`) and modes (`NORMAL \| OVERVIEW`). On disable: remove ours, re-add the original bound to the live `ControlsManager._toggleAppsPage`. |
| `Main.overview.showApps()` and anything calling `Main.overview.show(APP_GRID)` | `ui/overview.js:609` `showApps()` calls `this.show(ControlsState.APP_GRID)`; `show()` is at `ui/overview.js:486`. | Override `Overview.prototype.show` (InjectionManager on the prototype of `Main.overview`): `APP_GRID` becomes a toggle request; other states pass through. |
| Stock dash Show Apps button (inside the overview) | `ui/dash.js:350-356` exposes `showAppsButton`; `ui/overviewControls.js:417-418` connects `notify::checked` to an arrow function calling `this._onShowAppsButtonToggled()` (`:684`). | Override `ControlsManager.prototype._onShowAppsButtonToggled`. Keep the `_ignoreShowAppsButtonToggle` early return. When the overview is visible and the button becomes checked, hide the overview and open the layer. When the overview is not visible, do nothing (Dash to Panel flips this button on its way to `show(APP_GRID)`). |
| Dash to Panel Show Apps button | `taskbar.js:1457-1520`: when its own button turns on it sets the shell's `showAppsButton.checked = true` then calls `Main.overview.show(2)`. When it turns off it calls `Main.overview.hide()` (because `forcedOverview` is set when the overview was not shown). `taskbar.js:378-384` mirrors the shell button back into its own. | Covered by the `show` override for opening. Closing needs a `hide()` override: when the layer is open, `Main.overview.hide()` closes it. |
| Ubuntu Dock Show Apps button | `docking.js:2225-2226` swaps `overviewControls.dash` and `searchController._showAppsButton` for the dock's. `docking.js:2531-2554`: any toggle while the overview is hidden calls `Main.overview.show(APP_GRID)`; while visible it calls `overviewControls._onShowAppsButtonToggled()` directly. | Covered by the `show` and `_onShowAppsButtonToggled` overrides. |

**Toggle semantics.** Every request toggles based on the layer's own state, never on a button's `checked` state. The layer mirrors its open state into `Main.overview.dash.showAppsButton.checked` (which is the dock's button when Ubuntu Dock is on), so Dash to Panel and Ubuntu Dock show their button as active while the layer is open. That write is done under a guard flag, because Ubuntu Dock answers every toggle of its button with `show(APP_GRID)`. Requests that arrive while the guard is set are ignored.

**Other overrides.** `Overview.prototype.toggle` closes the layer when it is open (Activities button, hot corner and the Super key all call `toggle()`; stock Super from the app grid also returns to the desktop). The overview's `showing` signal closes the layer in case anything else opens the overview.

**Fallback preference.** `use-stock-grid` turns every override into a pass-through without disabling the extension, so switching back is instant.

## Layer

- **Placement:** one `St.Widget` in `Main.layoutManager.uiGroup`, placed directly above `global.window_group`. `ui/layout.js:230-257` puts `window_group` first in `uiGroup`, and `addChrome()` (`ui/layout.js:882-891`) inserts chrome (the panel, Dash to Panel, Ubuntu Dock, the overview group, the screen shield) below `top_window_group` but above `window_group`. So the layer sits over windows and under every panel, dock, notification and modal dialog without having to know about them.
- **Modal:** `Main.pushModal(global.stage, {actionMode: Shell.ActionMode.OVERVIEW})`, the same call the overview makes (`ui/overview.js:451-480`). Grabbing the stage rather than the layer keeps the panel and docks clickable. Key focus is then set on the layer's own widgets. `OVERVIEW` mode matches the stock app grid: Super, Alt+Tab, Super+A and the run dialog still work (`ui/main.js:127`, `ui/windowManager.js:1589-1602`).
- **Release:** close (and pop the modal) on screen lock (`Main.sessionMode` `updated`, and `Main.screenShield` `locked-changed`), monitor change (`Main.layoutManager` `monitors-changed`), workspace switch, the overview showing, and a window taking focus (a notification or another app activating).
- **Windows:** each window actor on the primary monitor is eased to opacity 0 and scale 0.965 about the point (50%, 40%) of the monitor, using a per-actor pivot so the result matches scaling the whole group. The background lives inside `window_group` (`ui/layout.js:322-324`), so scaling the group itself would shrink the wallpaper too. Original opacity, scale and pivot are stored and restored on close and on disable.

## Search providers

`ui/search.js:623-668`: the overview's `SearchResultsView` keeps `_providers`, rebuilt by `_reloadRemoteProviders()` from `RemoteSearch.loadRemoteSearchProviders(settings)`, which applies `disabled`, `enabled`, `disable-external` and `sort-order` (`ui/remoteSearch.js:143-170`). Extensions register more through `searchController.addProvider()` (`ui/searchController.js:336`). The layer reuses that live list (`Main.overview.searchController._searchResults._providers`) instead of loading a second set, so settings changes, sort order and extension providers apply with no extra code. The built-in `applications` provider is skipped for apps (the layer ranks apps itself the same way) but its system-action results (Power Off, Lock and so on) are shown as chips.

App ranking copies `AppSearchProvider.getInitialResultSet` (`ui/appDisplay.js:1799-1829`): `Shell.AppSystem.search(query)` groups in order, each group sorted by `Shell.AppUsage.compare`, filtered by parental controls.

## Folders

`ui/appDisplay.js:96-105` (`_getFolderName`, honouring `translate` via `Shell.util_get_translated_folder_name`), `:79-84` (`_getCategories`), `:1490-1560` (top-level `_loadApps`: favourites and parental-controls filtered), `:2149-2190` (`FolderView._loadApps`: `apps` plus apps matching `categories`, minus `excluded-apps` and favourites). Empty folders are skipped, as the stock grid does.

## Theme

GNOME Shell 50's St supports `-st-accent-color`, `st-mix()` and `st-transparentize()` in CSS. The accent here is still applied from JS, because the preference allows a custom hex that St's accent cannot express. Light and dark glass are two class variants on the layer root.

## Test rig

`tools/nest.sh` runs `dbus-run-session -- gnome-shell --headless --wayland --no-x11 --virtual-monitor WxH` with its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`. Without that, the nested shell's dconf writes (enabling extensions, test settings) would land in `~/.config/dconf/user` and the live shell would pick them up. The user's folders, favourites, usage history (`application_state`) and fonts are copied or linked in read-only.

- `--devkit` is not usable here: the `mutter-devkit` viewer binary is not installed. Headless with a virtual monitor gives the same compositor without a window on the desktop.
- A development-only helper extension (`tools/testkit@homescreen.local`, never packed) turns on `global.context.unsafe_mode` in the nested shell so `org.gnome.Shell.Eval` and `org.gnome.Shell.Screenshot` work for scripted tests.
- The machine's GPU is AMD (PCI vendor 0x1002), not Intel. Frame timings are measured on it.
