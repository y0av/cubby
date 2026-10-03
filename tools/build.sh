#!/usr/bin/env bash
# Build the extension zip into dist/ with gnome-extensions pack.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT/src"
mkdir -p "$ROOT/dist"
extra=()
extra+=(--extra-source=lib)
po=()
[[ -d $ROOT/po ]] && po=(--podir="$ROOT/po")
gnome-extensions pack --force --out-dir="$ROOT/dist" \
    --schema=schemas/org.gnome.shell.extensions.cubby.gschema.xml \
    "${extra[@]}" "${po[@]}" .
ls "$ROOT/dist"/*.zip
