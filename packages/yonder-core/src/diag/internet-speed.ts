// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { DiagnosticProcess, DiagnosticRunner } from "./jobs.js";

export const SPEED_TEST_HOST = "speed.cloudflare.com";
export const SPEED_TEST_MAX_BYTES = 27_000_003;
export interface InternetSpeedResult {
  provider: "Cloudflare"; phase: "latency" | "download" | "upload" | "complete";
  latencyMs: number | null; downloadMbps: number | null; uploadMbps: number | null;
  transferredBytes: number; maxBytes: number; serverIp: string | null; localIp: string | null;
}
interface Measurement {
  status: number; downloaded: number; uploaded: number; total: number; start: number;
  connect: number; dns: number; pretransfer: number; remote: string; local: string;
}
const METRICS = '{"status":%{http_code},"downloaded":%{size_download},"uploaded":%{size_upload},"total":%{time_total},"start":%{time_starttransfer},"connect":%{time_connect},"dns":%{time_namelookup},"pretransfer":%{time_pretransfer},"remote":"%{remote_ip}","local":"%{local_ip}"}';
export function parseSpeedMeasurement(text: string): Measurement {
  const value = JSON.parse(text) as Measurement;
  for (const key of ["status", "downloaded", "uploaded", "total", "start", "connect", "dns", "pretransfer"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)
      throw new Error("The speed-test service returned invalid measurements.");
  }
  if (value.total < value.start || value.total < value.pretransfer || value.connect < value.dns)
    throw new Error("The speed-test timing was inconsistent.");
  return value;
}
export function speedSample(measurement: Measurement, direction: "download" | "upload"): { seconds: number; mbps: number } {
  // Upload TTFB arrives after the body was sent. Subtracting it would count
  // only the response body and report an invented, enormous upload rate.
  const seconds = measurement.total - (direction === "download" ? measurement.start : measurement.pretransfer);
  if (seconds <= 0) throw new Error("The transfer was too short to measure.");
  const bytes = direction === "download" ? measurement.downloaded : measurement.uploaded;
  return { seconds, mbps: bytes * 8 / seconds / 1_000_000 };
}
/** Bounded HTTPS transfers from the board; never from the operator's browser. */
export function internetSpeedTest(options: {
  runner: DiagnosticRunner; device?: string; family: 4 | 6;
  output: (text: string) => void; progress: (value: InternetSpeedResult) => void;
}): DiagnosticProcess {
  let active: DiagnosticProcess | undefined;
  let cancelled = false;
  const result: InternetSpeedResult = {
    provider: "Cloudflare", phase: "latency", latencyMs: null, downloadMbps: null, uploadMbps: null,
    transferredBytes: 0, maxBytes: SPEED_TEST_MAX_BYTES, serverIp: null, localIp: null,
  };
  const publish = () => options.progress({ ...result });
  const measure = async (bytes: number, direction: "download" | "upload"): Promise<Measurement> => {
    if (cancelled) throw new Error("Test cancelled.");
    const url = `https://${SPEED_TEST_HOST}/${direction === "download" ? "__down?bytes=" + bytes : "__up?"}&test=${randomUUID()}`;
    const args = ["curl", "-q", `-${options.family}`, "--silent", "--show-error", "--fail",
      "--http1.1", "--proto", "=https", "--connect-timeout", "5", "--max-time", "15",
      "--max-filesize", String(direction === "download" ? bytes : 65_536),
      "--output", "/dev/null", "--write-out", METRICS,
      ...(options.device ? ["--interface", "if!" + options.device] : []),
      ...(direction === "upload" ? ["--header", "Content-Type: application/octet-stream", "--header", "Expect:", "--data-binary", "@-"] : []), url];
    let text = "";
    active = options.runner(args, chunk => { if (text.length < 16_384) text += chunk.slice(0, 16_384 - text.length); },
      direction === "upload" ? new Uint8Array(bytes) : undefined);
    const finished = await active.done;
    active = undefined;
    if (cancelled) throw new Error("Test cancelled.");
    if (finished.code !== 0) throw new Error(`Cloudflare ${direction} did not complete (curl exit ${finished.code ?? "unknown"}). Check this interface's internet access and try again.`);
    const value = parseSpeedMeasurement(text);
    if (value.status < 200 || value.status >= 300 ||
      (direction === "download" ? value.downloaded : value.uploaded) !== bytes)
      throw new Error("The speed-test service did not confirm the full transfer.");
    result.transferredBytes += direction === "download" ? value.downloaded : value.uploaded;
    result.serverIp = value.remote; result.localIp = value.local;
    publish();
    return value;
  };
  const done = (async () => {
    try {
      options.output(`Internet speed test · Cloudflare\nFrom: ${options.device ?? "automatic route"} · IPv${options.family}\nMaximum test payload: 27 MB. Testing latency…\n`);
      publish();
      const latencies: number[] = [];
      for (let i = 0; i < 3; i++) {
        const sample = await measure(1, "download");
        latencies.push((sample.connect - sample.dns) * 1000);
      }
      result.latencyMs = latencies.sort((a, b) => a - b)[1]!;
      options.output(`Latency (TCP connection): ${result.latencyMs.toFixed(1)} ms\n`);
      for (const direction of ["download", "upload"] as const) {
        if (cancelled) throw new Error("Test cancelled.");
        result.phase = direction; publish();
        options.output(`Measuring ${direction}…\n`);
        const first = speedSample(await measure(1_000_000, direction), direction);
        let sample = first;
        if (first.seconds < 2) {
          const limit = direction === "download" ? 20_000_000 : 5_000_000;
          const bytes = Math.min(limit, Math.max(1_000_000, Math.ceil(first.mbps * 1_000_000 / 8 * 3)));
          sample = speedSample(await measure(bytes, direction), direction);
        }
        if (direction === "download") result.downloadMbps = sample.mbps;
        else result.uploadMbps = sample.mbps;
        options.output(`${direction === "download" ? "Download" : "Upload"}: ${sample.mbps.toFixed(2)} Mb/s\n`);
        publish();
      }
      result.phase = "complete"; publish();
      options.output(`Test payload transferred: ${(result.transferredBytes / 1_000_000).toFixed(2)} MB\nComplete. These are single-connection HTTPS speed estimates.\n`);
      return { code: 0 };
    } catch (error) {
      if (!cancelled) options.output((error instanceof Error ? error.message : "The internet speed test failed.") + "\n");
      return { code: cancelled ? 143 : 1 };
    }
  })();
  return { done, stop() { cancelled = true; active?.stop(); } };
}
