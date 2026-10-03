#!/usr/bin/env python3
"""Decode `gdbus call ... org.gnome.Shell.Eval` output from stdin and print
the JavaScript result. Strings print bare; other values print as JSON.
Exits 1 if the eval failed."""
import json
import sys

import gi
gi.require_version('GLib', '2.0')
from gi.repository import GLib

ok, text = GLib.Variant.parse(None, sys.stdin.read().strip(), None, None).unpack()
try:
    value = json.loads(text) if text else None
except ValueError:
    value = text
print(value if isinstance(value, str) else json.dumps(value))
sys.exit(0 if ok else 1)
