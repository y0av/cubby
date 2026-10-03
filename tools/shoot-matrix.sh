#!/usr/bin/env bash
# Opens the layer at each target resolution and saves a screenshot.
# Usage: tools/shoot-matrix.sh OUTDIR [extra JS to run after opening]
set -euo pipefail
N=$(dirname "$0")/nest.sh
out=${1:?outdir}; js=${2:-}
mkdir -p "$out"
run() { # name size args... ; optional scale via SCALE env
    local name=$1 size=$2; shift 2
    "$N" start "$size" "$@" >/dev/null
    [[ -n ${SCALE:-} ]] && { "$N" scale "$SCALE" >/dev/null; sleep 1.5; }
    "$N" eval "Main.overview.showApps(); $js 1" >/dev/null
    sleep 1.4
    "$N" shot "$out/$name.png" >/dev/null
    echo "$out/$name.png $("$N" eval 'const g = cubbyTest.layer().grid; `${g.cols}x${g.rows} U=${g.U} pages=${cubbyTest.layer().board.nPages}`')"
}
run 1366x768-stock 1366x768
run 1920x1080-dock 1920x1080 --dock
run 1920x1200-dtp 1920x1200 --dtp
run 2560x1440-stock 2560x1440
SCALE=2 run 3840x2160-200pct 3840x2160
run 3440x1440-stock 3440x1440
"$N" stop
