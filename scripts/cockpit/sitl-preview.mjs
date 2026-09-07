// SPDX-License-Identifier: GPL-3.0-or-later
// Native browser cockpit backed by a newly created, isolated ArduPlane SITL.
// Starts disarmed. Opening this service sends no MAVLink requests or commands.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, createServer as netServer } from "node:net";
import { createServer } from "node:http";
import { MavLinkPacketSplitter } from "node-mavlink";
import { VehicleService } from "../../packages/yonder-core/dist/mav/vehicle.js";
import { systemClock } from "../../packages/yonder-core/dist/apply/types.js";
import { CockpitData } from "../../packages/yonder-core/dist/cockpit/data.js";
import { TerrainPackService } from "../../packages/yonder-core/dist/terrain/service.js";
import { cockpitRoute } from "../../packages/yonder-core/dist/cockpit/routes.js";
import { cockpitProxy } from "../../packages/yonder-core/dist/console/cockpit.js";
import { DaemonClient } from "../../packages/yonder-core/dist/console/client.js";

const args = process.argv.slice(2),
  index = args.indexOf("--firmware-dir");
assert(
  index >= 0 && args[index + 1],
  "Usage: node scripts/cockpit/sitl-preview.mjs --firmware-dir DIR [--public-data]",
);
assert(
  args.every((a, i) => i === index || i === index + 1 || a === "--public-data"),
  "Unknown option",
);
const firmware = resolve(args[index + 1]);
for (const [file, hash] of [
  [
    "bin/arduplane",
    "1b6f6810016531f81a2ab240c1353aa7310334079b4c0954ecac8d17cf1adabe",
  ],
  [
    "plane.parm",
    "93ba9a70c771609a90b81249d6a1d5a9df8d48bef7d149b42b2d9c7fbd06494a",
  ],
])
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(firmware, file)))
      .digest("hex"),
    hash,
    `Unverified simulator input ${file}`,
  );
const httpPort = 4195,
  vehiclePort = 5766,
  name = `yonder-native-cockpit-${randomUUID().slice(0, 8)}`;
const runtime = mkdtempSync(join(tmpdir(), "yonder-native-cockpit-"));
const docker = (...a) =>
  execFileSync("docker", a, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let started = false,
  socket,
  service,
  server,
  data,
  terrain,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  service?.close();
  socket?.destroy();
  data?.close();
  terrain?.clearCache();
  server?.close();
  if (started) {
    let label;
    try {
      label = docker("inspect", "--format", '{{index .Config.Labels "yonder.test"}}', name);
    } catch (error) {
      // A timed-out docker run can have succeeded. Only a confirmed absent
      // container allows cleanup without checking the unique ownership label.
      if (!/No such (object|container)/i.test(String(error.stderr || ""))) {
        throw new Error(`Could not verify simulator cleanup; retained ${runtime}: ${error.message}`);
      }
    }
    if (label !== undefined) {
      assert.equal(label, "native-cockpit-preview", `Unexpected owner; retained ${runtime}`);
      docker("rm", "-f", name);
    }
  }
  rmSync(runtime, { recursive: true, force: true });
}
async function portFree(port) {
  const probe = netServer();
  await new Promise((ok, no) => {
    probe.once("error", no);
    probe.listen(port, "127.0.0.1", ok);
  });
  await new Promise((r) => probe.close(r));
}
const shutdown = () => void stop().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await portFree(httpPort);
  await portFree(vehiclePort);
  started = true;
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--platform",
    "linux/amd64",
    "--label",
    "yonder.test=native-cockpit-preview",
    "-p",
    `127.0.0.1:${vehiclePort}:5760`,
    "--mount",
    `type=bind,src=${firmware},dst=/opt/sitl,readonly`,
    "--mount",
    `type=bind,src=${runtime},dst=/data`,
    "-w",
    "/data",
    "ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517",
    "/opt/sitl/bin/arduplane",
    "--model",
    "plane",
    "--home",
    "35.9607874,-83.3668696,315.641734,90",
    "--defaults",
    "/opt/sitl/plane.parm",
    "--speedup",
    "1",
    "--sysid",
    "1",
  );
  let firstBytes;
  for (let attempt = 0; attempt < 30 && !socket; attempt++) {
    try {
      socket = await new Promise((ok, no) => {
        const s = createConnection({ host: "127.0.0.1", port: vehiclePort });
        const fail = (error) => {
          clearTimeout(timeout);
          s.destroy();
          no(error);
        };
        const timeout = setTimeout(
          () => fail(new Error("Waiting for simulator data")),
          2000,
        );
        s.once("error", fail);
        s.once("close", () => fail(new Error("Simulator starting")));
        s.once("data", (bytes) => {
          clearTimeout(timeout);
          firstBytes = bytes;
          ok(s);
        });
      });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert(socket, "Isolated simulator did not start");
  service = new VehicleService({
    clock: systemClock,
    send: (bytes) =>
      new Promise((ok, no) => socket.write(bytes, (e) => (e ? no(e) : ok()))),
  });
  const splitter = new MavLinkPacketSplitter();
  splitter.on("data", ({ buffer }) => service.receive(buffer));
  splitter.on("error", () => {});
  socket.on("data", (bytes) => splitter.write(bytes));
  socket.on("error", (error) =>
    console.error("SITL connection:", error.message),
  );
  socket.once("close", () => {
    if (stopping) return;
    console.error("SITL connection closed; commands will not be retried.");
    void stop().finally(() => process.exit(1));
  });
  if (firstBytes) splitter.write(firstBytes);
  data = new CockpitData();
  // This isolated simulator's configured heights use the demo pack's reference.
  data.configure({
    aircraftDatum: "EGM96",
    ...(args.includes("--public-data")
      ? { terrain: true, imagery: true, traffic: true }
      : {}),
  });
  terrain = await TerrainPackService.open(
    fileURLToPath(
      new URL(
        "../../packages/yonder-core/dist/terrain/assets/cove/",
        import.meta.url,
      ),
    ),
  );
  const vehicle = {
    submit: (request) => service.submit(request),
    snapshot: () => {
      const state = service.snapshot();
      state.telemetry.source = "ArduPlane SITL";
      return state;
    },
  };
  const client = new DaemonClient({
    transport: async (request) => {
      const result = await cockpitRoute(
        { vehicle, data, terrain },
        request.method,
        request.path,
        request.body,
      );
      return {
        status: result?.status ?? 404,
        body: JSON.stringify(result?.body ?? {}),
      };
    },
  });
  const proxy = cockpitProxy({
    client,
    session: () => `isolated-sitl:${name}`,
  });
  server = createServer((req, res) => {
    // Only the local dev proxy may use this simulator session; DNS rebinding
    // must not turn an arbitrary website into an admitted operator.
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || "")) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!proxy(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(httpPort, "127.0.0.1", ok);
  });
  console.log(
    `Native ArduPlane SITL API http://127.0.0.1:${httpPort} · container ${name}`,
  );
  console.log(
    "Start the Vue harness with COCKPIT_API=http://127.0.0.1:4195 and open /?live=1.",
  );
  console.log(
    "Aircraft → Request flight telemetry → Read aircraft mission. Import/load your local mission, review, then explicitly upload/arm/start. Ctrl-C removes only this simulator.",
  );
} catch (error) {
  console.error(error.message);
  await stop();
  process.exitCode = 1;
}
