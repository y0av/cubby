# Design notes

How Cubby hooks into GNOME Shell and why things are done the way they are. Shell file references are to the GNOME Shell 50.1 sources (`gresource extract` on `/usr/lib/gnome-shell/libshell-18.so`, paths under `/org/gnome/shell/`); line numbers are from Ubuntu's 50.1-0ubuntu1.3 build. Dash to Panel v74 and Ubuntu Dock were read, not modified, to see how their Show Apps buttons reach the shell.

## Entry points

Cubby owns "show the app grid". Every route into the stock grid ends in one of four places, and each is intercepted once.

| Route | Where it lands | Hook |
|---|---|---|
| Super+A | `ui/overviewControls.js:515-520` registers `toggle-application-view` with `this._toggleAppsPage.bind(this)`. The bound function cannot be patched, so the binding is replaced. | `Main.wm.removeKeybinding('toggle-application-view')`, then `Main.wm.addKeybinding` with our handler and the same flags (`IGNORE_AUTOREPEAT`) and modes (`NORMAL \| OVERVIEW`). On disable: remove ours, re-add the original bound to the live `ControlsManager._toggleAppsPage`. |
| `Main.overview.showApps()` and anything calling `Main.overview.show(APP_GRID)` | `ui/overview.js:609` `showApps()` calls `this.show(ControlsState.APP_GRID)`; `show()` is at `ui/overview.js:486`. | Override `Overview.prototype.show` (`InjectionManager` on the prototype of `Main.overview`): `APP_GRID` becomes a toggle request; other states pass through. |
| Stock dash Show Apps button (inside the overview) | `ui/dash.js:350-356` exposes `showAppsButton`; `ui/overviewControls.js:417-418` connects `notify::checked` to an arrow function calling `this._onShowAppsButtonToggled()` (`:684`). | Override `ControlsManager.prototype._onShowAppsButtonToggled`. Keep the `_ignoreShowAppsButtonToggle` early return. When the overview is visible and the button becomes checked, hide the overview and open Cubby. When the overview is not visible, do nothing (Dash to Panel flips this button on its way to `show(APP_GRID)`). |
| Dash to Panel Show Apps button | `taskbar.js:1457-1520`: when its own button turns on it sets the shell's `showAppsButton.checked = true` then calls `Main.overview.show(2)`. When it turns off it calls `Main.overview.hide()`. `taskbar.js:378-384` mirrors the shell button back into its own. | Opening is covered by the `show` override. Closing needs a `hide()` override: while Cubby is open, `Main.overview.hide()` closes it. |
| Ubuntu Dock Show Apps button | `docking.js:2225-2226` swaps `overviewControls.dash` and `searchController._showAppsButton` for the dock's. `docking.js:2531-2554`: any toggle while the overview is hidden calls `Main.overview.show(APP_GRID)`; while visible it calls `overviewControls._onShowAppsButtonToggled()` directly. | Covered by the `show` and `_onShowAppsButtonToggled` overrides. |

