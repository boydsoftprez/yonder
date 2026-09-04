// SPDX-License-Identifier: GPL-3.0-or-later
// Ghidra GhidraScript (Java — Ghidra 12 dropped Jython, and JPyGhidra crashes on Java 26).
// For each SDK key-name string, find the functions that reference it and decompile them,
// so the request struct the handler builds can be read off the C. Output path comes from
// the KEYHANDLERS_OUT environment variable.
//
//   analyzeHeadless <proj> pocket2 -process libdjisdk_jni.so -postScript FindKeyHandlers.java
//
// Learning a protocol for interoperability; nothing here is copied into Yonder.
// @category Yonder
import java.io.FileWriter;
import java.util.LinkedHashSet;
import java.util.Set;
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

public class FindKeyHandlers extends GhidraScript {

    static final String[] KEYS = {
        "H1LiveViewResolutionFrameRate", "LiveViewQuality", "LiveViewOutputFormat",
        "WhiteBalance", "ExposureCompensation", "CameraISO", "ShutterSpeed", "ExposureMode",
        "VideoResolutionAndFrameRate", "VideoResolutionFrameRate",
        "DigitalZoomFactor", "FocusMode", "SpotFocus", "FocusArea",
        "video_out_para", "h1_raw_video_format", "h1_video_format", "liveview_subscribe",
        "liveview_source", "set_camera_video_quality", "video_coding_standard",
    };

    @Override
    public void run() throws Exception {
        String outPath = System.getenv("KEYHANDLERS_OUT");
        if (outPath == null) outPath = "/tmp/keyhandlers.txt";

        Listing listing = currentProgram.getListing();
        FunctionManager fm = currentProgram.getFunctionManager();
        ReferenceManager refman = currentProgram.getReferenceManager();

        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);

        FileWriter out = new FileWriter(outPath);
        out.write("# key-handler decompilation of " + currentProgram.getName() + "\n");

        // index defined strings once
        java.util.List<Data> strings = new java.util.ArrayList<>();
        for (Data data : listing.getDefinedData(true)) {
            Object v = null;
            try { v = data.getValue(); } catch (Exception e) { continue; }
            if (v instanceof String) strings.add(data);
        }

        for (String key : KEYS) {
            int nStr = 0;
            StringBuilder body = new StringBuilder();
            for (Data data : strings) {
                String s = (String) data.getValue();
                if (!s.contains(key)) continue;
                if (nStr >= 5) break;
                nStr++;
                Address addr = data.getAddress();
                body.append("-- string \"").append(s.length() > 90 ? s.substring(0, 90) : s)
                    .append("\" at ").append(addr).append("\n");
                Set<Address> seen = new LinkedHashSet<>();
                int n = 0;
                for (Reference ref : refman.getReferencesTo(addr)) {
                    Function f = fm.getFunctionContaining(ref.getFromAddress());
                    if (f == null || !seen.add(f.getEntryPoint())) continue;
                    if (++n > 3) { body.append("   (more functions omitted)\n"); break; }
                    body.append("---- ").append(f.getName()).append(" @ ").append(f.getEntryPoint())
                        .append(" (").append(f.getBody().getNumAddresses()).append(" bytes)\n");
                    DecompileResults res = decomp.decompileFunction(f, 60, monitor);
                    String c = res.decompileCompleted()
                        ? res.getDecompiledFunction().getC()
                        : "<decompile failed: " + res.getErrorMessage() + ">";
                    if (c.length() > 7000) c = c.substring(0, 7000);
                    body.append(c).append("\n");
                }
                if (n == 0) body.append("   (no code references)\n");
            }
            out.write("\n\n==================== " + key + "  (" + nStr + " strings) ====================\n");
            out.write(body.toString());
        }
        out.close();
        println("FindKeyHandlers: wrote " + outPath);
    }
}
