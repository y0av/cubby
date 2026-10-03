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

## Board (M2)

- **Grid sizing:** the unit scales with the work area, `s = clamp(min(w / 1920, h / 1152), 0.66, 1.3)`, where 1920×1152 is the reference work area (1920×1200 minus a 48px panel). The sketch's spacing is used first (pill 152·s below the work-area top, or 84·s with the clock; 116·s kept free at the bottom). Only if that gives fewer than 3 rows are tighter margins tried, then a smaller unit. Columns are whatever fits with a 64·s side margin, capped at 12 so an ultrawide doesn't turn into a 15-column strip. The reference reproduces the sketch exactly: 9×3 at U=156, pill at y=200 and board at y=340 (y=132 and 404 with the clock). The upper limit was raised from 1.15 to 1.3 so 2560×1440 keeps the reference proportions instead of leaving 380px empty under the board.
- **Results at the targets** (no clock): 1366×768 10×3 at U=103; 1920×1080 with Ubuntu Dock 10×3 at U=142; 1920×1200 9×3 at U=156; 2560×1440 10×3 at U=191; 3840×2160 at 200% 10×3 at U=142; 3440×1440 12×3 at U=191. Screenshots in `shots/m2/`.
- **Generated layout:** folders are ranked by usage (sum over their apps of the app's rank in `Shell.AppUsage.get_most_used()`). Sizes follow the spec (3×2, 2×2, then 2-cell, then 1×1) with two additions. A tile never gets more slots than its folder has apps, so a 3-app folder ranked first is 2×1, not a half-empty 3×2. Spare cells are then given back, most used first, but no folder may outgrow one ranked above it and only the top folder may be 3×2. Without this the author's folders filled 18 of 27 cells and left the bottom row empty.
- **No holes:** a hole is an empty cell with a tile to its right on the same row, or with a tile starting on a later row. First-fit fills most; the rest are closed by growing a neighbour that has the apps for it, then by moving the last tile into the hole, and as a last resort by growing a tile one slot beyond its app count.
- **Storage:** `layouts` keeps one layout per grid size (`"9x3"`, `"12x4"`...). A grid the user edited keeps its own layout, so a laptop screen and an external monitor each remember their arrangement. A grid never seen is reflowed (reading order kept, sizes clamped, first-fit) from the most recently edited layout. If the user never edited anything, a new grid gets a freshly generated layout instead, since a generated layout carries no preference worth preserving and reflowing it can spill onto a second page.
- **Folders:** the spec says category groups only for users with no folders. A stock install has GNOME's default folders (System, Utilities), which would leave everything else in one huge "Unsorted" tile. So a user counts as "organised" only with at least one folder other than the shell's `DEFAULT_FOLDERS` ids; otherwise the default folders stay and the remaining apps are grouped by main category, with names from the system `.directory` files. The assignment is stored in `virtual-groups`.
- **Usage changes:** `Shell.AppUsage` has no change signal. Tiles are re-sorted on each open and only tiles whose order changed are rebuilt.
- **"New" marker:** `known-apps` is initialised on first run (nothing is new) and rewritten when the layer closes, so an app is marked during the first open after it appears. Big icons get a small "New" label; mini icons get a dot.
- **Clutter quirk:** in Mutter 50, `Clutter.BinLayout` honours a child's `x_align`/`y_align` only when the child also has `x_expand`/`y_expand`. Without it, the "+N" badge was centred on the preview.
- **Mutter 50:** `scale-monitor-framebuffer` is no longer an experimental feature (Mutter logs it as unknown); logical layout is always on, so St's scale factor is 1 and stage coordinates are logical pixels. The code still multiplies its pixel metrics by the St scale factor in case that changes.

## Search (M3)

- **Key routing:** the layer handles keys in its `captured-event` handler, so arrows, Tab, Enter and Esc work the same whether the entry or a tile has key focus. The first printable key on the board focuses the entry and re-delivers the event to it (the same `text.event(event, false)` the overview's `SearchController.startSearch` uses), so input methods and dead keys go through the real `ClutterText`. Keys pass straight through while the entry has a pre-edit string.
- **Selection in results is virtual:** key focus stays in the entry so typing never stops working; arrows and Tab move a selection over the results, and Enter activates it. The first app result is selected after every keystroke unless the user has already moved the selection to a result that is still there.
- **Providers:** up to 3 results per provider and 8 "other" results in total, in the provider order the shell already sorted. Remote providers start 150ms after the last keystroke (the overview's delay); a query that extends the previous one uses `getSubsearchResultSet`.
- **No results:** Enter runs GNOME Software's `LaunchSearch` through its search provider when it is installed. Ubuntu's App Center has no search entry point (it is not a search provider and has no documented search argument), so without GNOME Software the row says Enter *opens* App Center.
- **Clutter quirks:** `Clutter.FlowLayout` allocates its children with zero height in Mutter 50, so the chips use a 60-line `WrapLayout`. A negative `margin-top` on an `St.Label` inside an `St.BoxLayout` produced an overflowed allocation; the caption sits in its own box with 2px spacing instead.

## Folder view (M4)

- The board and the search field live in one content actor, so a single `Shell.BlurEffect` covers both behind an open folder (the target shows the field blurred too). Search blurs only the board, since the field must stay sharp.
- Two click catchers: a transparent one between the board and the field while searching, and the dimmed backdrop above everything while a folder is open. One shared catcher would have covered the search field.
- The panel grows from the tile's on-screen rect with `EASE_OUT_QUART` over 420ms; the sketch's slight overshoot curve has no Clutter equivalent and `EASE_OUT_BACK` overshoots far more. The tile is hidden while its folder is open and comes back when the panel has shrunk into it.
- Folders taller than the screen scroll inside the panel (`St.ScrollView` with an `St.Viewport`).
- Typing inside a folder closes it and searches everything; Esc returns focus to the slot that opened the folder.

## Keyboard (M5)

- Arrow navigation scores every focusable on the current page and its neighbours (`pickNeighbor` in `layoutEngine.js`: distance along the arrow plus 2.2× the sideways offset, between centres). Items on the next page lie one monitor width to the right in the board's own coordinates, so an arrow past the last column moves to the next page with no special case.
- On the board and in folders, real Clutter key focus moves with the selection, so screen readers announce the slot's accessible name ("Text Editor, running, 2 windows"; "System, 11 apps, 6 more"). In search, focus stays in the entry and the selection is virtual (see M3).
- The selection ring shows only after a navigation key, like the sketch; moving the mouse hides it. The tooltip shows for the selected or hovered overflow preview, and for every icon when names are off.
- Generated sizes: the rule "nobody outgrows a folder ranked above them" let a small top folder (3 apps, so 2×1) cap everyone below it at 2×1 and left the bottom row empty. Replaced with per-rank caps (only the top folder may be 3×2, the rest up to 2×2), with growth handed out in rank order. A last-resort hole fill may now leave up to two empty slots in one tile, choosing the tile that wastes least.

## Edit mode (M6)

- **Pointer handling:** the layer's `captured-event` handler sees presses before the tiles' buttons. In edit mode a press on a tile starts a drag (on the round handle: resize; anywhere else: move) and a second `global.stage.grab()` on the layer routes every motion and release to it until the drop. Long-press on the board (500ms, 8px slop) calls `fake_release()` on the pressed button so it cannot fire `clicked`, enters edit mode and starts dragging the same tile, as on a phone.
- **Dashed lines:** St has no dashed borders. Each tile's outline and the empty-cell placeholders are `St.DrawingArea`s stroked with Cairo; one area covers the whole strip of pages for the placeholders and is repainted after each change.
- **Pages:** edit mode always offers one empty page after the last, so a tile can be moved onto a new page (drag to the screen edge and hold 600ms, or press Right at the last column). Empty pages disappear when edit mode ends.
- **Drops:** a move is snapped to the cell under the tile's top-left corner on the page being shown; overlapping or out-of-bounds drops spring back. Resizing applies each valid size immediately, so the content re-flows while dragging (2×1 → 1×1 preview and back), and the ghost turns red while the requested size does not fit. Every committed change saves the layout for the current grid.
- **Keyboard:** arrows move the focused tile, skipping over tiles in the way and continuing onto the neighbouring page past the side edges; Shift+arrows resize. Tab cycles tiles. Esc cancels a drag in progress, otherwise leaves edit mode; Enter leaves edit mode.
- **Menu:** a stock `PopupMenu` (so it gets the shell's own grab, keyboard navigation and accessibility), restyled with the glass tokens. The Menu key and Shift+F10 open it at the selection. Every item uses the same ornament slot so checkable and plain items line up.
- **Reset layout** has no confirmation, as in the sketch. It discards every stored grid layout.
- **First-run tip** is dismissed for good by "Got it" or by entering edit mode at all.
- **Walkthrough:** `tools/walkthrough.sh` runs the section 6 script. At the end of M6 every step passed and the only log lines were GNOME Calendar's own Adwaita deprecation warnings (Calendar is started by its search provider). Screenshots in `shots/m6-walkthrough/`.

## Theme (M7)

- **Wallpaper luminance:** read once per change of `picture-uri`, `picture-uri-dark` (by colour scheme), `picture-options` or `primary-color`, by decoding the file asynchronously at 48×30 (`Gio.File.read_async` + `GdkPixbuf.Pixbuf.new_from_stream_at_scale_async`). The mean uses the sketch's formula; XML slideshows and plain colours fall back to the primary colour. The sample is kept for the clock halo.
- **Spec change, light secondary text:** `rgba(30,30,46,.64)` measured 4.2–4.5:1 on all five test wallpapers, so it is now `.70` (4.6:1 or better). The dark tokens all pass unchanged.
- **Spec change, minimum size:** the spec asks for 13px minimum text. The sketch's 12–12.5px badge, section labels, captions, chip sources and menu shortcut, the 11.5px keycap and the 10.5px "New" label are now 13px.
- **Clock halo:** text sitting straight on a photo cannot be guaranteed 4.5:1 by a fixed colour (the forest wallpaper gave 3.4:1, the beach 1.1:1 with the dark clock against the palm trunk). The layer computes, from the wallpaper sample, the weakest halo that brings the clock to 5:1 against the brightest (or, for the dark clock, darkest) sampled pixel behind it, and draws it as a soft ellipse (St's radial gradient is circular, so the actor is stretched). On the five test wallpapers it is 0 for three and 0.18–0.22 for the other two.
- **Check:** `tools/contrast.py` reproduces the scrim and halo and composites every text style over the 99th-percentile brightest (dark style) or 1st-percentile darkest (light style) backdrop in the board band. Results for the four sketch wallpapers and the author's current Bing wallpaper are in `shots/m7-contrast.txt`: every row passes.
- **12-hour clock:** the time drops the leading zero and shows AM/PM as a smaller label beside it.
- **Weather** is not included in v1 (possible follow-up: the shell's own `misc/weather.js` client).

## Preferences (M8)

- `Adw.SwitchRow`s bound to the settings; the custom accent is a switch plus a `Gtk.ColorDialogButton` (switching it on stores the button's colour, off stores an empty string so the system accent applies again). The author's mauve `#cba6f7` is the button's starting colour.
- Reset layout in the preferences asks for confirmation with an `Adw.AlertDialog`, unlike the menu item, because the preferences window is easy to reach by accident and slow to undo. The board listens for `layouts` changes it did not make itself and regenerates.
- Checked by opening the window inside the nested shell (`shots/m8-prefs.png`).

## Motion (M9)

- Open: each tile on the visible page fades in over 450ms and scales from 0.88 / 26px down with `EASE_OUT_BACK` over 550ms, delayed 38ms × (x + 1.4·y). The field drops 14px with the same curve. Close: the reverse wave, delay (420 − d) × 0.35ms, 200ms fade and 260ms sink to 0.92; the whole close takes about 400ms, and the modal is released at the end of it (as the overview does) so a click during the close cannot reach a window.
- Launch: the clicked icon swells to 1.45 and fades over 340ms, the app is activated at the start of that (so it launches in parallel), and the layer closes when the icon finishes. Focus changes are ignored during the launch so the app's window taking focus does not cut the animation short.
- `enable-animations` off: the shell's `ease()` already zeroes durations and delays; the edit-mode wiggle (an endless transition) is not started at all.
- **Measured** in the nested shell at 1920×1200 with two app windows dimmed: open p50 16.7ms, p95 17.9ms per frame, one 33ms frame at the start; the close wave has no frame over 20ms. `open()` runs in 6–9ms after the first open (37ms the first time) and the first frame is painted 9–16ms after the call. This is AMD integrated graphics through the headless backend, not the Intel iGPU the spec names, and not the live session (which needs the author's permission).

## Frosted glass (v2, behind the preference)

- No live blur at all. The wallpaper sample (now decoded once at 192px wide, centre-cropped to the monitor's shape the way "zoom" shows it, then shrunk to 96px wide) is box-blurred three times in JS when the wallpaper changes, uploaded as a 96×60 `St.ImageContent` and stretched over the monitor with linear filtering. At that scale the result looks like a large-radius blur.
- One `Shell.GLSLEffect` masks that layer to the union of the tiles' rounded rectangles (up to 48 rects and per-tile opacities as uniform arrays, signed-distance rounded rects in the shader). The rects come from the tiles' transformed extents on `before-update`, so they follow the open wave, page scrolls and drags, and nothing runs when no frame is being drawn. The opened folder's tile is transparent, so its frost disappears with it.
- Edit mode fades the frost out: tiles rotate while wiggling and the mask does not.
- Cost: open wave p50 16.7ms with it on, the same as off. The spec suggested `Shell.BlurEffect` on a background clone; the down-sampled image gives the same look without an offscreen blur pass.
- The single wallpaper sample now feeds the scrim, the clock halo and the frost. `tools/contrast.py` still models the halo from its own 48×30 sample; the extension's 96-wide sample sees slightly more extreme pixels, so its halo can only be stronger.

## Hardening (M10)

- **Multi-monitor:** the layer covers the primary monitor only (where Super+A and the panels' buttons are); windows on other monitors are left alone. A press anywhere outside that monitor closes the layer, since the modal grab would otherwise swallow it. On a monitor change the layer closes, re-measures and re-samples the wallpaper for the new shape. Checked with two virtual monitors (`shots/m10-two-monitors.png`).
- **Lock:** the extension does not run in the unlock-dialog session mode, so locking disables it; disabling while open restores the windows and pops the grab. Checked by locking with the layer open (windows back to full opacity and scale, layer gone, no errors) and unlocking (re-enabled, opens normally).
- **Notifications:** `MessageTray` overrides `contains()` for notification sources, so the check that a notification banner took focus (Super+N) uses `Clutter.Actor.prototype.contains`. The layer closes and the banner keeps focus.
- **Focus loss:** when the focused item is destroyed (its app was removed), key focus fell to the stage and the layer stopped receiving keys. The layer now takes focus back whenever it drops to nothing while open.
- **Apps installed or removed while open:** the tile list updates in place (about 5s after the file appears, which is the app system's own delay); a new "Unsorted" tile appears and disappears without rebuilding the other tiles.
- **Default folders and categories:** a category group named like an existing folder (GNOME's default "System") is merged into it instead of showing two "System" tiles.
- **Scale:** with 230 extra apps the model reload takes about 7ms, `open()` 5ms after the first open, the open wave stays at a 16.7ms median, and the 230-app folder opens in about 60ms and scrolls. The folder's pop-in stagger is capped at 24 items so the last icons don't arrive seconds late. A user with only GNOME's default folders and 230 apps gets 11 groups on one page with no holes (`shots/m10-no-folders-230.png`).
- **Other extensions:** Dash to Panel and Blur my Shell were each disabled and re-enabled with Home Screen active, and the entry-point checks passed after each step (20 of 20 with Dash to Panel, 10 of 10 stock, 20 of 20 Ubuntu Dock). Two log lines from other code were each seen once and could not be reproduced: a `GLib-CRITICAL: Source ID … was not found` (it also appeared in M1, before Home Screen had any timeouts, so it is not ours) and a `TypeError … firstIcon.icon is null` in the hidden stock dash's `_adjustIconSize` (`ui/dash.js:602`) while Dash to Panel replaces it.
- **Test rig:** the nested session's Tracker indexer (started by the Files search provider) began reading the real home folder; its index lives in the nested cache, but `tools/nest.sh` now sets its indexed directories to none.
