#!/usr/bin/env bash
# Drive an isolated, headless GNOME Shell for testing the extension.
#
# Isolation: the nested shell gets its own XDG config/data/cache/state/runtime
# dirs, so its dconf database, enabled extensions and sockets never touch the
# live session. The user's folders, favourites, usage history and fonts are
# copied or linked in read-only.
#
#   tools/nest.sh start [WxH] [--dock] [--dtp] [--blur] [--wall FILE] [--light] [--accent NAME]
#   tools/nest.sh stop
#   tools/nest.sh eval 'js'          run JS in the nested shell, print result
#   tools/nest.sh shot FILE          full-screen PNG
#   tools/nest.sh scale N            set the monitor scale (1, 2, ...)
#   tools/nest.sh gset ARGS...       gsettings against the nested dconf
#   tools/nest.sh log                print the nested shell's output
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NEST=${HOMESCREEN_NEST:-${XDG_CACHE_HOME:-$HOME/.cache}/homescreen-nest}
UUID=$(python3 -c "import json;print(json.load(open('$ROOT/src/metadata.json'))['uuid'])")
LIVE_EXT=$HOME/.local/share/gnome-shell/extensions

nest_env() {
    export XDG_CONFIG_HOME=$NEST/config XDG_DATA_HOME=$NEST/data XDG_CACHE_HOME=$NEST/cache
    export XDG_STATE_HOME=$NEST/state XDG_RUNTIME_DIR=$NEST/run
    export XDG_DATA_DIRS="$HOME/.local/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
    unset WAYLAND_DISPLAY DISPLAY GNOME_SETUP_DISPLAY
}

bus() { cat "$NEST/bus"; }
on_bus() { DBUS_SESSION_BUS_ADDRESS=$(bus) "$@"; }

