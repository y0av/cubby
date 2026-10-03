#!/usr/bin/env bash
# Entry point checks against a running nested shell. Prints one line per
# scenario: name, expected layer state, actual, PASS/FAIL.
# Usage: tools/test-entry.sh [stock|dtp|dock]
set -uo pipefail
N=$(dirname "$0")/nest.sh
mode=${1:-stock}
fail=0
ev() { "$N" eval "$1" | sed -E "s/^\(true, '\"?//; s/\"?'\)$//"; }
state() { ev "JSON.stringify([!!cubbyTest.layer()?.isOpen, Main.overview.visible, !!Main.overview.dash.showAppsButton.checked, Main.modalCount])"; }
check() { # name expected-open
    sleep "${3:-0.7}"
    local s; s=$(state)
    local open; open=$(echo "$s" | python3 -c "import json,sys; print(str(json.loads(sys.stdin.read())[0]).lower())")
    if [[ $open == "$2" ]]; then r=PASS; else r=FAIL; fail=1; fi
    printf '%-46s want open=%-5s got %-26s %s\n' "$1" "$2" "$s" "$r"
}
# Clicks the visible Show Apps button of the given kind.
click_button() {
    ev "
const found = [];
const walk = a => { for (const c of a.get_children()) { if (c.mapped && c.has_style_class_name?.('show-apps')) found.push(c); walk(c); } };
walk(Main.layoutManager.uiGroup);
const b = found.find(x => !Main.overview._overview.contains(x)) ?? found[0];
if (b) { const [x, y] = b.get_transformed_position(); const [w, h] = b.get_transformed_size(); cubbyTest.click(x + w / 2, y + h / 2); }
b ? 'clicked' : 'no button'" >/dev/null
}

ev "Main.overview.hide(); cubbyTest.layer()?.close({instant: true}); 1" >/dev/null; sleep 0.5

ev "cubbyTest.key('a', ['Super_L']); 1" >/dev/null;               check "Super+A opens" true
ev "cubbyTest.key('a', ['Super_L']); 1" >/dev/null;               check "Super+A again closes" false
ev "Main.overview.showApps(); 1" >/dev/null;                   check "Main.overview.showApps() opens" true
ev "cubbyTest.key('Escape'); 1" >/dev/null;                       check "Esc closes" false
ev "Main.overview.showApps(); 1" >/dev/null;                   check "showApps() again opens" true
ev "cubbyTest.key('Super_L'); 1" >/dev/null;                      check "Super closes (like stock grid)" false
ev "Main.overview.show(); 1" >/dev/null; sleep 0.6
ev "Main.overview.dash.showAppsButton.checked = true; 1" >/dev/null; check "Overview dash Show Apps opens" true
ev "JSON.stringify(Main.overview.visible)" | grep -q false && echo "  overview hid: yes" || { echo "  overview hid: NO"; fail=1; }
ev "cubbyTest.key('a', ['Super_L']); 1" >/dev/null;               check "Super+A from layer closes" false
ev "Main.overview.show(); 1" >/dev/null; sleep 0.6
ev "cubbyTest.key('a', ['Super_L']); 1" >/dev/null;               check "Super+A from window picker opens" true
ev "Main.overview.toggle(); 1" >/dev/null;                     check "Activities toggle closes" false

if [[ $mode == dtp || $mode == dock ]]; then
    click_button;                                              check "$mode button opens" true
    click_button;                                              check "$mode button again closes" false
    click_button;                                              check "$mode button opens (2)" true
    ev "cubbyTest.key('Escape'); 1" >/dev/null;                   check "Esc closes" false
    click_button;                                              check "$mode button after Esc opens" true
    ev "cubbyTest.key('a', ['Super_L']); 1" >/dev/null;           check "Super+A closes" false
    ev "cubbyTest.key('a', ['Super_L']); 1" >/dev/null;           check "Super+A opens" true
    click_button;                                              check "$mode button closes after Super+A open" false
    click_button;                                              check "$mode button opens (3)" true
    click_button;                                              check "$mode button closes (3)" false
fi
exit $fail
