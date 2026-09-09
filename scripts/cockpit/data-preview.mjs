// SPDX-License-Identifier: GPL-3.0-or-later
// Native component integration specimen: real geographic services, synthetic
// telemetry, and no vehicle connection. Flight writes are always rejected.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { CockpitData } from "../../packages/yonder-core/dist/cockpit/data.js";
import { TerrainPackService } from "../../packages/yonder-core/dist/terrain/service.js";
import { cockpitRoute } from "../../packages/yonder-core/dist/cockpit/routes.js";
import { cockpitProxy } from "../../packages/yonder-core/dist/console/cockpit.js";
import { DaemonClient } from "../../packages/yonder-core/dist/console/client.js";
import { fixture } from "../../packages/node-red-dashboard-2-yonder/cockpit/fixture.mjs";
const port = Number(process.env.COCKPIT_DATA_PORT || 4194);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid preview port");
const data = new CockpitData();
// Only the explicit flag opts into network data for a browser verification run.
if (process.argv.includes("--public-data"))
  data.configure({
    terrain: true,
    imagery: true,
    traffic: true,
    aircraftDatum: "EGM96",
  });
else data.configure({ aircraftDatum: "EGM96" });
const terrain = await TerrainPackService.open(
  fileURLToPath(
    new URL(
      "../../packages/yonder-core/src/terrain/assets/cove/",
      import.meta.url,
    ),
  ),
);
const vehicle = {
  snapshot: () => fixture(),
  instrumentation: () => fixture().instruments,
  submit: () => ({
    accepted: false,
    status: 400,
    message: "This synthetic geographic specimen has no aircraft transport",
  }),
};
const client = new DaemonClient({
  transport: async (request) => {
    const result = await cockpitRoute(
      { vehicle, data, terrain, instruments: { snapshot: async () => fixture().instruments } },
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
  session: () => "loopback-geographic-specimen",
});
const server = createServer((req, res) => {
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
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Synthetic flight / real geographic data specimen: http://127.0.0.1:${port}; no vehicle transport.`,
  ),
);
const stop = () => {
  data.close();
  terrain.clearCache();
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