**Toggle semantics.** Every request toggles on Cubby's own state, never on a button's `checked` state. Cubby mirrors its open state into `Main.overview.dash.showAppsButton.checked` (the dock's button when Ubuntu Dock is on), so Dash to Panel and Ubuntu Dock show their button as active. That write happens under a guard flag, because Ubuntu Dock answers every toggle of its button with `show(APP_GRID)`; requests that arrive while the guard is set are ignored.

**Other overrides.** `Overview.prototype.toggle` closes Cubby when it is open (the Activities button, the hot corner and the Super key all call `toggle()`; from the stock app grid, Super also returns to the desktop). The overview's `showing` signal closes Cubby in case anything else opens the overview.

**Fallback.** The `use-stock-grid` preference turns every override into a pass-through without disabling the extension, so switching back is instant.

## The layer

- **Placement:** one `St.Widget` in `Main.layoutManager.uiGroup`, directly above `global.window_group`. `ui/layout.js:230-257` puts `window_group` first in `uiGroup`, and `addChrome()` (`ui/layout.js:882-891`) inserts chrome (the panel, Dash to Panel, Ubuntu Dock, the overview group, the screen shield) above it. So the layer sits over windows and under every panel, dock, notification and modal dialog without having to know about them.
- **Modal:** `Main.pushModal(global.stage, {actionMode: Shell.ActionMode.OVERVIEW})`, the call the overview makes (`ui/overview.js:451-480`). Grabbing the stage rather than the layer keeps the panel and docks clickable. `OVERVIEW` mode matches the stock app grid: Super, Alt+Tab, Super+A and the run dialog still work (`ui/main.js:127`, `ui/windowManager.js:1589-1602`). The grab is released at the end of the close animation, as the overview does, so a click during the close cannot reach a window.
- **Closing:** on screen lock (`Main.sessionMode` `updated` and `Main.screenShield` `locked-changed`), monitor change, workspace switch, the overview showing, a window taking focus, a notification banner taking keyboard focus, and a press on another monitor.
- **Windows:** each window actor on the primary monitor is eased to opacity 0 and scale 0.965 about the point (50%, 40%) of the monitor, using a per-actor pivot so the result matches scaling the whole group. The wallpaper lives inside `window_group` (`ui/layout.js:322-324`), so scaling the group itself would shrink it too. The previous opacity, scale and pivot are stored and restored on close and on disable.
- **Monitors:** the layer covers the primary monitor only, where Super+A and the panels' buttons are; windows on other monitors are left alone.

### Private shell API

These are the places a shell update can break Cubby:

- `Overview.prototype.show`, `hide` and `toggle`, and `ControlsManager.prototype._onShowAppsButtonToggled`, overridden through `InjectionManager`.
- The `toggle-application-view` keybinding, re-registered with the shell's own setting (the setting itself is never written).
- `Main.overview.searchController._searchResults._providers`, the overview's live list of search providers.
- `ui/appMenu.js`'s `AppMenu`, the stock grid's right-click menu.

## Apps and folders

- **Folders** are read the way the stock grid reads them: `ui/appDisplay.js:96-105` (`_getFolderName`, honouring `translate` via `Shell.util_get_translated_folder_name`), `:79-84` (`_getCategories`), `:1490-1560` (top-level `_loadApps`: favourites and parental controls filtered out) and `:2149-2190` (`FolderView._loadApps`: `apps` plus apps matching `categories`, minus `excluded-apps` and favourites). Empty folders are skipped. `org.gnome.desktop.app-folders` is only ever read.
- **Unsorted or categories:** apps in no folder go to an "Unsorted" tile, but a stock install has GNOME's default folders (System, Utilities), which would leave everything else in one huge tile. So a user counts as having organised their apps only with at least one folder other than the shell's `DEFAULT_FOLDERS`. Otherwise the default folders stay and the remaining apps are grouped by freedesktop main category, named from the system `.directory` files. The assignment is stored in Cubby's `virtual-groups` setting so groups stay stable. A category named like an existing folder (GNOME's default "System") joins that folder instead of showing twice.
- **Order inside a folder:** most used first (`Shell.AppUsage.compare`). `Shell.AppUsage` has no change signal, so folders are re-sorted on each open and only tiles whose order changed are rebuilt. Dragging an app in an open folder (or Alt+arrows) stores the user's own order in `folder-orders`; apps not in it follow, most used first. "Sort by use" removes it. The tile shows the same order, so dragging an app to the front makes it a big icon.
- **"New" marker:** `known-apps` is filled on first run (so nothing is new) and rewritten when Cubby closes, so an app is marked during the first open after it appears. Big icons get a small "New" label, mini icons a dot.

## Layout

