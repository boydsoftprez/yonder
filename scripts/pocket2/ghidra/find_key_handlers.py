#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Standalone PyGhidra driver (Ghidra 12 dropped Jython). Reuses an already-analysed
# project so it does not re-run the ~7 minute analysis. For each SDK key-name string it
# finds the functions that reference it and decompiles them, so the request struct the
# handler builds can be read off the C.
#
#   GHIDRA_INSTALL_DIR=<ghidra> python find_key_handlers.py <project_dir> <project_name> <binary> <out.txt>
#
# Learning a protocol for interoperability; nothing here is copied into Yonder.
import os, sys
import pyghidra

pyghidra.start()

proj_dir, proj_name, binary, out_path = sys.argv[1:5]

KEYS = [
    "H1LiveViewResolutionFrameRate", "LiveViewQuality", "LiveViewOutputFormat",
    "WhiteBalance", "ExposureCompensation", "CameraISO", "ShutterSpeed", "ExposureMode",
    "VideoResolutionAndFrameRate", "VideoResolutionFrameRate",
    "DigitalZoomFactor", "FocusMode", "SpotFocus", "FocusArea",
    "video_out_para", "h1_raw_video_format", "h1_video_format", "liveview_subscribe",
    "liveview_source", "set_camera_video_quality", "video_coding_standard",
]

from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

with pyghidra.open_program(binary, project_location=proj_dir, project_name=proj_name,
                           analyze=False) as api:
    program = api.getCurrentProgram()
    listing = program.getListing()
    fm = program.getFunctionManager()
    refman = program.getReferenceManager()
    monitor = ConsoleTaskMonitor()
    decomp = DecompInterface(); decomp.openProgram(program)

    # index defined strings once
    strings = []
    for data in listing.getDefinedData(True):
        try:
            v = data.getValue()
        except Exception:
            continue
        if isinstance(v, str):
            strings.append((data.getAddress(), v))

    def funcs_referencing(addr):
        seen = set()
        for ref in refman.getReferencesTo(addr):
            f = fm.getFunctionContaining(ref.getFromAddress())
            if f is not None and f.getEntryPoint() not in seen:
                seen.add(f.getEntryPoint()); yield f

    def decompile(f, limit=7000):
        res = decomp.decompileFunction(f, 60, monitor)
        if not res.decompileCompleted():
            return "<decompile failed: %s>" % res.getErrorMessage()
        return res.getDecompiledFunction().getC()[:limit]

    with open(out_path, "w") as out:
        out.write("# key-handler decompilation of %s\n" % binary)
        for key in KEYS:
            matches = [(a, s) for a, s in strings if key in s]
            out.write("\n\n==================== %s  (%d strings) ====================\n" % (key, len(matches)))
            for addr, s in matches[:5]:
                out.write("-- string %r at %s\n" % (s[:90], addr))
                n = 0
                for f in funcs_referencing(addr):
                    n += 1
                    if n > 3:
                        out.write("   (more functions omitted)\n"); break
                    out.write("---- %s @ %s (%d bytes)\n" % (f.getName(), f.getEntryPoint(), f.getBody().getNumAddresses()))
                    out.write(decompile(f)); out.write("\n")
                if n == 0:
                    out.write("   (no code references)\n")
    print("wrote", out_path)
