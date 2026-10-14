#!/usr/bin/env bash
# Dragging an app out of one folder onto another folder's tile. Needs a nested shell.
set -uo pipefail
N=$(dirname "$0")/nest.sh
ev() { "$N" js "$1"; }
fail=0
expect() { if [[ $2 == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }

# opens folder $1, drags its first app out, then onto folder $2 (or empty
# board when $2 is empty), holding Esc first when $3 is "esc"
carry() {
    ev "cubbyTest.layer().close({instant: true}); cubbyTest.layer().open(); 1" >/dev/null; sleep 0.7
    ev "cubbyTest.layer().openFolder('$1'); 1" >/dev/null; sleep 0.7
    ev "
const l = cubbyTest.layer(), items = l.folderView.items;
const item = items.find(i => i.app.id === globalThis._cubbyApp) ?? items[0];
globalThis._cubbyApp = item.app.id;
const [x, y] = item.get_transformed_position(), p = l.folderView.panel;
const [px, py] = p.get_transformed_position();
const sx = x + 60, sy = y + 40, ox = px - 30, oy = py + 40;
cubbyTest.press(sx, sy);
cubbyTest.glide(sx, sy, ox, oy, 300, () => {
    imports.gi.GLib.timeout_add(0, 600, () => {
        const t = '$2' ? l.board.tiles.get('$2') : null;
        let tx = 4, ty = 4;
        if (t) {
            const [a, b] = t.get_transformed_position();
            tx = a + t.width / 2; ty = b + t.height / 2;
        }
        cubbyTest.glide(ox, oy, tx, ty, 300, () => {
            if ('${3:-}' === 'esc')
                cubbyTest.key('Escape');
            cubbyTest.release();
        });
        return false;
    });
});
1" >/dev/null
    sleep 2
}
group() { ev "cubbyTest.layer()._model.groupOf(_cubbyApp)?.id ?? 'none'"; }

ev "globalThis._cubbyApp = null; 1" >/dev/null
ids=$(ev "(cubbyTest.layer()._model.folders.filter(f => cubbyTest.layer().board.tiles.get(f.id)?.rect.page === 0 && !f.id.startsWith('cubby:') && f.apps.length > 1).map(f => f.id).slice(0, 2).join(' '))")
read -r A B <<<"$ids"
echo "from $A to $B"

carry "$A" "$B"
expect "app lands in the target folder" "$(group)" "$B"
expect "folder closed" "$(ev "cubbyTest.layer().mode")" "board"
"$N" shot "${SHOTS:-shots}/move-dropped.png" >/dev/null

carry "$B" "" ""
expect "drop on bare board keeps it" "$(group)" "$B"

carry "$B" "$A" esc
expect "Esc cancels the carry" "$(group)" "$B"

carry "$B" "$A"
expect "app moves back" "$(group)" "$A"

ev "cubbyTest.layer().close({instant: true}); 1" >/dev/null
exit $fail
