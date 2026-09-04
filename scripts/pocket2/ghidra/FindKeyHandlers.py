# SPDX-License-Identifier: GPL-3.0-or-later
# Ghidra headless script (Jython). For each SDK key name we care about, find the
# functions that reference the string and decompile them, so the request struct the
# handler builds can be read off the C. Output goes to the path in the KEYHANDLERS_OUT
# environment variable, one section per key.
#
#   analyzeHeadless <projdir> pocket2 -import libdjisdk_jni.so -postScript FindKeyHandlers.py
#
# Learning a protocol for interoperability; nothing here is copied into Yonder.
# @category Yonder
import os
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor
from ghidra.program.model.symbol import RefType

KEYS = [
    "H1LiveViewResolutionFrameRate", "LiveViewQuality", "LiveViewOutputFormat",
    "CameraWhiteBalance", "WhiteBalance", "CameraExposureCompensation", "ExposureCompensation",
    "CameraISO", "CameraShutterSpeed", "CameraExposureMode", "CameraMode",
    "CameraVideoResolutionAndFrameRate", "VideoResolutionFrameRate", "VideoResolutionAndFrameRate",
    "DigitalZoomFactor", "SetDigitalZoomFactor", "CameraFocusMode", "FocusMode", "SpotFocus",
    "StartRecordVideo", "StopRecordVideo", "StartShootPhoto",
    "video_out_para", "h1_raw_video_format", "liveview_subscribe", "liveview_source",
]

out_path = os.environ.get("KEYHANDLERS_OUT", "/tmp/keyhandlers.txt")
out = open(out_path, "a")
monitor = ConsoleTaskMonitor()
decomp = DecompInterface()
decomp.openProgram(currentProgram)
listing = currentProgram.getListing()
fm = currentProgram.getFunctionManager()
refman = currentProgram.getReferenceManager()

def defined_strings():
    for data in listing.getDefinedData(True):
        try:
            v = data.getValue()
        except Exception:
            continue
        if isinstance(v, basestring):
            yield data.getAddress(), v

def functions_referencing(addr):
    seen = set()
    for ref in refman.getReferencesTo(addr):
        f = fm.getFunctionContaining(ref.getFromAddress())
        if f is not None and f.getEntryPoint() not in seen:
            seen.add(f.getEntryPoint())
            yield f

def decompile(f, limit=6000):
    res = decomp.decompileFunction(f, 60, monitor)
    if not res.decompileCompleted():
        return "<decompile failed: %s>" % res.getErrorMessage()
    return res.getDecompiledFunction().getC()[:limit]

hits = {}
for addr, s in defined_strings():
    for key in KEYS:
        if key in s:
            hits.setdefault(key, []).append((addr, s))

for key in KEYS:
    out.write("\n\n==================== %s ====================\n" % key)
    for addr, s in hits.get(key, [])[:6]:
        out.write("-- string %r at %s\n" % (s[:80], addr))
        n = 0
        for f in functions_referencing(addr):
            n += 1
            if n > 4:
                out.write("   (more functions omitted)\n"); break
            out.write("---- function %s at %s (%d bytes)\n" % (f.getName(), f.getEntryPoint(), f.getBody().getNumAddresses()))
            out.write(decompile(f))
            out.write("\n")
        if n == 0:
            out.write("   (no code references)\n")
out.close()
print("FindKeyHandlers: wrote %s" % out_path)
