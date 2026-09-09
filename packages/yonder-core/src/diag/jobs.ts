// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isProbeHost } from "./probe.js";

export type DiagnosticTool = "ping" | "traceroute" | "route" | "bandwidth";
export interface DiagnosticRequest {
  tool: DiagnosticTool; host: string; device?: string; family?: 4 | 6;
  count?: number; seconds?: number; port?: number; mbps?: number; direction?: "upload" | "download";
}
export interface DiagnosticJob {
  id: string; tool: DiagnosticTool; host: string; device: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
  startedAt: number; finishedAt: number | null; command: string;
  output: string; truncated: boolean; exitCode: number | null;
}
export class DiagnosticError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface DiagnosticProcess {
  done: Promise<{ code: number | null }>;
  stop(): void;
}
export type DiagnosticRunner = (argv: string[], output: (text: string) => void) => DiagnosticProcess;
const MAX_OUTPUT = 64 * 1024;
const MAX_JOBS = 16;
const TTL_MS = 10 * 60_000;
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new DiagnosticError(`Use a whole number between ${min} and ${max}.`);
  return value;
}
export function diagnosticRequest(value: unknown): DiagnosticRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DiagnosticError("Choose a diagnostic tool and target.");
  const b = value as Record<string, unknown>;
  if (!["ping", "traceroute", "route", "bandwidth"].includes(String(b.tool))) throw new DiagnosticError("Unknown diagnostic tool.");
  if (typeof b.host !== "string" || !isProbeHost(b.host)) throw new DiagnosticError("Enter a hostname, IPv4 address, or IPv6 address.");
  if (b.device !== undefined && (typeof b.device !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,14}$/.test(b.device)))
    throw new DiagnosticError("Choose an interface currently on this device.");
  if (b.family !== undefined && b.family !== 4 && b.family !== 6) throw new DiagnosticError("Choose IPv4 or IPv6.");
  if (b.family && isIP(b.host) && b.family !== isIP(b.host)) throw new DiagnosticError("The address does not match the selected IP family.");
  if (b.direction !== undefined && !["upload", "download"].includes(String(b.direction))) throw new DiagnosticError("Choose upload or download.");
  return {
    tool: b.tool as DiagnosticTool, host: b.host,
    ...(b.device ? { device: String(b.device) } : {}), family: (b.family ?? (isIP(b.host) || 4)) as 4 | 6,
    count: integer(b.count, 4, 1, 10), seconds: integer(b.seconds, 5, 2, 10),
    port: integer(b.port, 5201, 1, 65535), mbps: integer(b.mbps, 10, 1, 100),
    direction: b.direction === "download" ? "download" : "upload",
  };
}
export function diagnosticCommand(r: DiagnosticRequest, resolved?: string): string[] {
  const family = String(r.family ?? (isIP(r.host) || 4));
  const bound = (flag: string) => r.device ? [flag, r.device] : [];
  switch (r.tool) {
    case "ping": return ["ping", `-${family}`, "-n", "-c", String(r.count ?? 4), "-W", "2", "-w", "15", ...bound("-I"), r.host];
    case "traceroute": return ["stdbuf", "-oL", "-eL", "traceroute", `-${family}`, "-n", "-q", "1", "-w", "1", "-m", "20", ...bound("-i"), r.host];
    case "route": return ["ip", `-${family}`, "route", "get", resolved ?? r.host, ...bound("oif")];
    case "bandwidth": return ["iperf3", `-${family}`, "-c", r.host, "-p", String(r.port ?? 5201),
      "-t", String(r.seconds ?? 5), "-i", "1", "--forceflush", "--connect-timeout", "3000",
      "-b", `${r.mbps ?? 10}M`, ...bound("--bind-dev"), ...(r.direction === "download" ? ["-R"] : [])];
  }
}
/** A fixed command, no shell, no inherited secrets, with real process cancellation. */
export const systemDiagnosticRunner: DiagnosticRunner = (argv, output) => {
  let child: ChildProcess;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const done = new Promise<{ code: number | null }>(resolve => {
    child = spawn(argv[0]!, argv.slice(1), {
      shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    });
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", output); child.stderr?.on("data", output);
    child.once("error", (error: NodeJS.ErrnoException) => {
      output(error.code === "ENOENT" ? "Diagnostic tool is not installed on this board. Update the Yonder diagnostics packages.\n" : "Could not start this diagnostic.\n");
    });
    child.once("close", code => { closed = true; if (killer) clearTimeout(killer); resolve({ code }); });
  });
  return { done, stop: () => {
    if (closed) return;
    child.kill("SIGTERM");
    killer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 1000);
    killer.unref();
  } };
};
interface OwnedJob { owner: string; job: DiagnosticJob; run?: DiagnosticProcess; timer?: ReturnType<typeof setTimeout> }
export class DiagnosticJobs {
  private readonly jobs = new Map<string, OwnedJob>();
  constructor(private readonly options: {
    runner: DiagnosticRunner; devices: () => Promise<string[]>;
    resolve?: (host: string, family: 4 | 6) => Promise<string>; now?: () => number; timeoutMs?: number;
  }) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private prune(): void {
    for (const [id, entry] of this.jobs) if (entry.job.finishedAt !== null && this.now() - entry.job.finishedAt > TTL_MS) this.jobs.delete(id);
    while (this.jobs.size >= MAX_JOBS) {
      const oldest = [...this.jobs].find(([, v]) => v.job.status !== "running");
      if (!oldest) break;
      this.jobs.delete(oldest[0]);
    }
  }
  start(owner: string, input: unknown): DiagnosticJob {
    const request = diagnosticRequest(input);
    this.prune();
    if ([...this.jobs.values()].some(e => e.job.status === "running" || e.run)) throw new DiagnosticError("A diagnostic is already running. Wait for it to finish or stop your current test.", 409);
    const job: DiagnosticJob = { id: randomUUID(), tool: request.tool, host: request.host, device: request.device ?? null,
      status: "running", startedAt: this.now(), finishedAt: null, command: "", output: "", truncated: false, exitCode: null };
    const entry: OwnedJob = { owner, job };
    this.jobs.set(job.id, entry);
    const append = (text: string) => {
      if (job.status !== "running") return;
      const clean = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const remaining = MAX_OUTPUT - job.output.length;
      job.output += clean.slice(0, remaining);
      if (clean.length > remaining) job.truncated = true;
    };
    entry.timer = setTimeout(() => this.finish(entry, "timed-out"), this.options.timeoutMs ?? 30_000);
    entry.timer.unref();
    void (async () => {
      try {
        if (request.device && !(await this.options.devices()).includes(request.device))
          throw new DiagnosticError("That interface is no longer present. Refresh the interfaces and try again.");
        let resolved: string | undefined;
        if (request.tool === "route" && !isIP(request.host)) {
          resolved = await (this.options.resolve ?? (async (host, family) => (await lookup(host, { family })).address))(request.host, request.family ?? 4);
          if (isIP(resolved) !== request.family) throw new DiagnosticError("The hostname did not resolve in the selected IP family.");
          append(`${request.host} resolved to ${resolved}\n`);
        }
        if (job.status !== "running") return;
        const argv = diagnosticCommand(request, resolved);
        job.command = argv.join(" ");
        entry.run = this.options.runner(argv, append);
        const result = await entry.run.done;
        delete entry.run;
        if (job.status !== "running") return;
        job.exitCode = result.code;
        this.finish(entry, result.code === 0 ? "succeeded" : "failed");
      } catch (error) {
        append(error instanceof DiagnosticError ? `${error.message}\n` : "The diagnostic could not start or the hostname did not resolve.\n");
        this.finish(entry, "failed");
      }
    })();
    return { ...job };
  }
  read(owner: string, id: string): DiagnosticJob | null {
    const entry = this.jobs.get(id);
    if (!entry || entry.owner !== owner || (entry.job.finishedAt !== null && this.now() - entry.job.finishedAt > TTL_MS)) return null;
    return { ...entry.job };
  }
  cancel(owner: string, id: string): DiagnosticJob | null {
    const entry = this.jobs.get(id);
    if (!entry || entry.owner !== owner) return null;
    this.finish(entry, "cancelled");
    return { ...entry.job };
  }
  private finish(entry: OwnedJob, status: DiagnosticJob["status"]): void {
    if (entry.job.status !== "running") return;
    entry.job.status = status; entry.job.finishedAt = this.now();
    if (entry.timer) clearTimeout(entry.timer);
    if (status === "cancelled" || status === "timed-out") entry.run?.stop();
  }
  close(): void { for (const entry of this.jobs.values()) this.finish(entry, "cancelled"); }
}
