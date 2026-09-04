// SPDX-License-Identifier: GPL-3.0-or-later
// For each symbol whose name contains a target (SYMBOL_TARGETS, newline-separated) — data
// symbols included — decompile every function that references its address. Used to find
// the static initialiser that populates a lookup table. Output to DECOMP_OUT. @category Yonder
import java.io.FileWriter;
import java.util.*;
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;

public class DecompileRefsToSymbol extends GhidraScript {
    public void run() throws Exception {
        String out = System.getenv().getOrDefault("DECOMP_OUT", "/tmp/refs.txt");
        String[] targets = System.getenv().getOrDefault("SYMBOL_TARGETS", "").split("\n");
        int cap = Integer.parseInt(System.getenv().getOrDefault("DECOMP_CAP", "8"));
        DecompInterface d = new DecompInterface(); d.openProgram(currentProgram);
        FunctionManager fm = currentProgram.getFunctionManager();
        ReferenceManager rm = currentProgram.getReferenceManager();
        SymbolTable st = currentProgram.getSymbolTable();
        FileWriter w = new FileWriter(out);
        Set<Address> done = new HashSet<>();
        for (String t : targets) {
            if (t.isEmpty()) continue;
            for (Symbol s : st.getAllSymbols(true)) {
                if (!s.getName().contains(t)) continue;
                w.write("\n\n######## symbol " + s.getName() + " @ " + s.getAddress() + "\n");
                int n = 0;
                for (Reference r : rm.getReferencesTo(s.getAddress())) {
                    Function c = fm.getFunctionContaining(r.getFromAddress());
                    if (c == null || !done.add(c.getEntryPoint())) continue;
                    if (++n > cap) { w.write("   (more omitted)\n"); break; }
                    w.write("\n==== ref-from " + c.getName() + " @ " + c.getEntryPoint() + " ====\n");
                    DecompileResults res = d.decompileFunction(c, 120, monitor);
                    String code = res.decompileCompleted() ? res.getDecompiledFunction().getC() : "<fail: " + res.getErrorMessage() + ">";
                    if (code.length() > 30000) code = code.substring(0, 30000) + "\n/* truncated */";
                    w.write(code);
                }
                if (n == 0) w.write("   (no references)\n");
            }
        }
        w.close(); println("DecompileRefsToSymbol -> " + out);
    }
}
