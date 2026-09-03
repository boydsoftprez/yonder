// SPDX-License-Identifier: GPL-3.0-or-later
// Decompile named functions directly (their symbols survive in the binary even though the
// library is "stripped" of a .symtab — Ghidra recovered them from the dynamic table and
// C++ mangling). Targets the Serialization/setter functions whose wire layout we want.
// Names to decompile come from DECOMP_NAMES (newline-separated substrings); output to
// DECOMP_OUT. @category Yonder
import java.io.FileWriter;
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;

public class DecompileByName extends GhidraScript {
    public void run() throws Exception {
        String out = System.getenv().getOrDefault("DECOMP_OUT", "/tmp/decomp.txt");
        String[] want = System.getenv().getOrDefault("DECOMP_NAMES", "Serialization").split("\n");
        DecompInterface d = new DecompInterface(); d.openProgram(currentProgram);
        FunctionManager fm = currentProgram.getFunctionManager();
        FileWriter w = new FileWriter(out);
        int n = 0;
        for (Function f : fm.getFunctions(true)) {
            String nm = f.getName();
            boolean hit = false;
            for (String s : want) if (!s.isEmpty() && nm.contains(s)) { hit = true; break; }
            if (!hit) continue;
            n++;
            w.write("\n\n==== " + nm + " @ " + f.getEntryPoint() + " ====\n");
            DecompileResults r = d.decompileFunction(f, 60, monitor);
            w.write(r.decompileCompleted() ? r.getDecompiledFunction().getC()
                                           : "<fail: " + r.getErrorMessage() + ">");
        }
        w.close(); println("DecompileByName: " + n + " functions -> " + out);
    }
}
