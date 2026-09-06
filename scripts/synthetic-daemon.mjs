// SPDX-License-Identifier: GPL-3.0-or-later
//
// The daemon, with the camera CI does not have.
//
// R-UI-03 builds navigation from detected hardware and R-UI-12 photographs
// every page in both palettes on every build. Put those together and there is
// a hole: **with no camera attached there is no camera page, so the capture
// gate covers none of the camera work and does not complain**, because from
// its point of view there is nothing there. A development machine has no
// camera and neither does a CI runner, so without this the camera pages would
// be the only pages in the console nobody had ever looked at.
//
// So this starts the *real* daemon — `startServer`, the same call
// `daemon/server.ts`'s own `main()` makes, with the same paths — and hands it
// one extra thing: a camera layer read from a checked-in fixture recorded off
// a Raspberry Pi 4 with a Global Shutter Camera on it.
//
// **This is a separate program, and that is the point.** `ServerOptions`
// carries no environment variable for the camera layer and must not: a switch
// that makes the shipped daemon report the cameras a file names rather than
// the ones the board has is a device lying about its own hardware, and an
// aircraft is the wrong place to discover somebody set it. Supplying it takes
// writing this file.
//
// **Why the whole layer and not a fake `v4l2-ctl` on PATH.** `detectCameras`
// reads `/dev/v4l/by-path` as well as running `v4l2-ctl`, and a machine with
// no `/dev/v4l` answers `byPathStable: false` — the one thing about a camera's
// identity the Cameras page exists to report honestly (R-CAM-05). A fixture
// that could only ever photograph the unstable answer would be photographing a
// state the board never has.
//
// Usage (scripts/verify-pages.sh does this):
//   YONDER_CAMERAS_FIXTURE=scripts/fixtures/camera-globalshutter.json \
//   YONDER_SOCKET=... YONDER_CONFIG=... node scripts/synthetic-daemon.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(REPO, "packages/yonder-core/dist/daemon/server.js");

const { startServer, consolePathsFromEnv } = await import(pathToFileURL(CORE).href);

const fixturePath = process.env.YONDER_CAMERAS_FIXTURE;
if (fixturePath === undefined) {
  process.stderr.write("synthetic-daemon: YONDER_CAMERAS_FIXTURE is required\n");
  process.exit(2);
}
/**
 * Read on **every call**, never once at start-up.
 *
 * A camera is a thing that can be unplugged, or replaced with a different one
 * — the same reason `verify-pages.sh`'s own `nmcli` and `mmcli` stand-ins read
 * `$MODEM_PRESENT` on every call rather than at start-up, and for the same
 * payoff: the gate can photograph two boards without restarting either
 * service. R-CTL-15 is what needs it. The console has to say which of the
 * sensor and the board is turning the picture, no camera on the bench answers
 * a flip control at all, and a run that could only ever describe one camera
 * could only ever photograph one of the two sentences.
 *
 * A read that fails or a file half-written by a `cp` in flight would take the
 * daemon down mid-capture, so the last good answer is kept and the failure is
 * said out loud rather than thrown: a harness that dies silently between two
 * captures is a harness that reports the *next* page as the broken one.
 */
let fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
function current() {
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (e) {
    process.stdout.write(`synthetic-daemon: ${fixturePath} could not be re-read (${e.message}); keeping the last answer\n`);
  }
  return fixture;
}

/**
 * The recorded sweep, answered as `detectCameras()` would.
 *
 * Cloned per call because the router hands what it gets straight to a page and
 * a shared object read twice would be one object two answers deep.
 */
const detect = async () => {
  const f = current();
  return structuredClone({ found: f.found, rejected: f.rejected });
};

/**
 * One device, read again — the Setup deck's *Re-probe* key.
 *
 * It answers from the same recording, which is honest about what this stands
 * in for: pressing Re-probe against a fixture cannot show a control the
 * operator has just turned on at the camera. What it does prove is that the
 * key reaches a route and the page redraws from the answer.
 */
const probe = async (node, card) => {
  const f = current();
  const found = f.found.find((d) => d.device === node);
  if (found !== undefined) return structuredClone(found);
  const rejected = f.rejected.find((r) => r.device === node);
  return structuredClone(rejected ?? { device: node, card, reason: "this device is not in the fixture" });
};

await startServer({
  socketPath: process.env.YONDER_SOCKET ?? "/run/yonder/core.sock",
  configPath: process.env.YONDER_CONFIG ?? "/etc/yonder/config.yaml",
  journalPath: process.env.YONDER_JOURNAL ?? "/var/lib/yonder/apply.json",
  secretsPath: process.env.YONDER_SECRETS ?? "/etc/yonder/secrets.yaml",
  renderers: [],
  console: consolePathsFromEnv(),
  // Never MEDIA_CONFIG_PATH. The shipped daemon writes /etc/mediamtx/mediamtx.yml
  // and this one must not: a harness run on a developer's machine that reached a
  // real /etc would be a test with a side effect nobody asked for.
  ...(process.env.YONDER_MEDIA_CONFIG === undefined
    ? {}
    : { mediaConfigPath: process.env.YONDER_MEDIA_CONFIG }),
  cameraLayer: {
    cameras: { detect, probe },
    encoder: async () => structuredClone(current().encoder),
    // The visibly fake value, and the whole reason it is in the fixture: the
    // stream address resolves a credential (R-VID-15) and R-UI-12 commits the
    // picture of it. capture-pages.mjs reads the device's own secrets.yaml and
    // fails any page carrying *that* value, so this is what a committed image
    // is allowed to show (R-SEC-10).
    rtspPassword: () => current().rtspPassword ?? null,
  },
});
process.stdout.write(`synthetic-daemon: listening, cameras from ${fixturePath}\n`);
