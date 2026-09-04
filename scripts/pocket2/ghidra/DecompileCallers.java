// SPDX-License-Identifier: GPL-3.0-or-later
// For each target function (name substring from DECOMP_TARGETS, newline-separated) find
// every function that calls it and decompile those callers — that is where the request
// payload gets assembled. READ_DOUBLES (space-separated hex addresses) are printed as
// doubles, with the program's image base, so rodata constants can be recovered without
// second-guessing the loader's base. Output to DECOMP_OUT. @category Yonder
import java.io.FileWriter;
import java.util.*;
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;

public class DecompileCallers extends GhidraScript {
    public void run() throws Exception {
        String out = System.getenv().getOrDefault("DECOMP_OUT", "/tmp/callers.txt");
        String[] targets = System.getenv().getOrDefault("DECOMP_TARGETS", "").split("\n");
        String doubles = System.getenv().getOrDefault("READ_DOUBLES", "");
        int cap = Integer.parseInt(System.getenv().getOrDefault("DECOMP_CAP", "6"));
        FileWriter w = new FileWriter(out);
        w.write("# image base: " + currentProgram.getImageBase() + "\n");
        for (String h : doubles.trim().split("\\s+")) {
            if (h.isEmpty()) continue;
            Address a = toAddr(Long.parseLong(h.replace("0x",""), 16));
            try { w.write("# double @" + a + " = " + currentProgram.getMemory().getLong(a) + " raw, as double: "
                          + Double.longBitsToDouble(currentProgram.getMemory().getLong(a)) + "\n"); }
            catch (Exception e) { w.write("# double @" + a + " unreadable: " + e + "\n"); }
        }
        DecompInterface d = new DecompInterface(); d.openProgram(currentProgram);
        FunctionManager fm = currentProgram.getFunctionManager();
        ReferenceManager rm = currentProgram.getReferenceManager();
        Set<Address> done = new HashSet<>();
        for (String t : targets) {
            if (t.isEmpty()) continue;
            for (Function f : fm.getFunctions(true)) {
                if (!f.getName().contains(t)) continue;
                w.write("\n\n######## target " + f.getName() + " @ " + f.getEntryPoint() + "\n");
                int n = 0;
                for (Reference r : rm.getReferencesTo(f.getEntryPoint())) {
                    Function c = fm.getFunctionContaining(r.getFromAddress());
                    if (c == null || !done.add(c.getEntryPoint())) continue;
                    if (++n > cap) { w.write("   (more callers omitted)\n"); break; }
                    w.write("\n==== caller " + c.getName() + " @ " + c.getEntryPoint() + " ====\n");
                    DecompileResults res = d.decompileFunction(c, 90, monitor);
                    String code = res.decompileCompleted() ? res.getDecompiledFunction().getC() : "<fail: " + res.getErrorMessage() + ">";
                    if (code.length() > 12000) code = code.substring(0, 12000) + "\n/* truncated */";
                    w.write(code);
                }
                if (n == 0) w.write("   (no callers found)\n");
            }
        }
        w.close(); println("DecompileCallers -> " + out);
    }
}
