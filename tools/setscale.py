#!/usr/bin/env python3
"""Set the scale of every monitor in the nested shell through
org.gnome.Mutter.DisplayConfig (temporary config). Run on the nested bus:
DBUS_SESSION_BUS_ADDRESS=... setscale.py 2"""
import sys

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

scale = float(sys.argv[1])
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
proxy = Gio.DBusProxy.new_sync(bus, 0, None, 'org.gnome.Mutter.DisplayConfig',
                               '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig')
serial, monitors, logical, props = proxy.call_sync('GetCurrentState', None, 0, -1).unpack()

current_mode = {}
for (connector, vendor, product, ser), modes, _mprops in monitors:
    for mode_id, w, h, rate, pref_scale, scales, mode_props in modes:
        if mode_props.get('is-current'):
            current_mode[connector] = (mode_id, scales)

new_logical = []
x = 0
for lx, ly, lscale, transform, primary, lmonitors, _lprops in logical:
    mons = []
    for (connector, vendor, product, ser) in lmonitors:
        mode_id, scales = current_mode[connector]
        best = min(scales, key=lambda s: abs(s - scale))
        mons.append((connector, mode_id, {}))
    new_logical.append((x, 0, best, transform, primary, mons))

proxy.call_sync('ApplyMonitorsConfig',
                GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', (serial, 1, new_logical, {})),
                0, -1)
print(f'scale set to {best}')
