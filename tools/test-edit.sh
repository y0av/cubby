#!/usr/bin/env bash
# Edit mode checks with synthetic pointer and keys. Needs a nested shell.
set -uo pipefail
N=$(dirname "$0")/nest.sh
ev() { "$N" js "$1"; }
rect() { ev "JSON.stringify(hsTest.layer().board.rects[[...hsTest.layer().board.tiles.values()].find(t => t.folder.name === '$1').folder.id])"; }
fail=0
expect() { if [[ $2 == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }
FOLDER=${FOLDER:-Games}

ev "hsTest.layer().close({instant: true}); hsTest.layer().open(); 1" >/dev/null; sleep 0.7
ev "hsTest.key('e', ['Control_L']); 1" >/dev/null; sleep 0.6
start=$(rect "$FOLDER"); echo "start $start"

# resize: drag the corner handle one cell to the right
ev "
const l = hsTest.layer(), t = [...l.board.tiles.values()].find(t => t.folder.name === '$FOLDER');
const g = l.board.grid; const [x, y] = t.get_transformed_position();
const hx = x + t.width, hy = y + t.height;
hsTest.move(x + 20, y + 20);
globalThis._hsT = setTimeout(() => {}, 0);
imports.gi.GLib.timeout_add(0, 150, () => { hsTest.press(hx - 4, hy - 4); hsTest.glide(hx - 4, hy - 4, hx - 4 + g.U + g.GX, hy - 4, 500, () => hsTest.release()); return false; });
1" >/dev/null
sleep 1.4
r=$(rect "$FOLDER"); echo "after resize $r"
expect "resize by handle grows width" "$(echo "$r" | python3 -c 'import json,sys;print(json.load(sys.stdin)["w"])')" "$(( $(echo "$start" | python3 -c 'import json,sys;print(json.load(sys.stdin)["w"])') + 1 ))"
"$N" shot "${SHOTS:-shots}/m6-resized.png" >/dev/null

# keyboard: Shift+Left shrinks back, Right moves one cell
ev "hsTest.key('Left', ['Shift_L']); 1" >/dev/null; sleep 0.6
expect "Shift+Left shrinks" "$(rect "$FOLDER")" "$start"
ev "hsTest.key('Right'); 1" >/dev/null; sleep 0.6
moved=$(rect "$FOLDER"); echo "after Right $moved"
[[ $moved != "$start" ]] && echo "PASS Right moves" || { echo "FAIL Right did not move"; fail=1; }
ev "hsTest.key('Left'); 1" >/dev/null; sleep 0.6
expect "Left moves back" "$(rect "$FOLDER")" "$start"

# drag onto another tile: springs back
ev "
const l = hsTest.layer(), b = l.board, t = [...b.tiles.values()].find(t => t.folder.name === '$FOLDER');
const other = [...b.tiles.values()].find(o => o !== t && o.rect.page === 0);
const [x, y] = t.get_transformed_position(); const [ox, oy] = other.get_transformed_position();
hsTest.press(x + 30, y + 30); hsTest.glide(x + 30, y + 30, ox + 30, oy + 30, 500, () => hsTest.release());
1" >/dev/null
sleep 1.4
expect "invalid drop springs back" "$(rect "$FOLDER")" "$start"

# drag into an empty cell: lands there
ev "
const l = hsTest.layer(), b = l.board, g = b.grid, t = [...b.tiles.values()].find(t => t.folder.name === '$FOLDER');
const taken = new Set(); for (const r of Object.values(b.rects)) if (r.page === 0) for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) taken.add(xx + ',' + yy);
let target = null; for (let yy = g.rows - 1; yy >= 0 && !target; yy--) for (let xx = g.cols - 1; xx >= 0 && !target; xx--) if (!taken.has(xx + ',' + yy)) target = {x: xx, y: yy};
globalThis._hsTarget = target;
const p = b.pixelRect({page: 0, x: target.x, y: target.y, w: 1, h: 1});
const [bx, by] = b.strip.get_transformed_position();
const [x, y] = t.get_transformed_position();
hsTest.press(x + 30, y + 30); hsTest.glide(x + 30, y + 30, bx + p.x + 30, by + p.y + 30, 600, () => hsTest.release());
1" >/dev/null
sleep 1.5
target=$(ev "JSON.stringify(_hsTarget)")
r=$(rect "$FOLDER")
expect "drop into empty cell" "$(echo "$r" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["x"],d["y"])')" "$(echo "$target" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["x"],d["y"])')"

# Done, then the layout survives a disable/enable
ev "hsTest.key('Escape'); 1" >/dev/null; sleep 0.5
expect "Esc leaves edit mode" "$(ev "hsTest.layer().mode")" "board"
saved=$(rect "$FOLDER")
ev "Main.extensionManager.disableExtension('cubby@y0av.github.io'); 1" >/dev/null; sleep 0.5
ev "Main.extensionManager.enableExtension('cubby@y0av.github.io'); 1" >/dev/null; sleep 0.8
expect "layout persists across disable/enable" "$(rect "$FOLDER")" "$saved"
exit $fail