do_eval() {
    local out
    out=$(on_bus gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1")
    echo "$out"
    [[ $out == "(true,"* ]]
}

stop() {
    # the nested session is its own process session (setsid); end all of it
    local sid=""
    [[ -f $NEST/sid ]] && sid=$(cat "$NEST/sid")
    if [[ -n $sid ]] && pgrep -s "$sid" >/dev/null; then
        pkill -TERM -s "$sid" || true
        for _ in $(seq 50); do pgrep -s "$sid" >/dev/null || break; sleep 0.1; done
        pkill -KILL -s "$sid" || true
        sleep 0.2
    fi
    if [[ -d $NEST ]]; then
        local m
        for m in $(awk -v d="$NEST/" 'index($2, d) == 1 {print $2}' /proc/mounts); do
            fusermount3 -uz "$m" 2>/dev/null || fusermount -uz "$m" 2>/dev/null || true
        done
    fi
    rm -f "$NEST/pid" "$NEST/sid" "$NEST/bus"
}

pack() {
    "$ROOT/tools/build.sh" >/dev/null
}

start() {
    local size=1920x1200 extra=() wall="" light="" accent=purple
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dock) extra+=(ubuntu-dock@ubuntu.com);;
            --dtp) extra+=(dash-to-panel@jderose9.github.com);;
            --blur) extra+=(blur-my-shell@aunetx);;
            --wall) wall=$2; shift;;
            --light) light=1;;
            --accent) accent=$2; shift;;
            *x*) size=$1;;
            *) echo "unknown arg $1" >&2; exit 2;;
        esac
        shift
    done
    stop
    rm -rf "$NEST"
    mkdir -p "$NEST"/{config,data/gnome-shell/extensions,data/applications,cache,state,run}
    chmod 700 "$NEST/run"
    ln -s "$HOME/.local/share/fonts" "$NEST/data/fonts"
    cp "$HOME/.local/share/gnome-shell/application_state" "$NEST/data/gnome-shell/" 2>/dev/null || true
    cp -r "$ROOT/tools/testkit@homescreen.local" "$NEST/data/gnome-shell/extensions/"
    pack
    mkdir -p "$NEST/data/gnome-shell/extensions/$UUID"
    (cd "$NEST/data/gnome-shell/extensions/$UUID" && unzip -qo "$ROOT/dist/$UUID.shell-extension.zip" && glib-compile-schemas schemas)
    for e in "${extra[@]}"; do
        # copies, so the user's installed extensions are never touched
        [[ -d $LIVE_EXT/$e ]] && cp -r "$LIVE_EXT/$e" "$NEST/data/gnome-shell/extensions/"
    done
    # snapshot of the user's folders and favourites (read only on the live side)
    dconf dump /org/gnome/desktop/app-folders/ > "$NEST/app-folders.ini"
    # the user's own settings for the extensions under test (read only)
    : > "$NEST/ext-settings.sh"
    for e in "${extra[@]}"; do
        case $e in
            dash-to-panel@*) d=/org/gnome/shell/extensions/dash-to-panel/;;
            blur-my-shell@*) d=/org/gnome/shell/extensions/blur-my-shell/;;
            *) continue;;
        esac
        dconf dump "$d" > "$NEST/$e.ini"
        # the virtual monitor has no id in panel-positions; use the fallback
        [[ $e == dash-to-panel@* ]] && sed -i "/^\[\/\]$/a panel-position='TOP'" "$NEST/$e.ini"
        echo "dconf load $d < '$NEST/$e.ini'" >> "$NEST/ext-settings.sh"
    done
    local favs; favs=$(gsettings get org.gnome.shell favorite-apps)
    local enabled="['testkit@homescreen.local', '$UUID'"
    for e in "${extra[@]}"; do enabled+=", '$e'"; done
    enabled+="]"
    [[ -z $wall ]] && wall=$(gsettings get org.gnome.desktop.background picture-uri-dark | tr -d "'")
    [[ $wall != file://* ]] && wall="file://$(realpath "$wall")"
    local scheme=prefer-dark; [[ -n $light ]] && scheme=default

    nest_env
    cat > "$NEST/boot.sh" <<EOF
set -e
echo "\$DBUS_SESSION_BUS_ADDRESS" > "$NEST/bus.tmp"
dconf load /org/gnome/desktop/app-folders/ < "$NEST/app-folders.ini"
gsettings set org.gnome.shell favorite-apps "$favs"
. "$NEST/ext-settings.sh"
gsettings set org.gnome.shell enabled-extensions "$enabled"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.mutter experimental-features "['scale-monitor-framebuffer']"
gsettings set org.gnome.desktop.interface accent-color '$accent'
gsettings set org.gnome.desktop.interface color-scheme '$scheme'
gsettings set org.gnome.desktop.interface font-name 'Inter Variable 11'
gsettings set org.gnome.desktop.interface clock-format '24h'
gsettings set org.gnome.desktop.background picture-uri '$wall'
gsettings set org.gnome.desktop.background picture-uri-dark '$wall'
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.screensaver lock-enabled false
mv "$NEST/bus.tmp" "$NEST/bus"
exec gnome-shell --headless --wayland --no-x11 --virtual-monitor $size
EOF
    export GVFS_DISABLE_FUSE=1
    setsid -f bash -c 'echo $$ > "$0/sid"; exec dbus-run-session -- bash "$0/boot.sh"' "$NEST" > "$NEST/shell.log" 2>&1
    for _ in $(seq 20); do [[ -f $NEST/sid ]] && break; sleep 0.05; done
    for _ in $(seq 150); do
        if [[ -f $NEST/bus ]] && on_bus gdbus call --session --dest org.gnome.Shell \
            --object-path /org/gnome/Shell --method org.gnome.Shell.Eval '1' 2>/dev/null | grep -q true; then
            break
        fi
        sleep 0.2
    done
    # let the startup animation and extension enable settle
    sleep 2.5
    on_bus gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval 'Main.overview.hide(); Main.messageTray.getSources().forEach(s => s.destroy()); hsTest.move(global.stage.width / 2, global.stage.height - 2); 1' >/dev/null
    sleep 0.6
    echo "nested shell up: $size, bus $(bus)"
}

shot() {
    local f; f=$(realpath -m "$1")
    mkdir -p "$(dirname "$f")"
    on_bus gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$f" >/dev/null
    echo "$f"
}

scale() {
    on_bus python3 "$ROOT/tools/setscale.py" "$1"
}

cmd=${1:-}; shift || true
case $cmd in
    start) start "$@";;
    stop) stop;;
    eval) do_eval "$1";;
    shot) shot "$1";;
    scale) scale "$1";;
    gset) nest_env; GSETTINGS_SCHEMA_DIR="$NEST/data/gnome-shell/extensions/$UUID/schemas" on_bus gsettings "$@";;
    log) cat "$NEST/shell.log";;
    *) sed -n 2,16p "$0"; exit 2;;
esac
