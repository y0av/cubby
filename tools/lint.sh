#!/usr/bin/env bash
# Runs shexli (the EGO review linter) on the packed zip, unpacked to a
# temporary directory. tree-sitter 0.26 crashes shexli 0.2.1, so pin 0.25.2.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
"$ROOT/tools/build.sh" >/dev/null
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
unzip -q "$ROOT/dist/"*.zip -d "$tmp"
uv run --no-project --python 3.12 --with shexli --with "tree-sitter==0.25.2" -- shexli "$tmp" | sed "s#$tmp/##g"
