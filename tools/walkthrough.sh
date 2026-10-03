#!/usr/bin/env bash
# End-to-end walkthrough against a running nested shell: open with Super+A,
# arrow around, type "te", Enter, reopen, open a folder, Esc, enter edit
# mode, resize a tile from 2x1 to 1x1 and back, Done, close. Then report new
# log lines that look like errors.
set -uo pipefail
N=$(dirname "$0")/nest.sh
OUT=${1:-shots/walkthrough}
mkdir -p "$OUT"
js() { "$N" js "$1"; }
step() { printf '%-44s %s\n' "$1" "$2"; }
fail=0
check() { if [[ $2 == "$3" ]]; then step "$1" PASS; else step "$1" "FAIL (got $2, want $3)"; fail=1; fi; }
before=$("$N" log | wc -l)

js "Main.overview.hide(); cubbyTest.layer().close({instant: true}); 1" >/dev/null; sleep 0.5

js "cubbyTest.key('a', ['Super_L']); 1" >/dev/null; sleep 0.9
check "Super+A opens" "$(js 'cubbyTest.layer().isOpen')" true
"$N" shot "$OUT/01-open.png" >/dev/null

for k in Right Right Down Left; do js "cubbyTest.key('$k'); 1" >/dev/null; sleep 0.25; done
check "arrows select a slot" "$(js "cubbyTest.layer()._selected?.has_style_class_name('cubby-focusable') ?? false")" true
"$N" shot "$OUT/02-arrows.png" >/dev/null

js "cubbyTest.type('te'); 1" >/dev/null; sleep 1.2
check "typing te searches" "$(js 'cubbyTest.layer().mode')" search
"$N" shot "$OUT/03-search-te.png" >/dev/null
target=$(js "cubbyTest.layer()._selected?.app?.id ?? ''")
js "cubbyTest.key('Return'); 1" >/dev/null; sleep 1.5
check "Enter launches and closes" "$(js 'cubbyTest.layer().isOpen')" false
step "  launched" "$target"

js "Main.overview.showApps(); 1" >/dev/null; sleep 0.9
check "reopen" "$(js 'cubbyTest.layer().isOpen')" true

js "const l = cubbyTest.layer(); const t = [...l.board.tiles.values()].find(t => t.slots.some(s => s.kind === 'more')); const s = t.slots.find(s => s.kind === 'more'); const [x, y] = s.get_transformed_position(); cubbyTest.click(x + s.width / 2, y + s.height / 2); 1" >/dev/null
sleep 0.9
check "click overflow preview opens folder" "$(js 'cubbyTest.layer().mode')" folder
"$N" shot "$OUT/04-folder.png" >/dev/null
js "cubbyTest.key('Escape'); 1" >/dev/null; sleep 0.6
check "Esc closes folder" "$(js 'cubbyTest.layer().mode')" board

js "cubbyTest.key('e', ['Control_L']); 1" >/dev/null; sleep 0.7
check "Ctrl+E enters edit mode" "$(js 'cubbyTest.layer().mode')" edit
# find a 2x1 tile (or make one) and resize it to 1x1 and back with the handle
id=$(js "const b = cubbyTest.layer().board; Object.keys(b.rects).find(id => b.rects[id].w === 2 && b.rects[id].h === 1) ?? ''")
step "  2x1 tile" "$id"
drag() { # dx in cells
    js "
const l = cubbyTest.layer(), b = l.board, g = b.grid, t = b.tiles.get('$id');
const [x, y] = t.get_transformed_position(); const hx = x + t.width - 4, hy = y + t.height - 4;
cubbyTest.move(x + 20, y + 20);
imports.gi.GLib.timeout_add(0, 150, () => { cubbyTest.press(hx, hy); cubbyTest.glide(hx, hy, hx + ($1) * (g.U + g.GX), hy, 500, () => cubbyTest.release()); return false; });
1" >/dev/null
    sleep 1.4
}
drag -1
check "resize 2x1 to 1x1" "$(js "JSON.stringify([cubbyTest.layer().board.rects['$id'].w, cubbyTest.layer().board.rects['$id'].h])")" "[1,1]"
"$N" shot "$OUT/05-edit-1x1.png" >/dev/null
drag 1
check "resize back to 2x1" "$(js "JSON.stringify([cubbyTest.layer().board.rects['$id'].w, cubbyTest.layer().board.rects['$id'].h])")" "[2,1]"
js "const d = cubbyTest.layer().editBar.done; const [x, y] = d.get_transformed_position(); cubbyTest.click(x + d.width / 2, y + d.height / 2); 1" >/dev/null
sleep 0.6
check "Done leaves edit mode" "$(js 'cubbyTest.layer().mode')" board
js "cubbyTest.key('Escape'); 1" >/dev/null; sleep 0.7
check "Esc closes" "$(js 'cubbyTest.layer().isOpen')" false

echo "--- log lines since start that look like errors:"
"$N" log | tail -n +"$((before + 1))" | grep -iE "error|critical|warning|exception|disposed" |
    grep -viE "pipewire|keyring|portal|AuthenticationAgent|camera|NM.Object|geolocation|GPaste|search provider|GoaVolume|Gvc|malcontent" || echo "(none)"
exit $fail
