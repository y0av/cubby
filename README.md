# Cubby

A home screen for GNOME Shell. Cubby replaces the Show Apps grid with your app folders, laid out as tiles you move and resize yourself, like on a phone. The overview, window picker and workspaces are left alone.

![Opening Cubby, reordering apps in a folder, moving and resizing tiles, then searching for Calculator](docs/demo.gif)

| | |
|---|---|
| ![Dark style](docs/dark.jpg) | ![Light style](docs/light.jpg) |

Tiles are your existing GNOME app folders, with the apps you use most up front. Type anywhere to search apps, settings and files.

## Install

Needs GNOME Shell 50. Works with the stock dash, Ubuntu Dock and Dash to Panel.

```sh
curl -LO https://github.com/y0av/cubby/releases/latest/download/cubby@y0av.github.io.shell-extension.zip
gnome-extensions install --force cubby@y0av.github.io.shell-extension.zip
# log out and back in, then:
gnome-extensions enable cubby@y0av.github.io
```

## Development

```sh
tools/build.sh                  # build the zip into dist/
gjs -m tests/test-layout.js     # unit tests
tools/nest.sh start 1920x1200   # nested headless shell, separate from your session
```

`DECISIONS.md` covers how Cubby hooks into the shell and which private APIs it depends on.

## License

GPL-2.0-or-later
