#!/usr/bin/env bash
# M1 check: enable/disable the extension 20 times in the nested shell and
# verify the shell is restored exactly (methods, keybinding, actors) with no
# errors logged. Needs a running nested shell (tools/nest.sh start).
set -euo pipefail
N=$(dirname "$0")/nest.sh
UUID=homescreen@y0av.github.io
ev() { "$N" eval "$1"; }

before=$("$N" log | wc -l)
ev "Main.extensionManager.disableExtension('$UUID'); 1" >/dev/null
sleep 0.5
ev "
const op = Object.getPrototypeOf(Main.overview);
const cp = Object.getPrototypeOf(Main.overview._overview.controls);
globalThis._hsBase = {show: op.show, hide: op.hide, toggle: op.toggle,
  onT: cp._onShowAppsButtonToggled, own: Object.keys(Main.overview).length,
  kids: Main.layoutManager.uiGroup.get_n_children(), modal: Main.modalCount};
1" >/dev/null

for i in $(seq 20); do
    ev "Main.extensionManager.enableExtension('$UUID'); 1" >/dev/null
    # open and close once per cycle so the layer, dimmer and modal run
    ev "Main.overview.showApps(); 1" >/dev/null
    if (( i % 2 == 0 )); then sleep 0.15; fi
    ev "Main.extensionManager.disableExtension('$UUID'); 1" >/dev/null
done
sleep 0.5

ev "
const op = Object.getPrototypeOf(Main.overview);
const cp = Object.getPrototypeOf(Main.overview._overview.controls);
const b = globalThis._hsBase;
const same = [op.show === b.show, op.hide === b.hide, op.toggle === b.toggle,
  cp._onShowAppsButtonToggled === b.onT,
  Object.keys(Main.overview).length === b.own,
  Main.layoutManager.uiGroup.get_n_children() === b.kids,
  Main.modalCount === b.modal,
  !Main.layoutManager.uiGroup.get_children().some(c => c.name === 'homescreenLayer')];
JSON.stringify(same)"

# stock behaviour is back: Super+A opens the stock app grid
ev "hsTest.key('a', ['Super_L']); 1" >/dev/null
sleep 0.8
ev "JSON.stringify([Main.overview.visible, Main.overview.dash.showAppsButton.checked])"
ev "Main.overview.hide(); 1" >/dev/null
sleep 0.6

# poke the signals the extension listened to; leaked handlers would throw
ev "Main.layoutManager.emit('monitors-changed'); global.display.emit('workareas-changed'); 1" >/dev/null
ev "Main.overview.show(); 1" >/dev/null; sleep 0.6
ev "Main.overview.hide(); 1" >/dev/null; sleep 0.6

ev "Main.extensionManager.enableExtension('$UUID'); 1" >/dev/null
echo "--- new log lines with errors:"
"$N" log | tail -n +"$before" | grep -iE "error|warn|critical|disposed|exception" | grep -viE "pipewire|keyring|AuthenticationAgent|camera|NM.Object|portal|GoaVolume|ibus|Malcontent|geoclue|Gvc|wireplumber|screencast" || echo "(none)"