- **Grid size:** the unit scales with the work area, `s = clamp(min(w / 1920, h / 1152), 0.66, 1.3)`, where 1920×1152 is a 1920×1200 monitor minus a 48px panel. Roomy margins are tried first (the field 152·s below the top of the work area, or 84·s with the clock; 116·s free at the bottom). Only if that gives fewer than 3 rows are tighter margins tried, then a smaller unit. Columns are whatever fits with a 64·s side margin, capped at 12 so an ultrawide does not turn into a strip. The upper limit of 1.3 keeps 2560×1440 at the reference proportions instead of leaving 380px empty under the board.
- **Resulting grids** without the clock: 1366×768 10×3 at U=103; 1920×1080 with Ubuntu Dock 10×3 at U=142; 1920×1200 9×3 at U=156; 2560×1440 10×3 at U=191; 3840×2160 at 200% 10×3 at U=142; 3440×1440 12×3 at U=191.
- **Generated layout:** folders are ranked by usage (the sum, over their apps, of each app's rank in `Shell.AppUsage.get_most_used()`). The top folder gets 3×2, the next 2×2, the middle ones 2 cells and the rest 1×1, with two rules on top. A tile never gets more slots than its folder has apps, so a 3-app folder ranked first is 2×1, not a half-empty 3×2. Spare cells are then handed back in rank order; only the top folder may be 3×2, the rest up to 2×2. An earlier rule ("nobody outgrows a folder ranked above them") let a small top folder cap everyone at 2×1 and left the bottom row empty.
- **No holes:** a hole is an empty cell with a tile to its right on the same row, or with a tile starting on a later row. First-fit packing fills most; the rest are closed by growing a neighbour that has the apps for it, then by moving the last tile into the hole, and as a last resort by growing the tile that wastes the fewest slots.
- **Storage:** `layouts` keeps one layout per grid size (`"9x3"`, `"12x4"`...), so a laptop screen and an external monitor each remember their own arrangement. A grid never seen is reflowed (reading order kept, sizes clamped, first-fit) from the most recently edited layout. If the user never edited anything, a new grid gets a freshly generated layout instead: a generated layout carries no preference worth keeping, and reflowing it can spill onto a second page.
- **Scale factor:** in Mutter 50 `scale-monitor-framebuffer` is no longer an experimental feature (Mutter logs it as unknown) and logical layout is always on, so St's scale factor is 1 and stage coordinates are logical pixels. The pixel metrics are still multiplied by the St scale factor in case that changes.

## Search

- **Apps** are ranked like `AppSearchProvider.getInitialResultSet` (`ui/appDisplay.js:1799-1829`): `Shell.AppSystem.search(query)` groups in order, each group sorted by `Shell.AppUsage.compare`, filtered by parental controls. Up to 10.
- **Providers:** the overview's `SearchResultsView` keeps `_providers` (`ui/search.js:623-668`), rebuilt from `RemoteSearch.loadRemoteSearchProviders(settings)`, which applies `disabled`, `enabled`, `disable-external` and `sort-order` (`ui/remoteSearch.js:143-170`); extensions add more through `searchController.addProvider()` (`ui/searchController.js:336`). Cubby reuses that live list instead of loading a second set, so settings, sort order and other extensions' providers apply with no extra code. The built-in `applications` provider is skipped (apps are ranked as above), but its system actions (Power Off, Lock...) are shown as chips. Up to 3 results per provider and 8 in total. Remote providers start 150ms after the last keystroke, the overview's delay; a query that extends the previous one uses `getSubsearchResultSet`.
- **Keys:** the layer handles keys in its `captured-event` handler, so arrows, Tab, Enter and Esc behave the same whichever widget has focus. The first printable key on the board focuses the entry and re-delivers the event to it (`text.event(event, false)`, as `SearchController.startSearch` does), so input methods and dead keys go through the real `ClutterText`. Keys pass straight through while the entry has a pre-edit string.
- **Selection is virtual:** key focus stays in the entry so typing never stops; arrows and Tab move a selection over the results and Enter activates it. The first app is selected after every keystroke unless the user has moved the selection to a result that is still there. The field says what Enter will do ("Switch to Telegram").
- **No results:** Enter runs GNOME Software's `LaunchSearch` through its search provider when it is installed. Ubuntu's App Center is not a search provider and has no documented search argument, so without GNOME Software the message says Enter opens App Center.
- **No churn:** result widgets are kept by id across keystrokes; ones that stay slide to their new place and only new ones animate in. Each provider's last answer stays until it answers the new query, so provider results do not vanish and return 150ms later on every key. The panel eases to its new height.

## Folder view

- The board and the search field share one content actor, so a single `Shell.BlurEffect` covers both behind an open folder. Search blurs only the board, since the field must stay sharp.
- Two click catchers: a transparent one between the board and the field while searching, and the dimmed backdrop above everything while a folder is open. One shared catcher would have covered the search field.
- Folders taller than the screen scroll inside the panel (`St.ScrollView` with an `St.Viewport`). Each folder's grid of apps is built once and reused until the folder's apps or names change, so reopening takes about 9ms instead of 39ms.
- Typing inside a folder closes it and searches everything. Esc returns focus to the preview that opened the folder.
- Only a click on bare background steps back or closes. A click that lands on the folder panel, the search results, a tile's glass or the field without hitting a button does nothing.

## Keyboard

- Arrow navigation scores every focusable on the current page and its neighbours (`pickNeighbor` in `layoutEngine.js`: distance along the arrow plus 2.2× the sideways offset, between centres). Items on the next page lie one monitor width to the right in the board's coordinates, so an arrow past the last column moves to the next page with no special case.
- On the board and in folders, real key focus moves with the selection, so screen readers announce the slot's accessible name ("Text Editor, running, 2 windows"; "System, 11 apps, 6 more"). In search, focus stays in the entry.
- The selection ring shows only after a navigation key; moving the mouse hides it. The tooltip shows for the selected or hovered overflow preview, and for every icon when names are off.
- Esc steps back one level: menu, drag, edit mode, folder, search, then closes.

## Edit mode

- **Pointer:** the layer's `captured-event` handler sees presses before the tiles' buttons. In edit mode a press on a tile starts a drag (on the round handle: resize; anywhere else: move), and a second `global.stage.grab()` routes every motion and release to the layer until the drop. A long press on the board (500ms, 8px slop) calls `fake_release()` on the pressed button so it cannot fire `clicked`, enters edit mode and starts dragging the same tile, as on a phone.
- **Pages:** edit mode always offers one empty page after the last, so a tile can be moved onto a new page (drag to the screen edge and hold for 600ms, or press Right at the last column). Empty pages disappear when edit mode ends.
- **Drops:** a move snaps to the cell under the tile's top-left corner on the page being shown; overlapping or out-of-bounds drops spring back. Resizing applies each valid size immediately, so the content re-flows while dragging, and the ghost turns red while the requested size does not fit. Every committed change saves the layout for the current grid.
- **Keyboard:** arrows move the focused tile, skipping over tiles in the way and continuing onto the neighbouring page past the side edges; Shift+arrows resize. Tab cycles tiles. Enter or Esc leaves edit mode; Esc during a drag cancels it.
- **Menu:** a stock `PopupMenu`, so it gets the shell's grab, keyboard navigation and accessibility, restyled with the glass colours. The Menu key and Shift+F10 open it at the selection. Every item uses the same ornament slot so checkable and plain items line up.
- **Reset layout** from the menu has no confirmation. In the preferences it asks first with an `Adw.AlertDialog`, because the window is easy to reach by accident and the reset is slow to undo there; the board listens for `layouts` changes it did not make itself and regenerates.
- **First-run tip** is dismissed for good by "Got it" or by entering edit mode at all.

## App menu

Right-clicking an app anywhere (tile, folder, search result), or the Menu key on a selected one, opens GNOME's own `AppMenu` from `ui/appMenu.js`: open windows, New Window, the app's desktop actions, the GPU option, Pin/Unpin, App Details and Quit. Its actions call `Main.overview.hide()`, which the `hide()` override turns into closing Cubby. Right-clicking anywhere else on the board opens the layout menu.

There is no Uninstall item: GNOME 50's own menu does not have one either, and App Details opens the app's page in GNOME Software or App Center, where it can be removed. Removing snaps, Flatpaks or packages from inside the shell is too risky for a launcher.

A menu is kept until the next one opens rather than destroyed on close, because App Details finishes asynchronously after the menu has closed (`AppMenu.destroy()` clears its app). If the app's item is destroyed under an open menu (a tile rebuilt), the menu closes, as the stock `AppIcon` does.

## Look

- **Accent:** GNOME Shell 50's St supports `-st-accent-color`, `st-mix()` and `st-transparentize()`, but the accent is applied from JS because the preference allows a custom colour that St's accent cannot express. Light and dark glass are two class variants on the layer root.
- **Wallpaper:** read once per change of `picture-uri`, `picture-uri-dark` (by colour scheme), `picture-options` or `primary-color`, decoded asynchronously (`Gio.File.read_async` and `GdkPixbuf.Pixbuf.new_from_stream_at_scale_async`) at 192px wide, centre-cropped to the monitor's shape the way "zoom" shows it, and shrunk to 96px wide. XML slideshows and plain colours fall back to the primary colour. The one sample feeds the scrim, the clock halo and the frosted glass.
- **Scrim:** strongest at the top, light in the middle, a little stronger at the bottom; its strength grows with the wallpaper's mean luminance.
- **Contrast:** light-style secondary text at `rgba(30,30,46,.64)` measured 4.2–4.5:1 on the five test wallpapers, so it is `.70` (4.6:1 or better). No text is smaller than 13px. `tools/contrast.py` reproduces the scrim and composites every text style over the 99th-percentile brightest (dark style) or 1st-percentile darkest (light style) pixel in the band where tiles sit; every style passes 4.5:1 on all five.
- **Clock halo:** text straight on a photo cannot be guaranteed 4.5:1 by a fixed colour (a forest wallpaper gave 3.4:1, a beach 1.1:1 with the dark clock against a palm trunk). The layer works out, from the wallpaper sample, the weakest halo that brings the clock to 5:1 against the brightest (or, for the dark clock, darkest) pixel behind it. On the five test wallpapers it is 0 for three and 0.18–0.22 for the other two. `tools/contrast.py` models the halo from a smaller sample than the extension, so the real halo can only be stronger.
- **12-hour clock:** the time drops the leading zero and shows AM/PM as a smaller label beside it.

## Motion

- **Open:** the scrim fades in over 400ms and windows dim over 350ms. Tiles on the visible page fade in over 320ms and rise from 0.88 scale and 26px lower with `EASE_OUT_BACK` over 480ms, each delayed by its position (x + 1.4·y, scaled so the wave spreads over 220ms whatever the grid size; a fixed per-cell delay made a 12-column screen take a second to fill). The field drops 14px with the same curve.
- **Close:** the reverse wave over 110ms, a 180ms fade and a 220ms sink to 0.92 scale, about 330ms in all.
- **Launch:** Cubby starts closing at once. The clicked icon swells to 1.4× and fades while the whole layer grows 6% towards it and fades, over 280ms, as if going into the app. The app is activated after the close starts: activating a running app moves the focus, which would otherwise close the layer without the animation.
- **Folders:** the panel grows from the tile's on-screen rect with `EASE_OUT_QUART` over 400ms, fading in over its first 160ms while the tile fades out under it, so it never shows as an empty box. Closing shrinks it back over 320ms and crossfades it with the tile from 90ms on, when the shrink is nearly done. The apps pop in with an 18ms stagger, capped at 24 items so large folders don't arrive seconds late.
- **Search:** results fade and slide in over 300ms and fade out over 140ms on Esc; the board fades to 14% and blurs.
- **Details:** icons shrink to 0.95 while pressed. Hover and keyboard selection crossfade over 120ms (St's `transition-duration`). In edit mode the outlines and placeholders fade in and out, the wiggle settles instead of snapping, and a resized tile's new arrangement fades in while its frame moves. The first-run tip waits 600ms after opening so it does not compete with the wave.
- **Opacity never overshoots:** opacity is an 8-bit value, and easing it with an overshooting curve like `EASE_OUT_BACK` wraps it past 255, so icons blinked out and back while popping in. Opacity always has its own transition with a non-overshooting curve; only scale and translation overshoot.
- **Reduced motion:** with `enable-animations` off the shell's `ease()` zeroes durations and delays; the edit-mode wiggle (an endless transition) is not started at all.
- **Measured** in the nested shell at 1920×1200 on AMD integrated graphics: the open wave, close, launch and folder open all run at a 16.7ms median frame with no frame over 20ms, except one 33ms frame at the start of opening. `open()` takes about 6ms.

## Frosted glass

Off by default. There is no live blur: the wallpaper sample is box-blurred three times in JS when the wallpaper changes, uploaded as a 96-pixel-wide `St.ImageContent` and stretched over the monitor with linear filtering; at that scale it looks like a large-radius blur. One `Shell.GLSLEffect` masks it to the union of the tiles' rounded rectangles (up to 48 rects with per-tile opacity, as uniform arrays, signed-distance rounded rects in the shader). The rects come from the tiles' transformed extents on `before-update`, so they follow the open wave, page scrolls and drags, and nothing runs when no frame is drawn. The opened folder's tile is transparent, so its frost disappears with it. Edit mode fades the frost out, because tiles rotate while wiggling and the mask does not. The open wave runs at the same 16.7ms median with it on.

## Robustness

- **Lock:** the extension does not run in the unlock-dialog session mode, so locking disables it; disabling while open restores the windows and pops the grab.
- **Notifications:** `MessageTray` overrides `contains()` for notification sources, so the check that a banner took focus (Super+N) uses `Clutter.Actor.prototype.contains`. Cubby closes and the banner keeps focus.
- **Focus loss:** when the focused item is destroyed (its app was removed), key focus would fall to the stage and the layer would stop receiving keys. The layer takes focus back whenever it drops to nothing while open.
- **Apps installed or removed while open:** the tiles update in place, about 5s after the file appears (the app system's own delay).
- **Many apps:** with 230 extra apps the model reloads in about 7ms, `open()` still takes about 5ms, the open wave stays at a 16.7ms median, and the 230-app folder opens in about 60ms and scrolls. A user with only GNOME's default folders and 230 apps gets 11 groups on one page with no holes.

## St and Clutter quirks

- `Clutter.BinLayout` honours a child's `x_align`/`y_align` only when the child also has `x_expand`/`y_expand`.
- `Clutter.FlowLayout` allocates its children with zero height in Mutter 50, so the result chips use a small `WrapLayout`.
- A negative `margin-top` on an `St.Label` inside an `St.BoxLayout` produces an overflowed allocation.
- The child of an `St.ScrollView` must be an `St.Viewport`.
- St has no dashed borders; the edit-mode outlines and placeholders are `St.DrawingArea`s stroked with Cairo.
- St's radial gradient is circular; the clock halo is a circle stretched into an ellipse.

## Testing

- `tools/nest.sh` runs `dbus-run-session -- gnome-shell --headless --wayland --no-x11 --virtual-monitor WxH` with its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`. Without that, the nested shell's dconf writes would land in `~/.config/dconf/user` and the running session would pick them up. Your folders, favourites, usage history and fonts are copied or linked in read-only, and the nested Tracker indexes nothing. `--devkit` would need the `mutter-devkit` viewer, which Ubuntu does not install.
- `tools/testkit@cubby.local` is a development-only extension, never packed, that turns on `global.context.unsafe_mode` in the nested shell so `org.gnome.Shell.Eval` and `org.gnome.Shell.Screenshot` work, and exposes synthetic input and a frame recorder (`cubbyTest.record`) that copies every painted frame and writes them out afterwards, since a D-Bus screenshot takes about 500ms.
- `tools/test-entry.sh` checks every entry point with the stock dash, Dash to Panel and Ubuntu Dock; `tools/test-enable-cycle.sh` enables and disables 20 times and checks that the overridden methods, the stage children and the modal count are exactly as before; `tools/test-edit.sh` drives edit mode; `tools/walkthrough.sh` runs an end-to-end session. `tests/test-layout.js` covers the pure layout logic.
- `tools/lint.sh` runs shexli, the extensions.gnome.org review linter, on the packed zip. shexli 0.2.1 crashes with tree-sitter 0.26, so the script pins 0.25.2. `eslint.config.js` holds the code style, close to GNOME Shell's.
- **Log lines from other code**, seen only with Dash to Panel: a `TypeError … firstIcon.icon is null` in the hidden stock dash's `_adjustIconSize` (`ui/dash.js:602`), followed later by one `GLib-CRITICAL: Source ID … was not found`. The dash's redisplay runs from the shell's 20-second deferred-work timer (`ui/main.js:1076-1080`); the TypeError aborts that callback before it clears `_deferredTimeoutId`, and the next deferred work run on map removes the stale id (`ui/main.js:988`). Traced by wrapping `GLib.source_remove` in the nested shell. The TypeError also happens with Cubby disabled, when the overview is used during the first 20 seconds of a session under Dash to Panel.
