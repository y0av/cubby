# Cubby

A home screen for GNOME Shell. Cubby replaces the Show Apps grid with your app folders, laid out as tiles you move and resize yourself, like on a phone. The overview, window picker and workspaces are left alone.

![Opening Cubby, reordering apps in a folder, moving and resizing tiles, then searching for Calculator](docs/demo.gif)

| | |
|---|---|
| ![Dark style](docs/dark.jpg) | ![Light style](docs/light.jpg) |

Tiles come from your existing GNOME app folders. Apps outside any folder go to an "Unsorted" tile, and if you have no folders, apps are grouped by category. Each tile shows its most used apps as big icons and the rest as a small preview; click the preview to open the folder. Type anywhere to search apps, settings and files.

Super+A or any Show Apps button opens it. Arrows and Tab move around, Enter opens, Esc steps back. To rearrange tiles, press Ctrl+E (or right-click → Edit layout, or long-press a tile), then drag a tile to move it or drag its corner handle to resize. Each screen size keeps its own layout.

## Install

Needs GNOME Shell 50. Works with the stock dash, Ubuntu Dock and Dash to Panel.

```sh
curl -LO https://github.com/y0av/cubby/releases/latest/download/cubby@y0av.github.io.shell-extension.zip
gnome-extensions install --force cubby@y0av.github.io.shell-extension.zip
# log out and back in, then:
gnome-extensions enable cubby@y0av.github.io
```

Settings are under right-click → Preferences: app names, clock, frosted glass, accent colour, and a switch back to the stock grid. Cubby reads your app folders and usage from GNOME's settings but never writes to them.

## Development

```sh
tools/build.sh                  # build the zip into dist/
gjs -m tests/test-layout.js     # unit tests
tools/nest.sh start 1920x1200   # nested headless shell, separate from your session
```

`DECISIONS.md` covers how Cubby hooks into the shell and which private APIs it depends on.

## License

GPL-2.0-or-later
