# Rockchip Video and a Ground Station — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Radxa Zero 3W encodes H.264 and H.265 in hardware through Yonder's own
pipeline, streams to a browser and a ground station, retunes its bitrate live, and carries
MAVLink from a flight controller on its header UART to Mission Planner on the ZeroTier mesh
over cellular — with everything that took a hand on the bench now done by the installer.

**Architecture:** The GStreamer composer stays and gains a Rockchip MPP arm. `probeEncoder`
asks the GStreamer registry for `mpph264enc`/`mpph265enc`/`mppjpegdec`; `compose()` decodes
with `mppjpegdec`, encodes with the MPP element the camera's `codec` names, scales the preview
*inside* the encoder through RGA (`width`/`height`), and keeps every other board's line
byte-for-byte what it is today. The pipeline host learns that `bps` is bits per second and
that a recording carries whichever parser the main chain carries. MPP, librga and the plugin
are built from pinned commits into the offline payload and installed by a role only where
`/dev/mpp_service` exists. The ground station is a `mavlink.endpoints` entry — no code.

**Tech Stack:** TypeScript, Zod, Vitest, GStreamer 1.26 (`gstreamer-rockchip` 1.14.4 built
from source, Rockchip MPP, librga), Python 3 + PyGObject (the pipeline host), mediamtx
1.20.1, mavlink-router, POSIX sh installer roles, Docker (`debian:trixie`, `linux/arm64`).

**Spec:** [`docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md`](../specs/2026-09-05-rockchip-hardware-encode-design.md) —
§2's decision is **reversed by this plan** on the evidence in its own 2026-09-06 addendum
(Task 8 records that); §4, §5, §6, §8, §9 and §10 are implemented as written, with the
converter probe collapsing to "RGA in the encoder on MPP, unchanged elsewhere". §7
(demand-driven output) is **not** in this plan.
**Evidence:** [`docs/hardware/hardware-encode-on-a-radxa-zero-3w.md`](../../hardware/hardware-encode-on-a-radxa-zero-3w.md)
and [`docs/hardware/ffmpeg-as-the-pipeline-composer.md`](../../hardware/ffmpeg-as-the-pipeline-composer.md)
(the latter arrives with Task 0). Every element, property and number below is taken from
those two notes and from the board on 2026-09-07, not from documentation.

## Global Constraints

- **Logic lives in node packages, never in Node-RED function nodes.** `flows/` is wiring only.
- **Every change traces to a requirement ID.** New this plan: `R-HW-07`, `R-VID-20`;
  known issues `K-62` (renumbered from the bench branch's `K-54`), `K-63`, `K-64`, `K-65`.
  IDs are stable; never reuse or renumber an existing one.
- **The Pi path does not change.** A Pi composes today's launch line token for token after
  every task here; `pipeline.test.ts`'s existing assertions stay green untouched. K-62's
  Pi change ships separately with its own Pi proof.
- **The preview branch is always H.264** (`R-VID-20`): the browser reaches it over WebRTC.
  `camera.codec` governs the main stream only.
- **Probed, never tabulated** (`R-CAM-13`): nothing selects an encoder, a decoder or a scaler
  by board name. The registry and `/dev/mpp_service` are the evidence.
- **Nothing may make the device unreachable.** A codec change is exempt from the
  confirmation window (`CAMERA_EXEMPT_LEAVES` already lists `codec`); a `mavlink.endpoints`
  change is exempt (`R-CFG-12`); nothing here touches an interface, a route or a radio.
  The one reboot (Task 11's UART role) is staged, not live.
- **Yonder relays commands and never originates them** (`R-CMD-04`, `R-CMD-05`).
- **A node without tests will not be merged.** Mutation-check every guard: delete it, watch
  a named test go red, restore it.
- **`git commit -s`, GPG-signed** (`commit.gpgsign` is set). Never `--no-gpg-sign`.
  Messages in the imperative, the requirement ID where one applies.
- **No board address, no credential in any committed file.** The board is `<radxa>` in this
  document; the ground station is `<gs>`; the RTSP password is `<rtsp-password>`.
- **Run tests with `npx vitest run --root packages/yonder-core <file>`**; the whole suite is
  `npx vitest run --root packages/yonder-core` (113 files, 2670 tests, ~32 s on this
  branch). Type-check with `npx tsc --noEmit -p packages/yonder-core/tsconfig.json` — CI
  type-checks the test files too, so a widened type is enforced across every fixture.
- **Shell roles pass `shellcheck`** (`shellcheck installer/install.sh installer/make-payload.sh installer/lib/*.sh installer/roles/*.sh scripts/*.sh`)
  and `./installer/install.sh --dry-run` on a machine with no payload and no Rockchip.
- **Work in this worktree on branch `claude/radxa-video-telemetry-test-624039`**, which Task 0
  points at the video branch's HEAD (`40e33af`). Do not `cd` to the main checkout.
- **The board is reached as `ssh root@<radxa>`** — `sudo` there prompts; root has the key.
  The daemon answers on `/run/yonder/core.sock`. Leave the board as you found it.

## File Map

| File | Responsibility after this plan |
|---|---|
| `packages/yonder-core/src/video/probe/encoder.ts` | Which encoder family the board has: MPP via the GStreamer registry, V4L2 via the node sweep, else software. Answers `element`, `h265`, `decoder`. |
| `packages/yonder-core/src/video/pipeline.ts` | Composes the launch line for every family; reads bitrate and preview shape back out of one; refuses what the board cannot run. Gains the MPP branches, `h265`, `bps`, `scalesInEncoder()`. |
| `packages/yonder-core/src/video/encoder.ts` | The runtime channel. Learns that a preview scaled inside the encoder takes no live size. |
| `packages/yonder-core/src/video/receive.ts` | The ground station's receive line, now for H.265 too. |
| `packages/yonder-core/src/schema/config.ts` | `codec: h264 \| h265`. |
| `installer/payload/yonder-pipeline` | The host: `bps` is bits per second; a recording carries the main chain's own parser. |
| `packages/yonder-core/src/video/fake-gi/gi/repository/__init__.py` | The stand-in GStreamer the host is tested against; gains `get_factory()` and `get_parent_element()`. |
| `installer/make-payload.sh` | Stages `gst-rockchip`: MPP, librga and the plugin built in a container from pinned commits. Its `--only` summary no longer dies. |
| `installer/roles/52-gst-rockchip.sh` | Installs the plugin and its libraries where `/dev/mpp_service` exists; proves the registry sees the encoders. |
| `installer/roles/50-mediamtx.sh` | Installs every GStreamer package the composer relies on and resolves every board-independent element. |
| `installer/lib/common.sh` | Overridable defaults for the new role and the UART role's Armbian arm. |
| `installer/roles/40-uart.sh` | Frees the header UART on Armbian (UART2 overlay, no serial console, no `ttyFIQ0` getty). |
| `packages/yonder-core/src/mav/renderer.ts` | `device: auto` sweeps `/dev/ttyS2`. |
| `.github/workflows/ci.yml` | Builds the `gst-rockchip` payload for arm64 when the recipe changes. |
| `docs/…` | Spec §2 reversed on evidence; `R-HW-07`, `R-VID-20`; K-62…K-65; architecture and roadmap corrected; a hardware note for what shipped. |

---

### Task 0: The branch, and the bench record it stands on

The video branch (`claude/exciting-merkle-e4cd39`, HEAD `40e33af`) has the code. The bench
branch (`claude/happy-tereshkova-f8087d`, 9 commits, docs and spike scripts only) has the
evidence this plan cites and the spec addendum that reverses §2. They share a base
(`506bbe5`) and conflict in exactly one file, `docs/known-issues.md`, because both appended
entries: the bench branch numbered its new entry **K-54**, and the video branch already
spent K-54 on *"A detected camera cannot be configured from the console"*. IDs are never
reused, so the bench entry becomes **K-62**.

> **Note, after execution (2026-09-07):** by the time Task 0 ran,
> `claude/exciting-merkle-e4cd39` had advanced to `8d200b7` and spent K-61
> itself, so the branch merged that tip too and the bench entry is **K-62**;
> the plan's later entries are K-63, K-64 and K-65. Requirement IDs were
> unaffected.

**Files:**
- Modify: `docs/known-issues.md` (merge resolution)
- Modify: `docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md:146` (one reference)
- Arrive by merge: `docs/hardware/ffmpeg-as-the-pipeline-composer.md`, `scripts/spikes/{camguard.sh,composer-latency.py,composer-throughput.py,ffmpeg-retune-libav.c,ffmpeg-retune.py,reconfigure-resolution.py,retune-bitrate-mpp.py,rockchip-camera-path.py}`

- [ ] **Step 1: Point this worktree's branch at the video branch's HEAD**

The session branch has no commits of its own (`git rev-list --count main..claude/radxa-video-telemetry-test-624039` is `0`).

```bash
cd /Users/j.j.boyd/OpenUAS/.claude/worktrees/radxa-video-telemetry-test-624039
git checkout -B claude/radxa-video-telemetry-test-624039 40e33af
git log --oneline -1
```

Expected: `40e33af feat(console): the picture offers to start a camera that is not running — R-UI-10, R-CAM-10`

- [ ] **Step 2: Merge the bench branch without committing**

```bash
git merge --no-ff --no-commit claude/happy-tereshkova-f8087d
git status --short | grep -E "^(UU|AA)"
```

Expected: exactly one line, `UU docs/known-issues.md`. Everything else merges clean — the
video branch never touched the spec or the composer note.

- [ ] **Step 3: Resolve `docs/known-issues.md` by hand**

Start from the video branch's version and add the bench branch's three pieces to it:

```bash
git checkout --ours docs/known-issues.md
```

Then, in an editor, using `git show claude/happy-tereshkova-f8087d:docs/known-issues.md` as
the source of the text:

1. **K-48.** Copy the paragraph beginning `**Update — the reasoning that made respawn the sanctioned path no longer holds, and a second defect is now visible.**` (through `…which OpenHD does and this daemon does not.`) and insert it at the end of K-48's body — immediately before the `---` that precedes `### K-49 · ~~Adaptive is offered — for the rate and for the size — and nothing implements either~~ — BUILT, not yet proven on a board`.
2. **K-53.** Copy the paragraph beginning `**Update — the remedy above is the right one, and the argument for deferring it was wrong.**` (through `…report what the encoder says rather than what it was asked for — see K-48.`) and insert it at the end of K-53's body — immediately before the `---` that precedes `### K-54 · A detected camera cannot be configured from the console`. In the copied text change `(see K-54)` to `(see K-62)`.
3. **K-62.** Copy the whole entry `### K-54 · The Pi's ISP scaler is over budget in the preview branch, and drops frames to say so` (through its final `Evidence:` line) and append it at the very end of the file, after a `---` separator, with the heading changed to `### K-62 · The Pi's ISP scaler is over budget in the preview branch, and drops frames to say so`.

- [ ] **Step 4: Fix the one reference in the spec, and check the numbering**

```bash
sed -i '' 's/See also K-54\./See also K-62./' docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md
grep -c '^### K-62 · The Pi' docs/known-issues.md
grep -c '^### K-54 · A detected camera' docs/known-issues.md
grep -n 'K-54' docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md docs/hardware/ffmpeg-as-the-pipeline-composer.md | grep -v 'K-54 · A detected' || echo "no stale K-54 references"
grep -c 'see K-62' docs/known-issues.md
ls scripts/spikes/retune-bitrate-mpp.py scripts/spikes/rockchip-camera-path.py
```

Expected: `1`, `1`, `no stale K-54 references`, `1`, both files listed.

- [ ] **Step 5: Commit the merge**

```bash
git add docs/known-issues.md docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md docs/superpowers/plans/2026-09-07-rockchip-video-and-ground-station.md
git commit -s -m "docs: merge the bench record — ffmpeg cannot retune, GStreamer reaches MPP; the bench's K-54 becomes K-62; and the plan that acts on it

The spec's own 2026-09-06 addendum, the composer note and the spike scripts
arrive here. K-54 was already spent on this branch, so the ISP-scaler entry is
K-62; IDs are never reused."
git log --oneline -3
```

Expected: a merge commit on top of `40e33af`.

---

### Task 1: The probe finds Rockchip's MPP encoders through the registry

`probeEncoder` sweeps `/dev/video10`–`17` for a V4L2 memory-to-memory node. An RK3566 has
none; its encoders are reached through MPP and registered in GStreamer by
`libgstrockchipmpp.so`. The registry is asked with `gst-inspect-1.0 --exists <element>`,
which exits 0 when the element is registered and 1 when it is not (measured on the board:
`mpph264enc`, `mpph265enc`, `mppjpegdec` → 0; `v4l2h264enc`, `nosuchelement` → 1). The
answer also stops overstating itself: "no hardware encoder found" is what the probe knows.

**Files:**
- Modify: `packages/yonder-core/src/video/probe/encoder.ts`
- Test: `packages/yonder-core/src/video/probe/encoder.test.ts`
- Modify (fixtures, mechanically): `packages/yonder-core/src/video/pipeline.test.ts:33,129,154,421,457`, `video/host.test.ts:55,59`, `video/renderer.test.ts:25`, `video/adaptation.test.ts:62`, `video/encoder.test.ts:27,31`, `video/rate.test.ts:770`, `daemon/server.wiring.test.ts:54,1261,1443`, `daemon/routes.test.ts:173`, `media/config.test.ts:171`

**Interfaces:**
- Produces:
  ```ts
  export type EncoderElement = "v4l2h264enc" | "x264enc" | "mpph264enc";
  export interface Encoder {
    readonly element: EncoderElement;        // the H.264 encoder
    readonly h265: "mpph265enc" | null;       // the H.265 encoder where the board has one (R-CAM-08)
    readonly decoder: "mppjpegdec" | null;    // hardware MJPEG decode where the board has it (spec §5)
    readonly device: string | null;
    readonly hardware: boolean;
    readonly detail: string;
  }
  export const MPP_DEVICE = "/dev/mpp_service";
  export async function probeEncoder(opts?: { runner?: CommandRunner; override?: string }): Promise<Encoder>;
  ```
  The field `codec: "h264"` is removed — with two codecs it said nothing true.

- [ ] **Step 1: Write the failing tests**

Replace the `runner()` helper in `packages/yonder-core/src/video/probe/encoder.test.ts` so it also answers the registry, and add the five cases:

```ts
function runner(
  nodes: Record<string, { out: string; cap: string }>,
  registered: readonly string[] = [],
): CommandRunner {
  return async (argv) => {
    const key = argv.join(" ");
    if (argv[0] === "gst-inspect-1.0" && argv[1] === "--exists") {
      const ok = registered.includes(argv[2]);
      return { code: ok ? 0 : 1, stdout: "", stderr: "" };
    }
    for (const [node, answer] of Object.entries(nodes)) {
      if (!key.includes(node)) continue;
      if (key.includes("--list-formats-out")) return { code: 0, stdout: answer.out, stderr: "" };
      if (key.includes("--list-formats")) return { code: 0, stdout: answer.cap, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "No such file or directory" };
  };
}

it("finds Rockchip's MPP encoders through the GStreamer registry, both codecs and the decoder (R-HW-03)", async () => {
  const e = await probeEncoder({ runner: runner({}, ["mpph264enc", "mpph265enc", "mppjpegdec"]) });
  expect(e).toEqual({
    element: "mpph264enc", h265: "mpph265enc", decoder: "mppjpegdec",
    device: "/dev/mpp_service", hardware: true,
    detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
  });
});

it("reports H.264 alone when the H.265 element is not registered", async () => {
  const e = await probeEncoder({ runner: runner({}, ["mpph264enc", "mppjpegdec"]) });
  expect(e).toMatchObject({ element: "mpph264enc", h265: null, decoder: "mppjpegdec" });
  expect(e.detail).toBe("hardware H.264 through Rockchip MPP (mpph264enc)");
});

it("asks the registry before sweeping V4L2 nodes, so a Rockchip board never falls through to software", async () => {
  const asked: string[] = [];
  const inner = runner({}, ["mpph264enc"]);
  const e = await probeEncoder({ runner: async (argv) => { asked.push(argv[0]); return inner(argv); } });
  expect(e.element).toBe("mpph264enc");
  expect(asked).not.toContain("v4l2-ctl");
});

it("says it found no hardware encoder, never that the board has none (spec §8)", async () => {
  const e = await probeEncoder({ runner: runner({}) });
  expect(e).toMatchObject({ element: "x264enc", h265: null, decoder: null, hardware: false });
  expect(e.detail).toContain("no hardware encoder found");
  expect(e.detail).not.toContain("offers no");
});

it("lets an operator name the MPP encoder explicitly, bypassing the probe (R-CAM-13)", async () => {
  const e = await probeEncoder({ runner: runner({}), override: "mpph264enc" });
  expect(e).toMatchObject({
    element: "mpph264enc", h265: "mpph265enc", decoder: "mppjpegdec", device: "/dev/mpp_service", hardware: true,
  });
  expect(e.detail).toContain("named by the operator");
});
```

Also update the existing V4L2 and software expectations in that file to the new shape:
the `toMatchObject` calls at lines 33, 38 and 57 keep passing as written; add
`h265: null, decoder: null` to the software case's `toMatchObject` at line 38.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --root packages/yonder-core src/video/probe/encoder.test.ts`
Expected: the five new cases FAIL (`element` is `"x264enc"` where `"mpph264enc"` was expected; `detail` contains "offers no").

- [ ] **Step 3: Rewrite the probe**

Replace the non-comment content of `packages/yonder-core/src/video/probe/encoder.ts` with the following, keeping the file's existing doc comments about R-CAM-13, R-CAM-06 and "the direction is the test", and adding the comment shown on the MPP arm:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../../net/runner.js";

export type EncoderElement = "v4l2h264enc" | "x264enc" | "mpph264enc";

export interface Encoder {
  /** The H.264 encoder. `pipeline.ts` and the launch-line readers key on it. */
  readonly element: EncoderElement;
  /** The H.265 encoder, where the board has one (R-CAM-08); null elsewhere. */
  readonly h265: "mpph265enc" | null;
  /** The hardware MJPEG decoder, where the board has one (spec §5); null elsewhere. */
  readonly decoder: "mppjpegdec" | null;
  readonly device: string | null;
  readonly hardware: boolean;
  readonly detail: string;
}

/**
 * The node Rockchip's MPP encoders open. Informational: nothing passes it to
 * an element. It is `0600 root:root` on Armbian, and a process that cannot
 * open it sees the plugin register its *decoders* and none of its encoders,
 * silently — so a probe run as anyone but root answers "no hardware encoder
 * found" on a board that has two. `yonder-core` runs as root; the installer
 * role that proves the plugin runs as root. Recorded here because the day
 * either stops being true, this is the string that will be wrong.
 */
export const MPP_DEVICE = "/dev/mpp_service";

const CANDIDATES = Array.from({ length: 8 }, (_, i) => `/dev/video${10 + i}`);
const RAW = /'(YU12|NV12|YUYV|NV21|YV12)'/;
const H264 = /'H264'/;

const SOFTWARE: Encoder = {
  element: "x264enc", h265: null, decoder: null, device: null, hardware: false,
  // What the probe knows, and no more: it found none. "This board offers no
  // hardware encoder" was printed to operators of a board with two (spec §8).
  detail: "software H.264 (x264enc) — no hardware encoder found",
};

const MPP: Encoder = {
  element: "mpph264enc", h265: "mpph265enc", decoder: "mppjpegdec",
  device: MPP_DEVICE, hardware: true,
  detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
};

/** Whether GStreamer's registry carries `element`: `--exists` exits 0 for yes, 1 for no. */
async function registered(runner: CommandRunner, element: string): Promise<boolean> {
  const answer = await runner(["gst-inspect-1.0", "--exists", element]);
  return answer.code === 0;
}

/**
 * The Rockchip arm. An RK3566 has no V4L2 memory-to-memory node at all — its
 * two encoders and its RGA block are reached through MPP and appear in
 * GStreamer only as the `rockchipmpp` plugin's elements — so the question is
 * put to the registry, not to /dev. Asked first: a board that registers
 * `mpph264enc` is a Rockchip board whatever else it carries.
 */
async function probeMpp(runner: CommandRunner): Promise<Encoder | null> {
  if (!(await registered(runner, "mpph264enc"))) return null;
  const h265 = (await registered(runner, "mpph265enc")) ? "mpph265enc" : null;
  const decoder = (await registered(runner, "mppjpegdec")) ? "mppjpegdec" : null;
  return {
    ...MPP, h265, decoder,
    detail: h265 === null
      ? "hardware H.264 through Rockchip MPP (mpph264enc)"
      : MPP.detail,
  };
}

export async function probeEncoder(
  opts: { runner?: CommandRunner; override?: string } = {},
): Promise<Encoder> {
  if (opts.override) {
    const [element, device] = opts.override.split(":");
    if (element === "x264enc") {
      return { ...SOFTWARE, detail: "software H.264 (x264enc) — named by the operator" };
    }
    if (element === "mpph264enc") {
      return { ...MPP, detail: "hardware H.264 and H.265 through Rockchip MPP — named by the operator, not probed" };
    }
    if (element === "v4l2h264enc" && device) {
      return {
        element: "v4l2h264enc", h265: null, decoder: null, device, hardware: true,
        detail: `hardware H.264 on ${device} — named by the operator, not probed`,
      };
    }
  }
  const runner = opts.runner ?? systemRunner;
  const mpp = await probeMpp(runner);
  if (mpp !== null) return mpp;
  for (const node of CANDIDATES) {
    const out = await runner(["v4l2-ctl", "-d", node, "--list-formats-out"]);
    if (out.code !== 0 || !RAW.test(out.stdout)) continue;
    const cap = await runner(["v4l2-ctl", "-d", node, "--list-formats"]);
    if (cap.code !== 0 || !H264.test(cap.stdout)) continue;
    return {
      element: "v4l2h264enc", h265: null, decoder: null, device: node, hardware: true,
      detail: `hardware H.264 on ${node} — raw in, H.264 out`,
    };
  }
  return SOFTWARE;
}
```

- [ ] **Step 4: Run the probe tests**

Run: `npx vitest run --root packages/yonder-core src/video/probe/encoder.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Widen every fixture the compiler names**

Run: `npx tsc --noEmit -p packages/yonder-core/tsconfig.json`
Expected: errors at the fixture sites listed under **Files** (an object missing `h265`/`decoder`, or carrying `codec`). At each one, add `h265: null, decoder: null` and delete `codec: "h264"`; for example `pipeline.test.ts:33` becomes:

```ts
const HW = {
  element: "v4l2h264enc" as const, h265: null, decoder: null, device: "/dev/video11", hardware: true,
  detail: "hardware H.264 on /dev/video11",
};
```

Repeat the type-check until it is clean, then run the whole suite:

Run: `npx tsc --noEmit -p packages/yonder-core/tsconfig.json && npx vitest run --root packages/yonder-core`
Expected: clean type-check; 113 files pass.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src
git commit -s -m "feat(video): the probe finds Rockchip's MPP encoders through the registry, and stops saying a board has none — R-CAM-13, R-HW-03, R-CAM-08"
```

---

### Task 2: `codec` opens to H.265, and the ground station's receive line follows

Spec §6. The schema is `.strict()`, so `h265` is refused today at write time with the path
named. Opening it is one enum; the generated schema and shipped defaults must be regenerated
because CI checks both are current. `receive.ts` builds the ground station's own
`gst-launch` line from a `CODEC` table that knows only H.264.

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts:622`
- Modify: `packages/yonder-core/src/video/receive.ts:107-109`
- Modify: `docs/configuration.md:192` and the "Notes on specific keys" section (line 403 onward)
- Regenerate: `config/schema/yonder.schema.json`, `config/defaults/config.yaml`
- Test: `packages/yonder-core/src/schema/config.test.ts`, `packages/yonder-core/src/video/receive.test.ts`

**Interfaces:**
- Produces: `Camera["codec"]` is `"h264" | "h265"`. `receive.ts`'s `CODEC.h265 = { depay: "rtph265depay", parse: "h265parse", decode: "avdec_h265" }`.

- [ ] **Step 1: Write the failing schema test**

Append to `packages/yonder-core/src/schema/config.test.ts`. It parses the shipped default configuration and swaps in one camera, so it depends on nothing but the schema:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

describe("cameras[].codec", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const seed = parseYaml(readFileSync(join(ROOT, "config", "defaults", "config.yaml"), "utf8")) as Record<string, unknown>;
  const camera = (codec: string) => ({
    id: "cam0", name: "Nose", source: "usb",
    device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    enabled: true, autostart: false,
    width: 1280, height: 720, framerate: 30, codec, bitrate_kbps: 2000,
    preview: {
      mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
    controls: { brightness: null, contrast: null, rotation: 0 },
    outputs: [],
    stream: { mode: "fixed", floor_kbps: 2000, ceiling_kbps: 2000 },
  });

  it("accepts h265 (R-CAM-08)", () => {
    const r = ConfigSchema.safeParse({ ...seed, cameras: [camera("h265")] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cameras[0].codec).toBe("h265");
  });

  it("still defaults to h264, and still refuses a codec it does not have", () => {
    const { codec: _dropped, ...without } = camera("h264");
    const r = ConfigSchema.safeParse({ ...seed, cameras: [without] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cameras[0].codec).toBe("h264");
    const bad = ConfigSchema.safeParse({ ...seed, cameras: [camera("hevc")] });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].path).toEqual(["cameras", 0, "codec"]);
  });
});
```

If `ConfigSchema` is not already imported at the top of that file, add it to the existing import from `./config.js`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --root packages/yonder-core src/schema/config.test.ts -t "codec"`
Expected: "accepts h265" FAILS (`success` is `false`; the issue names `cameras.0.codec`).

- [ ] **Step 3: Open the enum**

In `packages/yonder-core/src/schema/config.ts:622` change

```ts
  codec: z.enum(["h264"]).default("h264"),
```

to

```ts
  // R-CAM-08. H.265 is refused by `video/pipeline.ts`'s refuse() on a board
  // whose probed encoder has none — a schema cannot know what the board in
  // front of it can encode (R-CAM-13), and a refusal with the encoder named
  // is what R-CAM-10 asks for. The interface's own copy stays H.264 whatever
  // is chosen here (R-VID-20).
  codec: z.enum(["h264", "h265"]).default("h264"),
```

- [ ] **Step 4: Run the schema tests, then regenerate what CI checks**

Run: `npx vitest run --root packages/yonder-core src/schema/config.test.ts`
Expected: PASS.

```bash
npm run schema -w yonder-core
npm run defaults -w yonder-core
git diff --stat config/
```

Expected: `config/schema/yonder.schema.json` changed (the `codec` enum gains `"h265"`); `config/defaults/config.yaml` unchanged or a comment-only diff.

- [ ] **Step 5: Write the failing receive-line test**

In `packages/yonder-core/src/video/receive.test.ts`, duplicate the test at lines 60–70 (the one asserting `rtph264depay` and `avdec_h264`) with the camera's `codec` set to `"h265"`, and these assertions in place of the H.264 ones:

```ts
    expect(gst).toContain("encoding-name=H265");
    expect(gst).toContain("rtph265depay");
    expect(gst).toContain("h265parse");
    expect(gst).toContain("avdec_h265");
    expect(gst).not.toContain("rtph264depay");
```

Name it `"writes the ground station an H.265 line when that is what leaves (R-VID-02)"`.

- [ ] **Step 6: Run it to see it fail**

Run: `npx vitest run --root packages/yonder-core src/video/receive.test.ts`
Expected: the new case FAILS — `CODEC[camera.codec]` is `undefined` and the line builder throws, or the string carries `rtph264depay`.

- [ ] **Step 7: Add the H.265 row**

In `packages/yonder-core/src/video/receive.ts:107-109`:

```ts
const CODEC = {
  h264: { depay: "rtph264depay", parse: "h264parse", decode: "avdec_h264" },
  h265: { depay: "rtph265depay", parse: "h265parse", decode: "avdec_h265" },
} as const;
```

- [ ] **Step 8: Run both test files, then the type-check**

Run: `npx vitest run --root packages/yonder-core src/video/receive.test.ts src/schema/config.test.ts && npx tsc --noEmit -p packages/yonder-core/tsconfig.json`
Expected: PASS; clean.

- [ ] **Step 9: Document it**

In `docs/configuration.md:192` change `codec: h264                    # h264 only today` to
`codec: h264                    # h264 | h265 — h265 needs a board whose encoder offers it (Rockchip); refused otherwise`.

Under `## Notes on specific keys` (line 403 onward), add before the `**\`mavlink.serial.baud: auto\`**` paragraph:

```markdown
**`cameras[].codec: h265`** encodes the ground-station stream in H.265 on a board whose
probed encoder offers it — a Rockchip board's MPP does; a Raspberry Pi's V4L2 encoder does
not, and the camera page refuses Start with the encoder named rather than letting the
pipeline die (R-CAM-08, R-CAM-10). It changes only what leaves for the ground station: the
copy the console watches is always H.264, because a browser reaches it over WebRTC
(R-VID-20). Changing it restarts the camera's pipeline and does not arm the confirmation
window. There is no control for it on the camera page yet (K-65); it is set here.
```

- [ ] **Step 10: Commit**

```bash
git add packages/yonder-core/src/schema packages/yonder-core/src/video/receive.ts packages/yonder-core/src/video/receive.test.ts config docs/configuration.md
git commit -s -m "feat(config): codec opens to h265, and the receive line follows — R-CAM-08, R-VID-02"
```

---

### Task 3: The composer builds the Rockchip line, and reads it back

`compose()` in `pipeline.ts` names `jpegdec`, `v4l2convert` and one of two encoders. On a
board whose probe answers MPP it composes what the bench measured
(`scripts/spikes/rockchip-camera-path.py`, arm *"hw decode, 2 branch, RGA preview"*, +4
points of four cores at 30 fps): `mppjpegdec`, an MPP encoder per branch carrying `bps`,
the preview scaled **inside** its encoder through `width`/`height`, no scaler element at
all. The readers that turn a running launch line back into numbers — `encodeControl`,
`encodesIn`, `shapeIn` — learn the same tokens. Every other board composes exactly what it
does today.

**Files:**
- Modify: `packages/yonder-core/src/video/pipeline.ts` — `bitrateOf` (251), `encode` (262), `sink` (314), `compose` (367), `encodeControl`, `bitrateIn`, `shapeIn`, `refuse`
- Test: `packages/yonder-core/src/video/pipeline.test.ts`

**Interfaces:**
- Consumes: `Encoder` from Task 1; `Camera["codec"]` from Task 2.
- Produces:
  ```ts
  export type EncodeKind = "v4l2h264enc" | "x264enc" | "mpph264enc" | "mpph265enc";
  export function encoderFor(encoder: Encoder, codec: Camera["codec"]): EncodeKind | null;
  export function scalesInEncoder(argv: readonly string[]): boolean;   // Task 4 reads this
  ```
  `encodeControl()` returns `{ element, property: "bps", value: "<bits>" }` for an MPP
  encode; `encodesIn()` reads `bps=` back as kb/s and the preview's size off `enc-preview`'s
  own `width=`/`height=` when no `preview-scale` capsfilter exists.

- [ ] **Step 1: Write the failing tests**

Add to `packages/yonder-core/src/video/pipeline.test.ts`, after the `HW` fixture (line 33):

```ts
const MPP = {
  element: "mpph264enc" as const, h265: "mpph265enc" as const, decoder: "mppjpegdec" as const,
  device: "/dev/mpp_service", hardware: true,
  detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
};
const mppOpts = { ...opts, encoder: MPP };
const mpp = () => compose(mppOpts);
const mppText = () => mpp().join(" ");
```

and, after the existing `describe("compose", …)` block, this new block. Import `encodeControl`, `encodesIn`, `scalesInEncoder`, `refuse` and `encoderFor` from `./pipeline.js` if they are not imported already.

```ts
describe("compose, on a Rockchip board (R-HW-03, R-CAM-07, spec §4 §5)", () => {
  it("decodes with the board's own JPEG decoder, and names no software decoder", () => {
    expect(mpp()).toContain("mppjpegdec");
    expect(mpp()).not.toContain("jpegdec");
  });

  it("scales the preview inside its encoder through RGA, with no scaler element at all", () => {
    const at = mpp().indexOf("name=enc-preview");
    expect(mpp()[at - 1]).toBe("mpph264enc");
    expect(mpp().slice(at, at + 6)).toEqual(expect.arrayContaining(["width=640", "height=360"]));
    expect(mppText()).not.toContain("v4l2convert");
    expect(mppText()).not.toContain("videoscale");
    expect(mppText()).not.toContain("videoconvert");
    expect(mppText()).not.toContain("name=preview-scale");
  });

  it("carries the bitrate in bits per second, in the encoder's own property, on both encodes", () => {
    expect(mpp()).toContain("bps=2000000");
    expect(mpp()).toContain("bps=400000");
    expect(mppText()).not.toContain("extra-controls");
    expect(mppText()).not.toContain("bitrate=");
  });

  it("runs a short GOP on the preview branch only", () => {
    expect(mpp().filter((t) => t === "gop=15")).toHaveLength(1);
    const preview = mppText().slice(mppText().indexOf("name=enc-preview"));
    expect(preview).toContain("gop=15");
  });

  it("keeps the preview's rate filter without pinning the memory the frames sit in", () => {
    // mppjpegdec hands out DMA buffers. A plain video/x-raw filter would
    // negotiate every branch off the tee back into system memory — the
    // +25-point arm the bench measured. (ANY) matches any caps feature.
    expect(mpp()).toContain("videorate");
    expect(mpp()).toContain("caps=video/x-raw(ANY),framerate=15/1");
  });

  it("welds the V4L2 level capsfilter to nothing on this board", () => {
    expect(mppText()).not.toContain("video/x-h264,level=(string)4");
  });

  it("encodes H.265 for the ground station and H.264 for the browser (R-CAM-08, R-VID-20)", () => {
    const line = compose({ ...mppOpts, camera: { ...CAMERA, codec: "h265" } });
    const text = line.join(" ");
    const stream = line.indexOf("name=enc-stream");
    const preview = line.indexOf("name=enc-preview");
    expect(line[stream - 1]).toBe("mpph265enc");
    expect(line[preview - 1]).toBe("mpph264enc");
    expect(text.slice(0, text.indexOf("tee name=main"))).toContain("h265parse");
    expect(text).toContain("rtph265pay");
    expect(text).not.toContain("rtph264pay");
    expect(text.slice(text.indexOf("name=enc-preview"))).toContain("h264parse");
  });

  it("composes the same line for a Pi as it did before this board existed", () => {
    expect(text()).toContain("jpegdec");
    expect(text()).toContain("v4l2convert");
    expect(text()).not.toContain("mpp");
    expect(text()).not.toContain("bps=");
  });
});

describe("the runtime channel's half of the launch line, on a Rockchip board", () => {
  it("builds a retune in MPP's own units", () => {
    expect(encodeControl(mpp(), "stream", 3000)).toEqual({
      element: "enc-stream", property: "bps", value: "3000000",
    });
    expect(encodeControl(mpp(), "preview", 700)).toEqual({
      element: "enc-preview", property: "bps", value: "700000",
    });
  });

  it("reads MPP's bits back as kb/s, and the preview's size off its encoder", () => {
    expect(encodesIn(mpp())).toEqual({ stream: 2000, preview: 400, shape: { size: "640x360", fps: 15 } });
  });

  it("knows when the preview is scaled inside its encoder", () => {
    expect(scalesInEncoder(mpp())).toBe(true);
    expect(scalesInEncoder(argv())).toBe(false);
  });
});

describe("refuse, for a codec the board cannot encode (R-CAM-08, R-CAM-10)", () => {
  it("refuses H.265 on a board whose encoder has none, before Start, naming the encoder", () => {
    const refusal = refuse({ ...opts, camera: { ...CAMERA, codec: "h265" } });
    expect(refusal).toContain("no H.265 encoder");
    expect(refusal).toContain("hardware H.264 on /dev/video11");
  });

  it("accepts it where the encoder offers it", () => {
    expect(refuse({ ...mppOpts, camera: { ...CAMERA, codec: "h265" } })).toBeNull();
  });

  it("answers the question compose() will ask", () => {
    expect(encoderFor(MPP, "h265")).toBe("mpph265enc");
    expect(encoderFor(MPP, "h264")).toBe("mpph264enc");
    expect(encoderFor(HW, "h265")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --root packages/yonder-core src/video/pipeline.test.ts`
Expected: the new cases FAIL (`mppjpegdec` absent; `encoderFor`/`scalesInEncoder` not exported; `bitrateOf` has no MPP case). The existing cases still PASS.

- [ ] **Step 3: Teach the composer the MPP family**

In `packages/yonder-core/src/video/pipeline.ts`, make these changes. Where a function is shown in full it replaces the existing one.

Add after `H264_LEVEL` (line 130):

```ts
type Codec = Camera["codec"];
export type EncodeKind = Encoder["element"] | "mpph265enc";

/** The parser that follows an encode. */
function parser(codec: Codec): string {
  return codec === "h265" ? "h265parse" : "h264parse";
}

/** The payloader an RTP output needs. */
function payloader(codec: Codec): string {
  return codec === "h265" ? "rtph265pay" : "rtph264pay";
}

/**
 * Which element encodes `codec` on this board, or null where it has none.
 * H.265 is a Rockchip capability (R-CAM-08): the Pi's V4L2 encoder and
 * `x264enc` are H.264 only. `refuse()` turns the null into a sentence before
 * Start; `compose()` treats reaching it as a programming error.
 */
export function encoderFor(encoder: Encoder, codec: Codec): EncodeKind | null {
  return codec === "h265" ? encoder.h265 : encoder.element;
}

/**
 * Whether this board's preview is scaled inside its encoder. On MPP the
 * encoder carries `width`/`height` and hands the resize to RGA — measured at
 * about twice a software scaler's throughput, and the whole preview branch at
 * one point of four cores. There is then no scaler element to reconfigure
 * live, which is what `encoder.ts` asks this for.
 */
function encoderScales(encoder: Encoder): boolean {
  return encoder.element === "mpph264enc";
}

/** The same question, of a launch line that is running. */
export function scalesInEncoder(argv: readonly string[]): boolean {
  const preview = elementIn(argv, ENCODE_ELEMENT.preview);
  return preview !== null && preview.kind.startsWith("mpp")
    && elementIn(argv, PREVIEW_CAPS_ELEMENT.scale) === null;
}

/**
 * The preview's rate filter, written so it does not pin the memory the
 * frames sit in. `mppjpegdec` hands out DMA buffers; a plain `video/x-raw`
 * filter on one branch negotiates every branch off the tee back into system
 * memory, which is the +25-point arm the bench measured against +4. `(ANY)`
 * matches any caps feature.
 */
function anyMemory(set: ElementProperty): ElementProperty {
  return { ...set, value: set.value.replace(/^video\/x-raw,/, "video/x-raw(ANY),") };
}
```

Replace `bitrateOf` (line 251) and `encode` (line 262):

```ts
function bitrateOf(
  kind: EncodeKind, element: string, kbps: number, shortGop: boolean,
): ElementProperty {
  switch (kind) {
    case "x264enc":
      // x264enc counts in kb/s, and its `bitrate` is settable while playing.
      return { element, property: "bitrate", value: String(kbps) };
    case "v4l2h264enc":
      return { element, property: "extra-controls", value: extraControls(kbps, shortGop) };
    case "mpph264enc":
    case "mpph265enc":
      // MPP counts in bits per second, in a plain property. Measured live on
      // an RK3566 with the real camera in front of it: 0.96 → 3.93 Mb/s on
      // both encoders, no gap after the change (retune-bitrate-mpp.py).
      return { element, property: "bps", value: String(kbps * 1000) };
  }
}

function encode(
  kind: EncodeKind, name: EncodeName, kbps: number,
  scale: { width: number; height: number } | null,
): string[] {
  const element = ENCODE_ELEMENT[name];
  const bitrate = token(bitrateOf(kind, element, kbps, SHORT_GOP[name]));
  switch (kind) {
    case "x264enc":
      return [
        "x264enc", `name=${element}`, bitrate, "speed-preset=veryfast", "tune=zerolatency",
        ...(SHORT_GOP[name] ? ["key-int-max=15"] : []),
      ];
    case "v4l2h264enc":
      return ["v4l2h264enc", `name=${element}`, bitrate, LINK, H264_LEVEL];
    case "mpph264enc":
    case "mpph265enc":
      // `gop` is the keyframe interval in frames (-1 means one per second).
      // `width`/`height` are RGA's resize inside the encoder, taken at start
      // only — set while playing they are accepted and ignored (measured).
      return [
        kind, `name=${element}`, bitrate,
        ...(SHORT_GOP[name] ? ["gop=15"] : []),
        ...(scale === null ? [] : [`width=${scale.width}`, `height=${scale.height}`]),
      ];
  }
}
```

Replace `sink` (line 314) so it takes the codec:

```ts
function sink(output: CameraOutput, rtspBase: string, cameraId: string, codec: Codec): string[] {
  switch (output.kind) {
    case "rtp":
      return [payloader(codec), "config-interval=-1", `pt=${RTP_PAYLOAD_TYPE}`, LINK,
        "udpsink", `host=${output.host}`, `port=${output.port}`, "sync=false"];
    case "rtsp":
      return ["rtspclientsink", `location=${rtspBase}/${cameraId}`, "latency=0"];
    case "srt":
      throw new Error(
        "an SRT output has no stated posture yet and is refused before composition (R-SEC-13, R-VID-06)",
      );
  }
}
```

Replace `compose` (line 367):

```ts
export function compose(opts: ComposeOptions): string[] {
  const { camera, encoder, rtspBase } = opts;
  const main = encoderFor(encoder, camera.codec);
  if (main === null) {
    throw new Error(
      `${camera.id} asks for ${camera.codec} and this board's encoder offers none; refuse() answers this before compose() is reached`,
    );
  }
  const argv: string[] = ["gst-launch-1.0", "-q"];
  const push = (...tokens: string[]): void => { argv.push(...tokens); };

  push(
    "v4l2src", `device=/dev/v4l/by-path/${camera.device}`, "io-mode=4", LINK,
    `image/jpeg,width=${camera.width},height=${camera.height},framerate=${camera.framerate}/1`, LINK,
    // Spec §5: decode in hardware where the board has it, so the frames
    // never leave the SoC between capture and encode. Measured at +3 points
    // against software's +8 for one branch, +4 against +14 for two.
    encoder.decoder ?? "jpegdec", LINK,
    ...turn(opts),
    "tee", "name=raw",
  );

  push("raw.", LINK, ...QUEUE, LINK, ...encode(main, "stream", camera.bitrate_kbps, null), LINK,
    parser(camera.codec), LINK, "tee", "name=main");
  for (const output of camera.outputs.filter((o) => o.enabled)) {
    push("main.", LINK, ...QUEUE, LINK, ...sink(output, rtspBase, camera.id, camera.codec));
  }

  const [scale, rate] = previewCaps({
    size: heldRung(camera.preview), fps: camera.preview.framerate,
  });
  // The interface's copy is always H.264, whatever the main stream carries:
  // a browser reaches it over WebRTC (R-VID-20).
  if (encoderScales(encoder)) {
    push(
      "raw.", LINK, ...QUEUE, LINK,
      "videorate", LINK,
      "capsfilter", `name=${rate.element}`, token(anyMemory(rate)), LINK,
      ...encode(encoder.element, "preview", camera.preview.bitrate_kbps, previewSize(camera.preview)), LINK,
      "h264parse", LINK,
      "rtspclientsink", `location=${rtspBase}/${camera.id}-preview`, "latency=0",
    );
  } else {
    push(
      "raw.", LINK, ...QUEUE, LINK,
      "v4l2convert", LINK,
      "capsfilter", `name=${scale.element}`, token(scale), LINK,
      "videorate", LINK,
      "capsfilter", `name=${rate.element}`, token(rate), LINK,
      ...encode(encoder.element, "preview", camera.preview.bitrate_kbps, null), LINK,
      "h264parse", LINK,
      "rtspclientsink", `location=${rtspBase}/${camera.id}-preview`, "latency=0",
    );
  }

  return argv;
}
```

In `encodeControl`, replace the kind check:

```ts
const ENCODE_KINDS: readonly string[] = ["v4l2h264enc", "x264enc", "mpph264enc", "mpph265enc"];
// …
  if (!ENCODE_KINDS.includes(found.kind)) return null;
  return bitrateOf(found.kind as EncodeKind, element, kbps, SHORT_GOP[name]);
```

In `bitrateIn`, add a third shape inside the loop over `found.props`:

```ts
    const bps = /^bps=(\d+)$/.exec(prop);
    if (bps) return Math.round(Number(bps[1]) / 1000);
```

Replace `shapeIn`:

```ts
function shapeIn(argv: readonly string[]): PreviewShape | null {
  const rate = elementIn(argv, PREVIEW_CAPS_ELEMENT.rate);
  if (rate === null) return null;
  const fps = /\bframerate=(\d+)\/1/.exec(rate.props.join(" "));
  // The size lives on the capsfilter where a scaler element does the
  // resize, and on the preview encoder itself where RGA does it inside.
  const scale = elementIn(argv, PREVIEW_CAPS_ELEMENT.scale);
  const preview = elementIn(argv, ENCODE_ELEMENT.preview);
  const size = scale !== null
    ? /\bwidth=(\d+),height=(\d+)/.exec(scale.props.join(" "))
    : preview === null ? null : /\bwidth=(\d+) height=(\d+)/.exec(preview.props.join(" "));
  if (size === null || fps === null) return null;
  const rung = `${size[1]}x${size[2]}`;
  if (!(PREVIEW_RUNGS as readonly string[]).includes(rung)) return null;
  return { size: rung as PreviewRung, fps: Number(fps[1]) };
}
```

In `refuse`, destructure `encoder` too and add, immediately after the preview-size check and before the `capabilities.formats.state` check:

```ts
  if (encoderFor(encoder, camera.codec) === null) {
    return `this board has no H.265 encoder — its encoder is ${encoder.detail}; set codec to h264, or run this camera on a board that encodes H.265 (R-CAM-08)`;
  }
```

- [ ] **Step 4: Run the composer tests, then everything**

Run: `npx vitest run --root packages/yonder-core src/video/pipeline.test.ts`
Expected: PASS — every new case and every old one.

Run: `npx tsc --noEmit -p packages/yonder-core/tsconfig.json && npx vitest run --root packages/yonder-core`
Expected: clean; 113 files pass. (`routes.ts` and `video/renderer.ts` call `compose()` with an `encoder` already; `sink()`'s new parameter is internal.)

- [ ] **Step 5: Mutation-check the two guards**

Delete the `if (encoderFor(encoder, camera.codec) === null)` block in `refuse` → `"refuses H.265 on a board whose encoder has none"` goes red. Restore. Change `anyMemory` to return `set` unchanged → `"keeps the preview's rate filter without pinning the memory"` goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/video/pipeline.ts packages/yonder-core/src/video/pipeline.test.ts
git commit -s -m "feat(video): compose the Rockchip line — MPP decode, RGA in the encoder, bps, H.265 for the ground station — R-HW-03, R-CAM-07, R-CAM-08, R-CAM-10"
```

---

### Task 4: The channel takes no live size where the encoder does the scaling

`EncoderChannel.reconfigurePreview` sets `caps` on the `preview-scale` capsfilter. On MPP
there is no such element: the encoder's own `width`/`height` do the resize through RGA, and
setting them on a playing element is accepted, logged nowhere, and ignored — 600 frames
came out at the old size (`ffmpeg-as-the-pipeline-composer.md`, "Adaptive resolution"). A
channel that reports a size it did not change is K-48's failure one layer down, so the
channel refuses it as *not controllable*, and the rate controller's existing refusal path
(`rate.ts:667`, `refusedSize` → `holdSize`) holds the rung. A rate change still moves:
`bps` is a property, and MPP takes it live.

**Files:**
- Modify: `packages/yonder-core/src/video/encoder.ts:215` (`reconfigurePreview`)
- Test: `packages/yonder-core/src/video/encoder.test.ts`

**Interfaces:**
- Consumes: `scalesInEncoder(argv)` from Task 3.
- Produces: `reconfigurePreview()` answers `{ notControllable: string }` for an MPP preview; `retune()` is unchanged.

- [ ] **Step 1: Write the failing test**

In `packages/yonder-core/src/video/encoder.test.ts`, add an MPP fixture after `SOFT` (line 31):

```ts
const MPP = {
  element: "mpph264enc" as const, h265: "mpph265enc" as const, decoder: "mppjpegdec" as const,
  device: "/dev/mpp_service", hardware: true,
  detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
};
```

and this case inside `describe("EncoderChannel.reconfigurePreview", …)`:

```ts
  it("takes no live size where the preview is scaled inside its encoder (K-48, spec §4)", async () => {
    const { channel, spawned, camera } = running({ encoder: MPP });
    const ack = await channel.reconfigurePreview(camera, { size: "854x480", fps: 15 });
    expect(ack).toEqual({
      notControllable: expect.stringContaining("scaled inside its encoder") as string,
    });
    // Nothing was sent: a request the element would silently ignore is not made.
    expect(spawned[0].sent).toHaveLength(0);
    // The rate still moves — bps is a property, and MPP takes it live.
    const pending = channel.retune(camera, "preview", 700);
    expect(spawned[0].sent[0].sets[0]).toEqual({
      element: "enc-preview", property: "bps", value: "700000",
    });
    spawned[0].answer();
    expect(await pending).toMatchObject({ requested: 700 });
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --root packages/yonder-core src/video/encoder.test.ts -t "scaled inside"`
Expected: FAIL — the channel sends a `reconfigure-preview` command and the `ack` carries `requested`/`observed`.

- [ ] **Step 3: Refuse before asking**

In `packages/yonder-core/src/video/encoder.ts`, import `scalesInEncoder` alongside what is already imported from `./pipeline.js`, and in `reconfigurePreview`, immediately after `if (argv === null) return notRunning(camera.id);`, add:

```ts
    // On MPP the preview's size is RGA's, set on the encoder at start only;
    // set while playing it is accepted and ignored (measured). Refusing it
    // here is what stops an Ack reporting a shape the picture never took.
    // The rate controller holds the rung on this refusal (rate.ts) and the
    // renderer applies a new size by restarting the camera.
    if (scalesInEncoder(argv)) {
      return {
        notControllable: `${camera.id}'s preview is scaled inside its encoder, which takes a size only when the pipeline starts; a new size is applied by restarting the camera`,
      };
    }
```

- [ ] **Step 4: Run the channel tests, then the suite**

Run: `npx vitest run --root packages/yonder-core src/video/encoder.test.ts && npx vitest run --root packages/yonder-core src/video/rate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/video/encoder.ts packages/yonder-core/src/video/encoder.test.ts
git commit -s -m "fix(video): a preview scaled inside its encoder takes no live size; the channel says so instead of claiming one — R-VID-07, R-VID-13"
```

---

### Task 5: The host reads `bps` as bits and records with the main chain's parser

Two places in `installer/payload/yonder-pipeline` assume the two encoders it has met.
`rate_of()` returns any integer property as kb/s — true of `x264enc`'s `bitrate`, false of
MPP's `bps`, which is bits per second. `record()` hangs `h264parse ! matroskamux` off the
`main` tee, which is wrong the moment the main stream is H.265. The recording branch takes
whatever parser `compose()` already put in front of the tee, read off the pipeline rather
than assumed — the host has no opinion about the line. The stand-in GStreamer the host is
tested against needs two real-API methods it did not have.

**Files:**
- Modify: `installer/payload/yonder-pipeline` — `rate_of()` (~line 692), `record()` (~line 583)
- Modify: `packages/yonder-core/src/video/fake-gi/gi/repository/__init__.py` — `Pad`, `Element`
- Test: `packages/yonder-core/src/video/host.test.ts`

**Interfaces:**
- Consumes: the MPP launch line `compose()` emits (Task 3).
- Produces: a `retune` of `bps` replies `observed` in kb/s; a `record` on an H.265 line adds `h265parse`.

- [ ] **Step 1: Write the failing tests**

In `packages/yonder-core/src/video/host.test.ts`, add after `SOFT` (line 62):

```ts
const MPP = {
  element: "mpph264enc" as const, h265: "mpph265enc" as const, decoder: "mppjpegdec" as const,
  device: "/dev/mpp_service", hardware: true,
  detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
};
const RETUNE_MPP = [{ element: "enc-stream", property: "bps", value: "3000000" }];
```

Inside `describe("the pipeline host answers for what the encoder is running", …)`:

```ts
  it("reports an MPP encoder's bits per second as the kb/s the channel reads", async () => {
    const host = startHost(argvFor(CAMERA, MPP).slice(1));
    await host.flowing();
    expect(await host.ask({ id: 8, camera: "cam0", op: "retune", sets: RETUNE_MPP }))
      .toMatchObject({ id: 8, continuous: true, observed: 3000 });
    const set = host.traced().find((e) => e.event === "set_arg" && e.property === "bps");
    expect(set).toMatchObject({ element: "enc-stream", value: "3000000" });
  }, 20_000);
```

Inside `describe("the pipeline host records off the encoded tee", …)`:

```ts
  it("carries the main chain's own parser, so an H.265 stream records as H.265 (R-CAM-17, R-CAM-08)", async () => {
    const host = startHost(argvFor({ ...CAMERA, codec: "h265" }, MPP).slice(1));
    await host.flowing();
    const path = join(dir, "flight.mkv");
    expect(await host.ask({ id: 30, camera: "cam0", op: "record", path })).toMatchObject({ id: 30 });
    const added = host.traced().filter((e) => e.event === "add_element").map((e) => e.kind);
    expect(added).toContain("h265parse");
    expect(added).not.toContain("h264parse");
    await host.ask({ id: 31, camera: "cam0", op: "record-stop" });
  }, 20_000);
```

Inside `describe("EncoderChannel over the real host", …)`:

```ts
  it("speaks MPP's bits per second all the way to the element and back", async () => {
    const { channel, ready, stop } = board(MPP);
    await ready();
    expect(await channel.retune(CAMERA, "stream", 3000)).toMatchObject({
      requested: 3000, observed: 3000, continuous: true,
    });
    stop();
  }, 20_000);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --root packages/yonder-core src/video/host.test.ts -t "MPP|H.265"`
Expected: the `bps` cases FAIL with `observed: 3000000`; the H.265 case FAILS with `h264parse` in the added elements. If instead the host dies parsing the line, the stand-in's `Caps.from_string` rejected the `(ANY)` caps feature on the preview's rate filter — in `fake-gi/gi/repository/__init__.py` make `Caps.from_string` strip a `(…)` suffix from the media type before it reads the fields (`re.sub(r"\([^)]*\)", "", media)`), which is all a stand-in needs to know about caps features.

- [ ] **Step 3: Give the stand-in the two real-API methods**

In `packages/yonder-core/src/video/fake-gi/gi/repository/__init__.py`:

On `class Pad`, add:

```python
    def get_parent_element(self):
        """`Gst.Pad.get_parent_element` — the element this pad belongs to."""
        return self.element
```

Before `class Element`, add:

```python
class _Factory(object):
    """`Gst.ElementFactory`, as far as `get_name()` — the kind an element was
    made as, which is the one thing the host reads off it."""
    def __init__(self, kind):
        self.kind = kind

    def get_name(self):
        return self.kind
```

On `class Element`, add:

```python
    def get_factory(self):
        return _Factory(self.kind)
```

- [ ] **Step 4: Teach the host**

In `installer/payload/yonder-pipeline`, in `rate_of()`, replace

```python
            if isinstance(value, int):
                return value
```

with

```python
            if isinstance(value, int):
                # Two encoders count in kb/s in a plain property (`x264enc`'s
                # `bitrate`); Rockchip's MPP counts in bits per second
                # (`bps`). The property's name says which, and it is the same
                # name `pipeline.ts`'s `bitrateOf()` wrote.
                return int(round(value / 1000.0)) if one.get("property") == "bps" else value
```

Add a method beside `record()`:

```python
    def parser_kind(self):
        """
        The parser the main chain already carries — `h264parse` or
        `h265parse`, whichever `compose()` put in front of the `main` tee.
        A recording writes what the encoder made (R-CAM-17), so it takes the
        same parser rather than assuming H.264; the element feeding the tee
        is looked up and its factory named. Anything that cannot be read
        answers `h264parse`, which is every pipeline before H.265 existed.
        """
        tee = self.pipeline.get_by_name(MAIN_TEE)
        sink = None if tee is None else tee.get_static_pad("sink")
        peer = None if sink is None else sink.get_peer()
        feed = None if peer is None else peer.get_parent_element()
        factory = None if feed is None else feed.get_factory()
        kind = "" if factory is None else factory.get_name()
        return "h265parse" if kind == "h265parse" else "h264parse"
```

and in `record()` replace `("h264parse", {}),` with `(self.parser_kind(), {}),`. Update the docstring's *"writing the H.264 the encoder has already made"* to *"writing what the encoder has already made, H.264 or H.265"*.

- [ ] **Step 5: Run the host tests, then the suite**

Run: `npx vitest run --root packages/yonder-core src/video/host.test.ts`
Expected: PASS — the new cases and every existing one, including `"hangs off main, so it writes H.264 the encoder already made"` (an H.264 line still adds `h264parse`).

Run: `npx vitest run --root packages/yonder-core`
Expected: 113 files pass.

- [ ] **Step 6: Mutation-check**

Change `parser_kind()` to return `"h264parse"` unconditionally → the H.265 recording test goes red. Restore. Remove the `/ 1000.0` branch → both `bps` tests go red. Restore.

- [ ] **Step 7: Commit**

```bash
git add installer/payload/yonder-pipeline packages/yonder-core/src/video/fake-gi packages/yonder-core/src/video/host.test.ts
git commit -s -m "fix(video): the host reads bps as bits and records with the parser the main chain carries — R-VID-07, R-CAM-17, R-CAM-08"
```

---

### Task 6: The payload carries MPP, librga and the plugin, built from pinned commits

Spec §3 chose one `.deb` because it believed the GStreamer route needed carried patches. It
does not: the plugin configures against GStreamer 1.26.2 unpatched, and the bench built all
three pieces on the board. Delivery is the one column the GStreamer route loses, and this
task pays it the way `mavlink-router` already does — a container build for `linux/arm64`
from pinned commits, staged into `vendor/`, fingerprinted by the commit. Along the way the
`--only <component>` summary stops dying on `ZT_DEB` (K-64).

**Files:**
- Modify: `installer/make-payload.sh` — pins after line 108, `COMPONENTS` (111), usage (112-140), a new block before `if wanted console`, the summary (589-592)
- Modify: `.github/workflows/ci.yml` — a job after `payload-mavlink-router`
- Test: `packages/yonder-core/src/installer.test.ts`

**Interfaces:**
- Produces: `vendor/gst-rockchip/lib/{librockchip_mpp.so.0, librockchip_mpp.so.1 → .so.0, librockchip_mpp.so → .so.1, librga.so.2, librga.so → .so.2}`, `vendor/gst-rockchip/gstreamer-1.0/libgstrockchipmpp.so`, `vendor/gst-rockchip/MANIFEST`, `vendor/gst-rockchip/inspect.txt`. Task 7's role consumes exactly these paths.

- [ ] **Step 1: Write the failing tests**

Append to `packages/yonder-core/src/installer.test.ts`:

```ts
describe("installer/make-payload.sh stages gst-rockchip", () => {
  const script = readFileSync(join(ROOT, "installer", "make-payload.sh"), "utf8");

  it("pins each of the three sources to a full commit", () => {
    for (const name of ["MPP_COMMIT", "LIBRGA_COMMIT", "GST_ROCKCHIP_COMMIT"]) {
      expect(script).toMatch(new RegExp(`^${name}=\\$\\{${name}:-[0-9a-f]{40}\\}$`, "m"));
    }
  });

  it("lists it as a component, staged before the console", () => {
    expect(script).toMatch(/^COMPONENTS="node zerotier mavlink-router gst-rockchip console"$/m);
  });

  it("stages it only for arm64, which is every Rockchip board there is", () => {
    expect(script).toContain('if [ "$ARCH" != "linux-arm64" ]');
  });

  it("proves the built plugin registers before staging it", () => {
    expect(script).toContain("gst-inspect-1.0 rockchipmpp");
    expect(script).toContain("grep -q mppjpegdec");
  });

  it("never reads a variable in the summary that only one component sets (K-64)", () => {
    const summary = script.slice(script.indexOf('step "done"'));
    expect(summary).not.toContain("$ZT_DEB");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --root packages/yonder-core src/installer.test.ts -t "gst-rockchip"`
Expected: FAIL on every case but the last, which also FAILS (`$ZT_DEB` is in the summary today).

- [ ] **Step 3: Add the pins, the component and the usage lines**

In `installer/make-payload.sh`, after `MAVLINK_ROUTER_IMAGE=…` (line 108) add:

```sh
# gstreamer-rockchip, and the two libraries it links: the second component
# that is *built* rather than downloaded, for mavlink-router's reason — no
# repository a board has carries any of the three, Debian or Armbian, and the
# vendor publishes no binary for trixie. Rejected on the way here, so they are
# not revisited: the vendor's prebuilt plugin (bullseye, GStreamer 1.14, not
# guaranteed against 1.26), and building on the board (nine build packages
# and a from-source MPP on a 1.9 GB board — done once by hand for the bench,
# not a thing an installer does).
#
# Three pins, one commit each, fingerprinted as mavlink-router's is: a commit
# is a hash over the whole tree. These are what the bench built on 2026-09-06:
# mpph264enc and mpph265enc both encode clean, decodable streams and take a
# live bitrate change with no gap. See docs/hardware/ffmpeg-as-the-pipeline-composer.md.
MPP_COMMIT=${MPP_COMMIT:-0986d01294d5c2449c14cf13af9b740368c33967}
MPP_REPO=${MPP_REPO:-https://github.com/rockchip-linux/mpp}
# librga ships its library already built under libs/Linux/gcc-aarch64/; its
# headers and a pkg-config file are what turn the plugin's `rga` option on,
# which is what puts `width`/`height` on the encoders (spec §4).
LIBRGA_COMMIT=${LIBRGA_COMMIT:-2b32edcb97b601b25683e2941d888c8515da6d55}
LIBRGA_REPO=${LIBRGA_REPO:-https://github.com/airockchip/librga}
# rockchip-linux/gstreamer-rockchip is a 404; JeffyCN's mirror carries it on
# a branch of that name, committed to twelve days before the bench built it.
GST_ROCKCHIP_COMMIT=${GST_ROCKCHIP_COMMIT:-a0d45af504099b4b82f3d3377019a63d357e7cef}
GST_ROCKCHIP_REPO=${GST_ROCKCHIP_REPO:-https://github.com/JeffyCN/mirrors}
GST_ROCKCHIP_BRANCH=${GST_ROCKCHIP_BRANCH:-gstreamer-rockchip}
GST_ROCKCHIP_IMAGE=${GST_ROCKCHIP_IMAGE:-debian:trixie}
```

Change line 111 to `COMPONENTS="node zerotier mavlink-router gst-rockchip console"`. In `usage()`, change the `--only LIST` text to name `node, zerotier, mavlink-router, gst-rockchip, console` and add under *Produces*:

```
  DIR/gst-rockchip/gstreamer-1.0/libgstrockchipmpp.so   Rockchip's encoders, for GStreamer
  DIR/gst-rockchip/lib/                                   MPP and librga, which it links
```

- [ ] **Step 4: Add the build block**

Immediately before `if wanted console; then`, add:

```sh
if wanted gst-rockchip; then
    if [ "$ARCH" != "linux-arm64" ]; then
        step "gst-rockchip: not for $ARCH"
        log "every Rockchip board is arm64; an $ARCH payload carries no MPP plugin and the role skips it"
    else
    GR_PINS="MPP $(printf '%s' "$MPP_COMMIT" | cut -c1-7), librga $(printf '%s' "$LIBRGA_COMMIT" | cut -c1-7), plugin $(printf '%s' "$GST_ROCKCHIP_COMMIT" | cut -c1-7)"
    step "gst-rockchip: $GR_PINS for $ARCH"
    command -v git >/dev/null 2>&1 || die "git is needed to fetch the Rockchip sources"
    GR_ENGINE=$(command -v docker 2>/dev/null || command -v podman 2>/dev/null || true)
    [ -n "$GR_ENGINE" ] || die "no docker or podman here, and gst-rockchip is a source build.
  install Docker or Podman, or stage the rest with:
    make-payload.sh --arch $ARCH --only node,zerotier,mavlink-router,console
  and expect a Rockchip board to encode in software."
    GR="$WORK/gst-rockchip"
    rm -rf "$GR"
    mkdir -p "$GR"
    # repo commit dir [branch]. The commit is the fingerprint; the checkout
    # is verified to be it, exactly as mavlink-router's is above.
    gr_fetch() {
        if [ -n "${4:-}" ]; then
            git clone --quiet --branch "$4" "$1" "$3" || die "could not clone $1 ($4)"
        else
            git clone --quiet "$1" "$3" || die "could not clone $1"
        fi
        git -C "$3" checkout --quiet --detach "$2" || die "$2 is not a commit in $1"
        gr_head=$(git -C "$3" rev-parse HEAD)
        [ "$gr_head" = "$2" ] || die "the checkout of $1 is at $gr_head, not the pinned $2"
        log "$(basename "$3") is $gr_head, exactly the pinned commit"
    }
    gr_fetch "$MPP_REPO" "$MPP_COMMIT" "$GR/mpp"
    gr_fetch "$LIBRGA_REPO" "$LIBRGA_COMMIT" "$GR/librga"
    gr_fetch "$GST_ROCKCHIP_REPO" "$GST_ROCKCHIP_COMMIT" "$GR/plugin" "$GST_ROCKCHIP_BRANCH"
    [ -f "$GR/librga/libs/Linux/gcc-aarch64/librga.so" ] \
        || die "librga at $LIBRGA_COMMIT carries no libs/Linux/gcc-aarch64/librga.so"
    log "building in $GST_ROCKCHIP_IMAGE for $OCI_PLATFORM; MPP is a large C build, so give it several minutes"
    # shellcheck disable=SC2016 # GR_OWNER is expanded by the container's shell, not this one
    "$GR_ENGINE" run --rm --platform "$OCI_PLATFORM" \
        -v "$GR:/src" -w /src \
        -e DEBIAN_FRONTEND=noninteractive \
        -e "GR_OWNER=$(id -u):$(id -g)" \
        "$GST_ROCKCHIP_IMAGE" sh -c '
            set -eu
            apt-get update -qq
            apt-get install -y --no-install-recommends \
                build-essential cmake meson ninja-build pkg-config git ca-certificates \
                libdrm-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
                gstreamer1.0-tools >/dev/null
            git config --global --add safe.directory "*"
            lib=/usr/lib/aarch64-linux-gnu
            # MPP, installed into the container so the plugin can link it.
            cmake -S /src/mpp -B /src/mpp/build -DCMAKE_BUILD_TYPE=Release \
                -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR=lib/aarch64-linux-gnu \
                -DBUILD_TEST=OFF >/dev/null
            make -C /src/mpp/build -j"$(nproc)" install >/dev/null
            # librga, already built by its authors; the headers and a
            # pkg-config file are what the plugin build asks for.
            install -m 0644 /src/librga/libs/Linux/gcc-aarch64/librga.so "$lib/librga.so.2"
            ln -sf librga.so.2 "$lib/librga.so"
            mkdir -p /usr/include/rga
            cp -r /src/librga/include/. /usr/include/rga/
            printf "prefix=/usr\nlibdir=%s\nincludedir=/usr/include/rga\n\nName: librga\nDescription: Rockchip RGA 2D raster graphic acceleration\nVersion: 1.10.6\nLibs: -L%s -lrga\nCflags: -I/usr/include/rga\n" \
                "$lib" "$lib" > "$lib/pkgconfig/librga.pc"
            ldconfig
            # The plugin, with only the MPP element set: rkximage wants X11
            # and kmssrc a display, and neither is on an aircraft.
            meson setup /src/plugin/build /src/plugin --prefix=/usr --libdir=lib/aarch64-linux-gnu \
                --buildtype=release -Drockchipmpp=enabled -Drga=enabled \
                -Drkximage=disabled -Dkmssrc=disabled -Dvpxalphadec=disabled >/dev/null
            ninja -C /src/plugin/build >/dev/null
            strip /src/plugin/build/gst/rockchipmpp/libgstrockchipmpp.so
            # It registers. Without /dev/mpp_service the encoders stay
            # unregistered and only the decoders show, so the decoder is what
            # is asked for here; the role asks for the encoders on the board.
            GST_PLUGIN_PATH=/src/plugin/build/gst/rockchipmpp gst-inspect-1.0 rockchipmpp > /src/inspect.txt
            grep -q mppjpegdec /src/inspect.txt
            mkdir -p /src/out/lib /src/out/gstreamer-1.0
            cp -a "$lib"/librockchip_mpp.so* /src/out/lib/
            cp -a "$lib"/librga.so* /src/out/lib/
            cp /src/plugin/build/gst/rockchipmpp/libgstrockchipmpp.so /src/out/gstreamer-1.0/
            chown -R "$GR_OWNER" /src
        ' || die "the gst-rockchip build failed in $GST_ROCKCHIP_IMAGE for $OCI_PLATFORM.
If it stopped at 'exec format error', this host cannot run $OCI_PLATFORM containers:
register the emulation handlers (Linux: qemu-user-static and binfmt-support) and try again."
    [ -f "$GR/out/gstreamer-1.0/libgstrockchipmpp.so" ] || die "the build reported success and produced no plugin"
    grep -q mppjpegdec "$GR/inspect.txt" || die "the built plugin registers no mppjpegdec; it is not the plugin"
    rm -rf "$OUT/gst-rockchip"
    mkdir -p "$OUT/gst-rockchip"
    cp -a "$GR/out/lib" "$OUT/gst-rockchip/lib"
    cp -a "$GR/out/gstreamer-1.0" "$OUT/gst-rockchip/gstreamer-1.0"
    cp "$GR/inspect.txt" "$OUT/gst-rockchip/inspect.txt"
    {
        printf 'mpp %s %s\n' "$MPP_COMMIT" "$MPP_REPO"
        printf 'librga %s %s\n' "$LIBRGA_COMMIT" "$LIBRGA_REPO"
        printf 'gstreamer-rockchip %s %s %s\n' "$GST_ROCKCHIP_COMMIT" "$GST_ROCKCHIP_REPO" "$GST_ROCKCHIP_BRANCH"
        if [ -n "$SHA_SUM" ]; then
            find "$OUT/gst-rockchip" -type f -name '*.so*' | sort | while read -r f; do
                printf 'sha256 %s %s\n' "$($SHA_SUM "$f" | cut -d' ' -f1)" "${f#"$OUT/gst-rockchip/"}"
            done
        fi
    } > "$OUT/gst-rockchip/MANIFEST"
    log "staged $OUT/gst-rockchip ($GR_PINS)"
    cat "$OUT/gst-rockchip/MANIFEST" | while read -r line; do log "  $line"; done
    fi
fi
```

- [ ] **Step 5: Fix the summary (K-64)**

Replace line 591, `log "zerotier: $OUT/zerotier/$ZT_DEB"`, with:

```sh
log "zerotier: $(ls "$OUT"/zerotier/zerotier-one_*.deb 2>/dev/null | head -1 || printf 'none staged')"
log "gst-rockchip: $([ -f "$OUT/gst-rockchip/gstreamer-1.0/libgstrockchipmpp.so" ] && printf '%s' "$OUT/gst-rockchip/gstreamer-1.0/libgstrockchipmpp.so" || printf 'none staged')"
```

- [ ] **Step 6: Lint and test the script**

```bash
shellcheck installer/make-payload.sh
npx vitest run --root packages/yonder-core src/installer.test.ts -t "gst-rockchip"
./installer/make-payload.sh --arch linux-arm64 --only mavlink-router 2>&1 | tail -4
```

Expected: shellcheck clean; the five cases PASS; the last command's tail names the staged router and gst-rockchip as `none staged` — and no `unbound variable`.

- [ ] **Step 7: Build it**

```bash
./installer/make-payload.sh --arch linux-arm64 --only gst-rockchip 2>&1 | tail -15
ls -la vendor/gst-rockchip/lib vendor/gst-rockchip/gstreamer-1.0
cat vendor/gst-rockchip/MANIFEST
grep -E "mpp(h264enc|h265enc|jpegdec)" vendor/gst-rockchip/inspect.txt
```

Expected (several minutes; native on an arm64 Mac): the three "exactly the pinned commit" lines; `staged …/gst-rockchip`; `lib/` holds `librockchip_mpp.so.0` (a file of roughly 3 MB), `.so.1` and `.so` as symlinks, `librga.so.2` (~292 KB) and `librga.so`; `gstreamer-1.0/libgstrockchipmpp.so` (~600 KB); the MANIFEST's three commit lines and one sha256 per real file; `inspect.txt` lists `mppjpegdec` (the encoders are absent — the container has no `/dev/mpp_service`, and that is expected). If `lib/` names a different real file than `librockchip_mpp.so.0`, that is what MPP's `SOVERSION` is at this commit — the role and the CI check below glob rather than name it, so nothing else changes.

- [ ] **Step 8: The CI job**

In `.github/workflows/ci.yml`, after the `payload-mavlink-router` job, add:

```yaml
  # MPP, librga and gstreamer-rockchip, built for the board that has the
  # hardware. No repository packages them (R-HW-03, R-CFG-07); the pins and
  # the recipe live in installer/make-payload.sh, so as for mavlink-router
  # only a change to that file rebuilds this.
  payload-gst-rockchip:
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Decide whether anything in this change could alter the plugin
        id: scope
        run: |
          if [ "${{ github.event_name }}" != "pull_request" ]; then
            echo "not a pull request; building"
            echo "run=true" >> "$GITHUB_OUTPUT"; exit 0
          fi
          base=$(git merge-base "origin/${{ github.base_ref }}" HEAD)
          if git diff --name-only "$base"...HEAD | grep -qxF 'installer/make-payload.sh'; then
            echo "the pins or the recipe changed; building"
            echo "run=true" >> "$GITHUB_OUTPUT"
          else
            echo "nothing that feeds this build changed; skipping it"
            echo "run=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Set up the emulation an arm64 container needs
        if: steps.scope.outputs.run == 'true'
        uses: docker/setup-qemu-action@v3
      - name: Build MPP, librga and the plugin from the pinned commits
        if: steps.scope.outputs.run == 'true'
        run: ./installer/make-payload.sh --arch linux-arm64 --only gst-rockchip
      # Every real object staged is an aarch64 ELF. 183 is aarch64; the check
      # is the one 52-gst-rockchip.sh makes on the board, exercised where the
      # answer is known.
      - name: They are aarch64 objects
        if: steps.scope.outputs.run == 'true'
        run: |
          find vendor/gst-rockchip -type f -name '*.so*' | while read -r f; do
            m=$(/bin/sh -c '. ./installer/lib/common.sh; elf_machine "$1"' sh "$f")
            echo "$f: ELF e_machine $m"
            [ "$m" = "183" ] || { echo "::error::$f is not an aarch64 object"; exit 1; }
          done
      - uses: actions/upload-artifact@v4
        if: steps.scope.outputs.run == 'true'
        with:
          name: gst-rockchip-arm64
          path: vendor/gst-rockchip
          if-no-files-found: error
```

- [ ] **Step 9: Commit**

```bash
git add installer/make-payload.sh .github/workflows/ci.yml packages/yonder-core/src/installer.test.ts
git commit -s -m "feat(installer): the payload carries MPP, librga and gstreamer-rockchip, built from pinned commits — R-HW-03, R-CFG-07; and --only no longer dies on ZT_DEB (K-64)"
```

`vendor/` is git-ignored; nothing built is committed.

---

### Task 7: A role installs the plugin where the hardware is, and the media role installs what every board needs

`52-gst-rockchip.sh` puts the three objects where GStreamer looks, refreshes the loader,
drops the registry cache, and proves the registry resolves the three elements the probe
asks for — only on a board with `/dev/mpp_service`, only from a payload that carries them.
`50-mediamtx.sh` today installs `gstreamer1.0-rtsp` alone and checks one element only when
`gst-inspect-1.0` happens to exist; both Radxa notes record that `gst-inspect-1.0` and
`x264enc` were installed by no role. Spec §10: every package the composer relies on is
installed by a role, and every board-independent element is resolved.

**Files:**
- Create: `installer/roles/52-gst-rockchip.sh`
- Modify: `installer/lib/common.sh` (after the `YONDER_MAVLINK_ETC` default, line 45)
- Modify: `installer/roles/50-mediamtx.sh:17-36`
- Test: `packages/yonder-core/src/installer.test.ts` (existing assertions at lines 247 and 251 change)

**Interfaces:**
- Consumes: `vendor/gst-rockchip/{lib,gstreamer-1.0}` from Task 6; `elf_machine`, `ensure_pkgs`, `ensure_dir`, `run`, `log`, `die` from `common.sh`.
- Produces: env-overridable defaults `YONDER_MPP_DEVICE`, `YONDER_GST_LIBDIR`, `YONDER_GST_PLUGIN_DIR`, `YONDER_GST_REGISTRY_DIRS`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/yonder-core/src/installer.test.ts`:

```ts
describe("installer/roles/52-gst-rockchip.sh", () => {
  const GR_ROLE = join(ROOT, "installer", "roles", "52-gst-rockchip.sh");

  /** An ELF header for `machine`, as a staged shared object would begin. */
  function elfObject(machine: number): Buffer {
    const h = Buffer.alloc(64);
    h.write("\x7fELF", 0, "binary");
    h[4] = 2;
    h[5] = 1;
    h[6] = 1;
    h.writeUInt16LE(3, 16);
    h.writeUInt16LE(machine, 18);
    return h;
  }
  /** dpkg says every package is present, apt has no network, ldconfig and gst-inspect record what they were asked. */
  function stubs(opts: { unresolved?: string[] } = {}): { path: string; log: string } {
    const bin = join(dir, "grbin");
    const log = join(dir, "gr.log");
    mkdirSync(bin, { recursive: true });
    const record = (name: string, body: string) => writeFileSync(join(bin, name), [
      "#!/bin/sh",
      `printf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'`,
      body,
      "",
    ].join("\n"), { mode: 0o755 });
    record("dpkg-query", 'printf "install ok installed\\n"; exit 0');
    record("apt-get", 'printf "the network is not here\\n" >&2; exit 100');
    record("ldconfig", "exit 0");
    const cases = (opts.unresolved ?? []).map((e) => `*"${e}"*) exit 1 ;;`).join(" ");
    record("gst-inspect-1.0", `case "$*" in ${cases} *) exit 0 ;; esac`);
    writeFileSync(log, "");
    return { path: `${bin}:${process.env.PATH ?? ""}`, log };
  }
  function payload(opts: { plugin?: Buffer } = {}): string {
    const src = join(dir, "src");
    const lib = join(src, "vendor", "gst-rockchip", "lib");
    const plug = join(src, "vendor", "gst-rockchip", "gstreamer-1.0");
    mkdirSync(lib, { recursive: true });
    mkdirSync(plug, { recursive: true });
    writeFileSync(join(lib, "librockchip_mpp.so.0"), elfObject(183));
    symlinkSync("librockchip_mpp.so.0", join(lib, "librockchip_mpp.so.1"));
    symlinkSync("librockchip_mpp.so.1", join(lib, "librockchip_mpp.so"));
    writeFileSync(join(lib, "librga.so.2"), elfObject(183));
    symlinkSync("librga.so.2", join(lib, "librga.so"));
    writeFileSync(join(plug, "libgstrockchipmpp.so"), opts.plugin ?? elfObject(183));
    return src;
  }
  function board() {
    const libdir = join(dir, "usr-lib");
    const registry = join(dir, "gst-cache");
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, "registry.aarch64.bin"), "stale");
    const reference = join(dir, "reference-elf");
    writeFileSync(reference, elfObject(183));
    return { libdir, plugindir: join(libdir, "gstreamer-1.0"), registry, reference };
  }
  function runRole(opts: { src: string; path: string; device: string; board: ReturnType<typeof board>; dryRun?: boolean }) {
    return sh(
      `set -eu; . '${COMMON}'; . '${GR_ROLE}'`,
      {
        DRY_RUN: opts.dryRun === true ? "1" : "0",
        YONDER_SRC: opts.src,
        YONDER_MPP_DEVICE: opts.device,
        YONDER_GST_LIBDIR: opts.board.libdir,
        YONDER_GST_PLUGIN_DIR: opts.board.plugindir,
        YONDER_GST_REGISTRY_DIRS: opts.board.registry,
        YONDER_ELF_REFERENCE: opts.board.reference,
      },
      opts.path,
    );
  }
  // /dev/null is a character device on every Unix; a Rockchip board is told
  // apart by the character device MPP opens, so it stands in for one here.
  const ROCKCHIP = "/dev/null";

  it("skips, and says how to build one, when the payload carries no plugin", () => {
    const src = join(dir, "bare-src");
    mkdirSync(src, { recursive: true });
    const r = runRole({ src, path: stubs().path, device: ROCKCHIP, board: board() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("no gst-rockchip in the payload; skipping");
    expect(r.out).toContain("--only gst-rockchip");
  });

  it("leaves a board with no MPP device alone, and says why (R-HW-04)", () => {
    const b = board();
    const { path, log } = stubs();
    const r = runRole({ src: payload(), path, device: join(dir, "no-such-node"), board: b });
    expect(r.code).toBe(0);
    expect(r.out).toContain("not a Rockchip board");
    expect(existsSync(join(b.plugindir, "libgstrockchipmpp.so"))).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("ldconfig");
  });

  it("installs the libraries and the plugin where GStreamer looks, refreshes the loader and drops the registry cache", () => {
    const b = board();
    const { path, log } = stubs();
    const r = runRole({ src: payload(), path, device: ROCKCHIP, board: b });
    expect(r.code).toBe(0);
    expect(existsSync(join(b.plugindir, "libgstrockchipmpp.so"))).toBe(true);
    expect(existsSync(join(b.libdir, "librockchip_mpp.so.0"))).toBe(true);
    expect(lstatSync(join(b.libdir, "librockchip_mpp.so.1")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(b.libdir, "librga.so.2"))).toBe(true);
    expect(existsSync(join(b.registry, "registry.aarch64.bin"))).toBe(false);
    const asked = readFileSync(log, "utf8");
    expect(asked).toContain("ldconfig");
    for (const element of ["mpph264enc", "mpph265enc", "mppjpegdec"]) {
      expect(asked).toContain(`gst-inspect-1.0 --exists ${element}`);
    }
    expect(r.out).toContain("probeEncoder will find them");
  });

  it("dies naming the element the registry does not resolve, and names the permission trap", () => {
    const r = runRole({ src: payload(), path: stubs({ unresolved: ["mpph265enc"] }).path, device: ROCKCHIP, board: board() });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not resolve mpph265enc");
    expect(r.out).toContain("decoders and no encoders");
  });

  it("refuses a plugin built for another architecture, naming both", () => {
    const r = runRole({ src: payload({ plugin: elfObject(62) }), path: stubs().path, device: ROCKCHIP, board: board() });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ELF machine 62");
    expect(r.out).toContain("183");
  });

  it("says what it would do on a dry run, and touches nothing", () => {
    const b = board();
    const r = runRole({ src: payload(), path: stubs().path, device: ROCKCHIP, board: b, dryRun: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("would check that GStreamer resolves");
    expect(existsSync(join(b.plugindir, "libgstrockchipmpp.so"))).toBe(false);
    expect(existsSync(join(b.registry, "registry.aarch64.bin"))).toBe(true);
  });

  it("installs libdrm2 and the tools package from Debian, not the payload", () => {
    expect(readFileSync(GR_ROLE, "utf8")).toMatch(/^ensure_pkgs libdrm2 gstreamer1\.0-tools$/m);
  });
});

describe("installer/roles/50-mediamtx.sh installs what every pipeline is made of (spec §10)", () => {
  const role = readFileSync(join(ROOT, "installer", "roles", "50-mediamtx.sh"), "utf8");
  const ensure = role.slice(role.indexOf("ensure_pkgs gstreamer1.0-tools"), role.indexOf("gstreamer1.0-rtsp") + "gstreamer1.0-rtsp".length);

  it("names every GStreamer package the composer relies on, on every board", () => {
    for (const pkg of ["gstreamer1.0-tools", "gstreamer1.0-plugins-base", "gstreamer1.0-plugins-good",
      "gstreamer1.0-plugins-bad", "gstreamer1.0-plugins-ugly", "gstreamer1.0-rtsp"]) {
      expect(ensure).toContain(pkg);
    }
  });

  it("resolves every board-independent element compose() can name, and dies on the first it cannot", () => {
    // The list in video/pipeline.ts, minus the elements a board's own plugin
    // provides (v4l2convert and v4l2h264enc on a Pi; the MPP elements on
    // Rockchip, which 52-gst-rockchip.sh checks).
    for (const element of ["rtspclientsink", "v4l2src", "jpegdec", "videoflip", "tee", "queue", "capsfilter",
      "videorate", "videoconvert", "videoscale", "h264parse", "h265parse", "rtph264pay", "rtph265pay",
      "udpsink", "x264enc", "jpegenc", "matroskamux", "filesink"]) {
      expect(role).toContain(element);
    }
    expect(role).toContain('gst-inspect-1.0 --exists "$mtx_element"');
    expect(role).toContain("|| die");
  });

  it("no longer takes the weaker branch when gst-inspect-1.0 is absent — it dies", () => {
    expect(role).not.toContain("no gst-inspect-1.0 here to resolve");
    expect(role).toContain("still no gst-inspect-1.0");
  });
});
```

`lstatSync` must be added to the `node:fs` import at line 73 if it is not there.

Then change the two existing assertions in the `50-mediamtx.sh` block: line 247's
`expect(role).toMatch(/^ensure_pkgs gstreamer1\.0-rtsp$/m);` becomes
`expect(role).toMatch(/^ensure_pkgs gstreamer1\.0-tools gstreamer1\.0-plugins-base gstreamer1\.0-plugins-good \\$/m);`
and line 251's `expect(role).toContain("gst-inspect-1.0 rtspclientsink");` becomes
`expect(role).toContain("rtspclientsink v4l2src");`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --root packages/yonder-core src/installer.test.ts -t "52-gst-rockchip|installs what every pipeline"`
Expected: every case FAILS (the role file does not exist; the package line is the old one).

- [ ] **Step 3: The defaults**

In `installer/lib/common.sh`, after `: "${YONDER_MAVLINK_ETC:=/etc/mavlink-router}"` (line 45), add:

```sh
# Where 52-gst-rockchip.sh puts the MPP plugin and the two libraries it links,
# the device node whose presence says this is a Rockchip board (R-HW-04: the
# board decides at boot, by what it has), and the registry caches GStreamer
# keeps per user. Overridable for the same reason YONDER_BOOT_DIR is: a role
# that copies into /usr/lib is worth running against a fixture directory. An
# install never sets any of them.
: "${YONDER_MPP_DEVICE:=/dev/mpp_service}"
: "${YONDER_GST_LIBDIR:=/usr/lib/aarch64-linux-gnu}"
: "${YONDER_GST_PLUGIN_DIR:=/usr/lib/aarch64-linux-gnu/gstreamer-1.0}"
: "${YONDER_GST_REGISTRY_DIRS:=/root/.cache/gstreamer-1.0 /var/cache/gstreamer-1.0 /home/yonder/.cache/gstreamer-1.0}"
```

- [ ] **Step 4: The role**

Create `installer/roles/52-gst-rockchip.sh`:

```sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Install the GStreamer plugin that reaches a Rockchip board's hardware
# encoders, and the two libraries it links, from the offline payload — on a
# board that has the hardware, and nowhere else. R-HW-03, R-CAM-07, R-CAM-13.
# shellcheck shell=sh

# An RK35xx reaches its encoders through Rockchip's MPP, not through V4L2:
# there is no memory-to-memory node for v4l2h264enc to bind to, and no
# repository this board has — Debian or Armbian — packages MPP, librga or the
# plugin. make-payload.sh builds all three from pinned commits; this role puts
# them where GStreamer looks and proves the registry then resolves
# mpph264enc, mpph265enc and mppjpegdec, which is exactly what probeEncoder
# asks it (packages/yonder-core/src/video/probe/encoder.ts).
#
# Two skips, neither a failure (R-CFG-08): a payload built without the
# component, and a board that is not a Rockchip board. The second is decided
# by the device node MPP opens, never by a board name (R-CAM-13, R-HW-04): a
# Raspberry Pi has no /dev/mpp_service, and a plugin installed there would
# register three decoders that fail the moment anything uses them.
gr_src="$YONDER_SRC/vendor/gst-rockchip"
if [ ! -d "$gr_src" ]; then
    log "no gst-rockchip in the payload; skipping"
    log "  build one with: installer/make-payload.sh --arch linux-arm64 --only gst-rockchip"
    return 0
fi
if [ ! -c "$YONDER_MPP_DEVICE" ]; then
    log "no $YONDER_MPP_DEVICE on this device; not a Rockchip board, leaving the MPP plugin in the payload"
    return 0
fi
gr_plugin="$gr_src/gstreamer-1.0/libgstrockchipmpp.so"
[ -f "$gr_plugin" ] || die "$gr_src exists but carries no gstreamer-1.0/libgstrockchipmpp.so"
[ -d "$gr_src/lib" ] || die "$gr_src exists but carries no lib/ with MPP and librga in it"

# The plugin links libdrm; the tools package is what the probe, and this
# role's own post-condition, ask the registry with. Both from Debian, on the
# footing 50-mediamtx.sh states.
ensure_pkgs libdrm2 gstreamer1.0-tools

# Built for this machine, checked as 15-mavlink-router.sh checks the router.
# A plugin for another architecture fails to load with a line about the file
# format, and GStreamer then answers "no such element" — the exact shape of
# "this board has no encoder" that spec §8 exists to stop.
gr_have=$(elf_machine "$gr_plugin")
[ -n "$gr_have" ] || die "$gr_plugin is not a little-endian ELF object; the payload is not a payload"
gr_want=$(elf_machine "$YONDER_ELF_REFERENCE")
if [ -z "$gr_want" ]; then
    log "no ELF reference at $YONDER_ELF_REFERENCE to compare against; installing the plugin (ELF machine $gr_have) unchecked"
elif [ "$gr_have" != "$gr_want" ]; then
    die "$gr_plugin is built for ELF machine $gr_have and this system runs $gr_want ($YONDER_ELF_REFERENCE);
the payload was staged for a different architecture.
Rebuild it with: installer/make-payload.sh --arch linux-arm64 --only gst-rockchip"
else
    log "libgstrockchipmpp.so is built for ELF machine $gr_have, the same as $YONDER_ELF_REFERENCE"
fi

log "installing MPP and librga into $YONDER_GST_LIBDIR"
ensure_dir "$YONDER_GST_LIBDIR" 0755
# -a keeps the soname symlinks the loader resolves through.
run cp -a "$gr_src/lib/." "$YONDER_GST_LIBDIR/"
log "installing the plugin into $YONDER_GST_PLUGIN_DIR"
ensure_dir "$YONDER_GST_PLUGIN_DIR" 0755
run cp "$gr_plugin" "$YONDER_GST_PLUGIN_DIR/libgstrockchipmpp.so"
run chmod 0644 "$YONDER_GST_PLUGIN_DIR/libgstrockchipmpp.so"
if command -v ldconfig >/dev/null 2>&1; then
    run ldconfig
else
    log "no ldconfig here; the loader's cache is not refreshed"
fi

# GStreamer caches what it found last time. It rescans a plugin whose file
# changed, but a stale cache reads exactly as "the board has no encoder", so
# the caches are removed rather than trusted.
for gr_dir in $YONDER_GST_REGISTRY_DIRS; do
    for gr_reg in "$gr_dir"/registry.*.bin; do
        [ -f "$gr_reg" ] && run rm -f "$gr_reg"
    done
done

# Post-condition: the registry, asked as this role runs. It runs as root,
# and that matters: the node is 0600 root:root, and a process that cannot
# open it sees the plugin register its decoders and none of its encoders,
# silently — the failure below names that so it is not mistaken for a
# missing plugin.
if [ "$DRY_RUN" = "1" ]; then
    log "would check that GStreamer resolves mpph264enc, mpph265enc and mppjpegdec"
else
    for gr_element in mpph264enc mpph265enc mppjpegdec; do
        gst-inspect-1.0 --exists "$gr_element" \
            || die "GStreamer does not resolve $gr_element after installing the plugin.
If 'gst-inspect-1.0 rockchipmpp' lists decoders and no encoders, this process could not open $YONDER_MPP_DEVICE;
this role runs as root, so that means the node is not the MPP service. If it lists nothing, the plugin did not
load: run GST_DEBUG=2 gst-inspect-1.0 rockchipmpp and read what it says about $YONDER_GST_PLUGIN_DIR/libgstrockchipmpp.so"
    done
    log "GStreamer resolves mpph264enc, mpph265enc and mppjpegdec; probeEncoder will find them"
fi
```

- [ ] **Step 5: The media role installs what every board needs**

In `installer/roles/50-mediamtx.sh`, replace lines 4–36 (the comment, `ensure_pkgs gstreamer1.0-rtsp`, and the whole `if [ "$DRY_RUN" = "1" ] … fi` check) with:

```sh
# Every GStreamer package the composer relies on, on every board, and the
# tools package the probe asks the registry with. What is where: plugins-base
# carries capsfilter, videoconvert, videoscale, videorate, tee and queue;
# plugins-good v4l2src, jpegdec, videoflip, rtph264pay, rtph265pay, udpsink,
# jpegenc and matroskamux; plugins-bad h264parse and h265parse; plugins-ugly
# x264enc, the software fallback probeEncoder names — which no role installed
# until now, so a board without a hardware encoder had no encoder at all;
# rtsp carries rtspclientsink, the element every branch of every pipeline
# ends in. A board's own elements — v4l2convert and v4l2h264enc on a Pi, the
# MPP elements on Rockchip — come from the board's own plugin and are checked
# by the role that provides it (52-gst-rockchip.sh).
#
# From apt rather than the payload: all six are in Debian main, so an offline
# board imaged from a debootstrapped chroot has them the same way it has
# network-manager. make-payload.sh is for what Debian does not carry.
ensure_pkgs gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-rtsp

# And checked, because "the package installed" and "GStreamer resolves the
# element" are different questions and only the second matters: a pipeline
# description naming an element GStreamer cannot resolve does not parse, so
# one missing element is every camera on the device, not one output. The
# weaker branch this check used to take when gst-inspect-1.0 was absent is
# gone — the tools package is installed above, so its absence now is a fault.
if [ "$DRY_RUN" = "1" ]; then
    log "would check that GStreamer resolves every board-independent element the composer names"
else
    command -v gst-inspect-1.0 >/dev/null 2>&1 \
        || die "gstreamer1.0-tools is installed and there is still no gst-inspect-1.0; nothing here can ask the registry anything"
    for mtx_element in rtspclientsink v4l2src jpegdec videoflip tee queue capsfilter videorate videoconvert videoscale \
            h264parse h265parse rtph264pay rtph265pay udpsink x264enc jpegenc matroskamux filesink; do
        gst-inspect-1.0 --exists "$mtx_element" \
            || die "GStreamer cannot resolve $mtx_element even though its package is installed;
a pipeline naming an element GStreamer does not have fails to parse rather than failing to connect,
and every camera on this device composes it"
    done
    log "GStreamer resolves every board-independent element the composer names"
fi
```

- [ ] **Step 6: Lint, dry-run, test**

```bash
shellcheck installer/lib/common.sh installer/roles/*.sh
./installer/install.sh --dry-run 2>&1 | grep -E "^== (50|52)-|gst-rockchip|would check that GStreamer"
npx vitest run --root packages/yonder-core src/installer.test.ts
```

Expected: shellcheck clean; the dry run shows `== 50-mediamtx` with *would check that GStreamer resolves every board-independent element* and `== 52-gst-rockchip` with *no gst-rockchip in the payload; skipping* (this machine has no payload staged in the tree the dry run reads, and no `/dev/mpp_service`); every installer test PASSES.

- [ ] **Step 7: Mutation-check**

Remove the `[ ! -c "$YONDER_MPP_DEVICE" ]` skip → *"leaves a board with no MPP device alone"* goes red. Restore. Remove the registry-cache loop → *"drops the registry cache"* goes red. Restore.

- [ ] **Step 8: Commit**

```bash
git add installer/roles/52-gst-rockchip.sh installer/roles/50-mediamtx.sh installer/lib/common.sh packages/yonder-core/src/installer.test.ts
git commit -s -m "feat(installer): install the MPP plugin where the hardware is, and every GStreamer package the composer relies on — R-HW-03, R-HW-04, R-CAM-13, R-CFG-08"
```

---

### Task 8: The documents say what is now true

Spec §8 names three claims in the repository that the bench falsified; §9 asks for a
requirement that does not exist; the spec's own §2 is reversed by this plan and must say so
in its own voice rather than be contradicted by code. Three known issues are filed — two of
them closed by this branch — and R-VID-20 records the one rule this plan adds.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md` (after the addendum that ends `See also K-62.`; and §11)
- Modify: `docs/requirements.md:130` (after R-VID-19), `docs/requirements.md:263` (after R-HW-06)
- Modify: `docs/known-issues.md` (append K-63, K-64, K-65 after K-62)
- Modify: `docs/architecture.md:162,168,390-391`
- Modify: `docs/roadmap.md:346-347,443`

- [ ] **Step 1: The spec reverses its own §2, on its own evidence**

After the paragraph ending `See also K-62.` in §2's addendum, add:

```markdown
### Decision, revised 2026-09-07

**§2's decision is reversed. Yonder composes its pipelines with GStreamer on every board;
the GStreamer composer gains a Rockchip MPP arm, and no ffmpeg composer is built.**

What changed is the addendum above. The premise this section rested on — that GStreamer
cannot reach Rockchip hardware without carried patches — was tested and is false, and the
comparison the gates produced runs the other way on every axis that has a requirement
behind it. R-VID-07 needs a bitrate that moves on a running pipeline: GStreamer's
`mpph264enc` and `mpph265enc` take one with no gap on this SoC with the real camera in front
of them, and ffmpeg takes one nowhere. K-53's pipeline host — built, and installed by
`55-pipeline-host.sh` — is the channel that reaches it.

What this settles for the sections below:

- **§3 is superseded.** Delivery was the one column ffmpeg won, and its cost is paid: MPP,
  librga and `gstreamer-rockchip` are built from pinned commits in a `debian:trixie`
  container by `installer/make-payload.sh --only gst-rockchip` and installed by
  `installer/roles/52-gst-rockchip.sh` where `/dev/mpp_service` exists. One payload for
  every board; a Pi's role skips it by the device node, never by a name (R-HW-04).
- **§4 holds, narrowed.** The probe widens to the GStreamer registry
  (`gst-inspect-1.0 --exists`). The converter probe collapses to one fact: on MPP the
  preview is scaled *inside* the encoder through RGA (`width`/`height`) — about twice a
  software scaler's throughput, the whole preview branch at one point of four cores — and
  on every other board the line is unchanged. K-62's Pi change is separate work.
- **§5 holds and is measured:** `mppjpegdec` costs +3 against software's +8.
- **§6 holds**, with one rule added: the interface's copy is always H.264 (R-VID-20).
- **§7 is untouched and still open.**
- **§8 and §9 are done** by the change that carries this revision.

Not settled, and stated so: the plugin's H.264 picture beyond one synthetic source and one
camera at 720p (Radxa's own guidance prefers `mpph265enc` on the 6.1 kernel); latency on
Rockchip; sustained load. The hardware note the change ships with records what was seen.
```

In §11, append to the bullet **Whether GStreamer leaves the image entirely**: ` — **It does not** (revision above): the composer stays GStreamer, and the audit is moot.`

- [ ] **Step 2: Two requirements**

In `docs/requirements.md`, after the R-VID-19 row (line 130) add:

```markdown
| R-VID-20 | **The interface's copy is always H.264, whatever the main stream carries.** A browser reaches the preview over WebRTC, and H.265 there is not something every browser does; the main stream's codec (R-CAM-08) is the ground station's business, and choosing it never takes the operator's own picture away. Changing `codec` changes what leaves for the ground station and nothing about what the console shows | 2 |
```

After the R-HW-06 row (line 263) add:

```markdown
| R-HW-07 | **Use a hardware offload wherever the board has one for a workflow, and keep the CPU for everything else.** Encoding (R-CAM-07 is this rule's first instance), decoding a camera's compressed source, and scaling the cheaper copy are each taken by the block that does them where the board has one — selected by probing what is in front of the daemon (R-CAM-13), never by a table of board names — so that a board's cost for video is what its silicon charges and the CPU stays free for the control plane, the console and the link. Measured on an RK3566: hardware decode and encode with the preview scaled in the encoder cost +4 points of four cores for two streams; the software route costs +41 for one | 1 |
```

- [ ] **Step 3: Three known issues**

Append to `docs/known-issues.md`, after K-62, each preceded by a `---` line:

```markdown
### K-63 · ~~On a Rockchip board no camera starts, and the console says the board has no hardware encoder~~ — CLOSED

**Status:** Closed · **Requirements:** R-HW-03, R-CAM-07, R-CAM-08, R-CAM-10, R-CAM-13

Three problems with one cause, named in the Rockchip design's §1 and measured in
[`hardware-encode-on-a-radxa-zero-3w.md`](hardware/hardware-encode-on-a-radxa-zero-3w.md):
`compose()` hard-coded `v4l2convert`, an element a Rockchip board does not have, so every
pipeline description failed to *parse* — `no element "v4l2convert"` — and the supervisor
restart-looped; `probeEncoder` swept `/dev/video10`–`17` for a V4L2 memory-to-memory node
the SoC does not expose, so it returned its software fallback; and that fallback's detail
string told the operator *"this board offers no hardware encoder"* on a board with two.
R-CAM-10 did not fire — `refusal` was `null` right before the pipeline died.

**Closed by** the probe's MPP arm (the registry, asked with `gst-inspect-1.0 --exists`);
`compose()`'s Rockchip branches — `mppjpegdec`, `mpph264enc`/`mpph265enc` carrying `bps`,
the preview scaled inside its encoder through RGA, no scaler element at all; a detail
string that says what the probe knows; and the plugin carried in the payload and installed
by `52-gst-rockchip.sh`. Proven on the board — see
[`rockchip-video-shipped.md`](hardware/rockchip-video-shipped.md).

---

### K-64 · ~~`make-payload.sh --only <one component>` ends with `ZT_DEB: unbound variable`~~ — CLOSED

**Status:** Closed · **Requirements:** R-CFG-07

The summary at the end of `installer/make-payload.sh` read `$ZT_DEB`, a variable only the
ZeroTier block sets; under `set -u` a run that staged its component correctly then exited 1.
A build step whose exit status says it failed after it succeeded is one CI cannot use, and
the comment beside the summary already said the report had to be a lookup rather than a
variable. It now is.

---

### K-65 · The camera page has no codec control

**Status:** Open · **Requirements:** R-CAM-08, R-UI-17

`codec` is a draft field the deck already carries — `DRAFT_PATHS` maps it and
`YonderDeck.vue` flattens `capture.codec` into the form — and no control stages it, so H.265
is chosen by editing `config.yaml`. That is a supported path (the `mavlink.endpoints[].name`
note in `configuration.md` takes the same position) and not the intended one.

**What closes it:** a choice on the camera page offered only where `view.encoder.h265` is
not null, refused with the encoder named where it is (the same sentence `refuse()` already
produces), and the capture gate re-run for the page that changed.
```

- [ ] **Step 4: Architecture and roadmap**

In `docs/architecture.md`:

- Line 162: replace `Encoder selection is per board, resolved at install time and recorded in config:` with `Encoder selection is per board, probed when the daemon looks (R-CAM-13) and reported on the camera page; nothing about it is written to configuration — R-CAM-06 was withdrawn for exactly that:`
- Line 168: replace `| Radxa (rk35xx) | rkmpp hardware | rkmpp hardware |` with ``| Radxa (rk35xx) | MPP hardware (`mpph264enc`) | MPP hardware (`mpph265enc`) |``
- Lines 390–391: replace the two-line paragraph with:

```markdown
Radxa hardware encoding needs the Rockchip MPP library and the GStreamer Rockchip plugin,
which no repository packages; both are built from pinned commits into the offline payload by
`installer/make-payload.sh` and installed by a role where `/dev/mpp_service` exists. Armbian
ships the vendor kernel, so Radxa is installable rather than image-only. The Pi supports
both paths.
```

In `docs/roadmap.md`:

- Lines 346–347: replace `Radxa stays out — it is P2 and needs the vendor BSP kernel, which makes it image-only until M8.` with `Radxa arrived after all: Armbian ships the vendor kernel and the MPP path is carried in the payload, so M6's Rockchip line was pulled into M4 (see the Rockchip design and its 2026-09-07 revision).`
- Line 443: replace `- Rockchip boards: hardware H.264 and H.265 — R-HW-03, R-CAM-08, R-VID-02` with `- ~~Rockchip boards: hardware H.264 and H.265~~ — R-HW-03, R-CAM-08, R-VID-02 — **done, pulled into M4**`

- [ ] **Step 5: Check what was written**

```bash
grep -c "Decision, revised 2026-09-07" docs/superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md
grep -nE "^\| R-(VID-20|HW-07) \|" docs/requirements.md | cut -c1-40
grep -nE "^### K-6[2-4]" docs/known-issues.md
grep -n "resolved at install time" docs/architecture.md docs/roadmap.md || echo "claim gone"
grep -n "image-only" docs/architecture.md docs/roadmap.md
```

Expected: `1`; two rows; three headings; `claim gone`; the only `image-only` hit is the architecture paragraph saying *"rather than image-only"*.

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -s -m "docs: reverse the composer decision on its own evidence, file K-63..K-65, add R-HW-07 and R-VID-20, and correct architecture and roadmap — R-HW-03, R-CAM-13"
```

---

### Task 9: `device: auto` sweeps a Rockchip board's UART2

`MAVLINK_DEVICES` is `["/dev/ttyAMA0", "/dev/ttyACM0"]`, and its comment says a Rockchip
board's UART2 is expected at `/dev/ttyAMA0`. On Armbian it is `/dev/ttyS2` — `serial2` in
the device tree's aliases, the 8250 driver's `ttyS`, on header pins 8 and 10 once the
`uart2-m0` overlay is applied (Task 10 applies it; on the bench it was applied by hand on
2026-09-07 and the daemon found the port the moment `config.yaml` named it). A node that is
not there is silence, as the existing test at `renderer.test.ts:126` says, so adding it
costs a Pi nothing.

**Files:**
- Modify: `packages/yonder-core/src/mav/renderer.ts:28-42`
- Modify: `docs/configuration.md:145,362`
- Test: `packages/yonder-core/src/mav/renderer.test.ts:1338`

- [ ] **Step 1: Write the failing test**

Replace the test at `packages/yonder-core/src/mav/renderer.test.ts:1338`:

```ts
  it("sweeps both boards' header UARTs before the USB CDC-ACM device (R-MAV-02)", () => {
    expect([...MAVLINK_DEVICES]).toEqual(["/dev/ttyAMA0", "/dev/ttyS2", "/dev/ttyACM0"]);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/renderer.test.ts -t "header UARTs"`
Expected: FAIL — the array has two entries.

- [ ] **Step 3: Add the device, and say why**

In `packages/yonder-core/src/mav/renderer.ts`, replace the comment block above the constant (lines 28–41) and the constant with:

```ts
/**
 * What `device: auto` sweeps, in order: the header UARTs of both board
 * families, then a USB CDC-ACM device.
 *
 * §2 of the telemetry-plumbing design puts the autopilot on the same three
 * header pins on both families — UART0 on pins 8 and 10 of a Pi, UART2 on the
 * same pins of a Rockchip board. The Pi's is `/dev/ttyAMA0`. The Rockchip
 * board's is **`/dev/ttyS2`** on Armbian — `serial2` in the device tree's
 * aliases, the 8250 driver's `ttyS` — once the `uart2-m0` overlay has taken
 * it back from the boot console (40-uart.sh). `R-MAV-02` requires a USB
 * CDC-ACM device to work too, and `docs/configuration.md` documents exactly
 * these three as the values `device` takes besides `auto`, so this list is
 * that documentation and not a wider guess: `/dev/ttyUSB*` is an FTDI or
 * CP210x bridge, which is neither a hardware UART nor CDC-ACM, and nothing
 * in this repository asks for one.
 *
 * A node that is not there is not an error — it is silence, which is what
 * Task 15's post-condition says an un-rebooted UART overlay must look like.
 */
export const MAVLINK_DEVICES = ["/dev/ttyAMA0", "/dev/ttyS2", "/dev/ttyACM0"] as const;
```

- [ ] **Step 4: Run the renderer tests**

Run: `npx vitest run --root packages/yonder-core src/mav/renderer.test.ts`
Expected: PASS — including `"sweeps the USB device too when the header UART says nothing"`, which now passes through one more silent node on its way.

- [ ] **Step 5: Document the value**

In `docs/configuration.md`, line 145: `    device: auto                # auto | /dev/ttyAMA0 | /dev/ttyACM0` becomes `    device: auto                # auto | /dev/ttyAMA0 (Pi) | /dev/ttyS2 (Rockchip, Armbian) | /dev/ttyACM0 (USB)`. Line 362, the same three values in the later block, the same way.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/mav/renderer.ts packages/yonder-core/src/mav/renderer.test.ts docs/configuration.md
git commit -s -m "feat(mav): device: auto sweeps a Rockchip board's UART2 as Armbian names it — R-MAV-01, R-MAV-02"
```

---

### Task 10: The UART role frees the header UART on Armbian too

`40-uart.sh` knows one boot layout and says so: on a root without `config.txt` it logs
*"not a Raspberry Pi boot layout, skipping"*. On the Radxa the header UART was freed by hand
on 2026-09-07, and a fresh flash would lose it. What was done, and what this arm reproduces:
`ttyS1` is Bluetooth's, UART2 is the boot console reached through the FIQ debugger on
`ttyFIQ0`, and every other UART is `disabled` in the device tree. The image ships
`rk3568-uart2-m0.dtbo` (`compatible` with `radxa,zero3`; it enables `uart2` and disables
`fiq_debugger`), and only `user_overlays=` resolves on this image — `overlays=` looks for
`rk35xx-*.dtbo`, of which there are none. So: copy the overlay into `/boot/overlay-user/`,
name it in `user_overlays=`, turn `console=both` into `console=display` (which drops
`console=ttyS2,1500000` from the kernel command line), and disable the getty on `ttyFIQ0`.
The role stages it; the reboot is the operator's, as on the Pi.

**Files:**
- Modify: `installer/lib/common.sh` (after the block Task 7 added)
- Modify: `installer/roles/40-uart.sh:15-19` (the layout check becomes a fork)
- Modify: `docs/roadmap.md` (M5 list)
- Test: `packages/yonder-core/src/installer.test.ts` (inside the existing `40-uart` describe at line 722)

- [ ] **Step 1: Write the failing tests**

Inside the `40-uart` describe block, after `runUart` (line ~752), add:

```ts
  function armbianFixture(env: string, opts: { overlay?: boolean } = {}) {
    const boot = join(dir, "armbian-boot");
    const dtb = join(boot, "dtb", "rockchip", "overlay");
    const user = join(boot, "overlay-user");
    mkdirSync(dtb, { recursive: true });
    if (opts.overlay !== false) writeFileSync(join(dtb, "rk3568-uart2-m0.dtbo"), "dtbo bytes");
    const envFile = join(boot, "armbianEnv.txt");
    writeFileSync(envFile, env);
    return { envFile, dtb, user };
  }
  function runArmbian(f: ReturnType<typeof armbianFixture>, opts: { dryRun?: boolean; path: string }) {
    return sh(
      `set -eu; . '${COMMON}'; . '${UART_ROLE}'`,
      {
        DRY_RUN: opts.dryRun === true ? "1" : "0",
        YONDER_BOOT_DIR: join(dir, "no-pi-boot-here"),
        YONDER_ARMBIAN_ENV: f.envFile,
        YONDER_DTB_OVERLAY_DIR: f.dtb,
        YONDER_USER_OVERLAY_DIR: f.user,
        YONDER_SYSTEMD_DIRS: join(dir, "no-systemd-here"),
      },
      opts.path,
    );
  }
  // A Radxa Zero 3W's armbianEnv.txt as Armbian 26.8.1 ships it, with the
  // USB host overlay the camera needs already in user_overlays.
  const ARMBIAN = [
    "verbosity=1", "bootlogo=false", "console=both", "extraargs=cma=256M", "overlay_prefix=rk35xx",
    "fdtfile=rockchip/rk3566-radxa-zero3.dtb", "rootdev=UUID=2bae8c0f", "rootfstype=ext4",
    "user_overlays=dwc3-host", "usbstoragequirks=0x2537:0x1066:u", "",
  ].join("\n");

  it("frees UART2 on Armbian: copies the overlay, names it, takes the serial console off, disables the FIQ getty (R-MAV-02, R-HW-04)", () => {
    const f = armbianFixture(ARMBIAN);
    const { path, log } = stubSystemdTools();
    const r = runArmbian(f, { path });
    expect(r.code).toBe(0);
    expect(existsSync(join(f.user, "uart2-m0.dtbo"))).toBe(true);
    const env = readFileSync(f.envFile, "utf8");
    expect(env).toContain("user_overlays=dwc3-host uart2-m0\n");
    expect(env).toContain("console=display\n");
    expect(env).not.toContain("console=both");
    expect(env).toContain("overlay_prefix=rk35xx\n");
    expect(env).toContain("extraargs=cma=256M\n");
    expect(readFileSync(log, "utf8")).toContain("deb-systemd-helper disable serial-getty@ttyFIQ0.service");
    expect(r.out).toContain("takes hardware effect at the next boot");
  });

  it("is idempotent on Armbian: a second run changes nothing and says so", () => {
    const f = armbianFixture(ARMBIAN);
    const { path } = stubSystemdTools();
    runArmbian(f, { path });
    const once = readFileSync(f.envFile, "utf8");
    const r = runArmbian(f, { path });
    expect(r.code).toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toBe(once);
    expect(r.out).toContain("already carries uart2-m0");
  });

  it("adds user_overlays when the file has none, and rewrites console=serial too", () => {
    const f = armbianFixture(ARMBIAN.replace("user_overlays=dwc3-host\n", "").replace("console=both", "console=serial"));
    const r = runArmbian(f, { path: stubSystemdTools().path });
    expect(r.code).toBe(0);
    const env = readFileSync(f.envFile, "utf8");
    expect(env).toContain("user_overlays=uart2-m0\n");
    expect(env).toContain("console=display\n");
  });

  it("leaves console=display alone", () => {
    const f = armbianFixture(ARMBIAN.replace("console=both", "console=display"));
    const r = runArmbian(f, { path: stubSystemdTools().path });
    expect(r.code).toBe(0);
    expect(readFileSync(f.envFile, "utf8").match(/^console=/gm)).toEqual(["console="]);
    expect(r.out).toContain("no serial console");
  });

  it("dies when the image carries no uart2-m0 overlay, naming what it looked for", () => {
    const f = armbianFixture(ARMBIAN, { overlay: false });
    const r = runArmbian(f, { path: stubSystemdTools().path });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no rk3568-uart2-m0.dtbo");
  });

  it("says what it would do on Armbian on a dry run, and writes nothing", () => {
    const f = armbianFixture(ARMBIAN);
    const r = runArmbian(f, { dryRun: true, path: stubSystemdTools().path });
    expect(r.code).toBe(0);
    expect(r.out).toContain("would");
    expect(readFileSync(f.envFile, "utf8")).toBe(ARMBIAN);
    expect(existsSync(join(f.user, "uart2-m0.dtbo"))).toBe(false);
  });
```

Also add `YONDER_ARMBIAN_ENV: join(dir, "no-armbian-here"),` to the env object inside the existing `runUart` helper, so the Pi cases never see a real `/boot/armbianEnv.txt`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --root packages/yonder-core src/installer.test.ts -t "Armbian"`
Expected: every case FAILS — the role skips with *"not a Raspberry Pi boot layout"*.

- [ ] **Step 3: The defaults**

In `installer/lib/common.sh`, after the `YONDER_GST_REGISTRY_DIRS` default Task 7 added:

```sh
# Armbian's boot layout, which R-HW-03's boards use: one file of key=value
# pairs u-boot reads, the kernel's overlays, and the directory user overlays
# are loaded from. Overridable for the same reason YONDER_BOOT_DIR is: a role
# that rewrites a boot file is worth testing against a fixture. An install
# never sets any of them.
: "${YONDER_ARMBIAN_ENV:=/boot/armbianEnv.txt}"
: "${YONDER_DTB_OVERLAY_DIR:=/boot/dtb/rockchip/overlay}"
: "${YONDER_USER_OVERLAY_DIR:=/boot/overlay-user}"
```

- [ ] **Step 4: The Armbian arm**

In `installer/roles/40-uart.sh`, replace the comment and check at lines 6–19 (from `# This role knows one boot layout` through the `fi` of the `config.txt`/`cmdline.txt` check) with:

```sh
# Two boot layouts. A Raspberry Pi's /boot/firmware holds config.txt and
# cmdline.txt (R-HW-01, R-HW-02); Armbian, which R-HW-03's Radxa boards run,
# holds one armbianEnv.txt u-boot reads (R-HW-04: which is decided by what
# is on disk, never by a board name). A root that carries neither is not a
# broken install to stop over — it is a target this role has nothing to do
# on, the same reasoning 40-zerotier.sh applies to a payload that was never
# built: say what is missing, and leave the rest of the install to finish.
if [ -f "$YONDER_ARMBIAN_ENV" ]; then
    # What the bench found on a Radxa Zero 3W, and what this arm reverses:
    # ttyS1 is Bluetooth's, UART2 is the boot console reached through the
    # FIQ debugger on ttyFIQ0, and every other UART is disabled in the device
    # tree. The image ships rk3568-uart2-m0.dtbo — compatible with
    # radxa,zero3; it enables uart2 and disables fiq_debugger — and only
    # user_overlays= resolves on this image: overlays= looks for
    # rk35xx-*.dtbo, of which there are none. See
    # docs/hardware/rockchip-video-shipped.md.
    ua_dtbo="$YONDER_DTB_OVERLAY_DIR/rk3568-uart2-m0.dtbo"
    ua_user="$YONDER_USER_OVERLAY_DIR/uart2-m0.dtbo"
    [ -f "$ua_dtbo" ] || die "no rk3568-uart2-m0.dtbo under $YONDER_DTB_OVERLAY_DIR; this image cannot free the header UART, and the autopilot would have no UART to answer on"
    ensure_dir "$YONDER_USER_OVERLAY_DIR" 0755
    if [ -f "$ua_user" ]; then
        log "$ua_user already present"
    else
        log "copying the UART2 overlay to $ua_user"
        run cp "$ua_dtbo" "$ua_user"
    fi

    # user_overlays= is a space-separated list; the token is added once, the
    # rest of the line and every other line left exactly as they were.
    ua_names_overlay() {
        sed -n 's/^user_overlays=//p' "$1" | tr ' \t' '\n\n' | grep -qxF "$2"
    }
    ua_add_overlay() {
        awk -v tok="$2" '
            BEGIN { done = 0 }
            /^user_overlays=/ {
                rest = substr($0, 15)
                $0 = (rest == "" ? "user_overlays=" tok : "user_overlays=" rest " " tok)
                done = 1
            }
            { print }
            END { if (!done) print "user_overlays=" tok }
        ' "$1" > "$1.new" && mv "$1.new" "$1"
    }
    if ua_names_overlay "$YONDER_ARMBIAN_ENV" uart2-m0; then
        log "$YONDER_ARMBIAN_ENV already carries uart2-m0 in user_overlays"
    else
        log "adding uart2-m0 to user_overlays in $YONDER_ARMBIAN_ENV"
        run ua_add_overlay "$YONDER_ARMBIAN_ENV" uart2-m0
    fi

    # console=both and console=serial put a login console on UART2 at
    # 1500000 baud — the same two pins — and it would answer the autopilot.
    # console=display keeps tty1 and drops console=ttyS2 from the command
    # line. Only that one value is rewritten.
    ua_drop_serial_console() {
        sed -E 's/^console=(both|serial)$/console=display/' "$1" > "$1.new" && mv "$1.new" "$1"
    }
    if grep -Eq '^console=(both|serial)$' "$YONDER_ARMBIAN_ENV"; then
        log "setting console=display in $YONDER_ARMBIAN_ENV; R-NET-07's access point, not this port, is the way back into a board that will not boot"
        run ua_drop_serial_console "$YONDER_ARMBIAN_ENV"
    else
        log "$YONDER_ARMBIAN_ENV puts no serial console on the UART"
    fi

    # The getty the FIQ debugger's console carries. Disabled for the next
    # boot, not stopped now, for the reason the Pi arm gives below: this
    # install may be running from that very console.
    log "disabling the getty on ttyFIQ0 for next boot, without stopping it now"
    disable_unit_offline serial-getty@ttyFIQ0.service
    assert_unit_disabled serial-getty@ttyFIQ0.service

    if [ "$DRY_RUN" = "1" ]; then
        log "would check that $ua_user exists, that user_overlays names uart2-m0, and that no serial console remains"
    else
        [ -f "$ua_user" ] || die "$ua_user is not there; the overlay would not load"
        ua_names_overlay "$YONDER_ARMBIAN_ENV" uart2-m0 \
            || die "$YONDER_ARMBIAN_ENV does not name uart2-m0; the UART would stay the boot console's"
        if grep -Eq '^console=(both|serial)$' "$YONDER_ARMBIAN_ENV"; then
            die "$YONDER_ARMBIAN_ENV still puts a login console on the UART; it would answer the autopilot instead of mavlink-router"
        fi
        log "UART2 is staged for the autopilot, as /dev/ttyS2; it takes hardware effect at the next boot"
    fi
    return 0
fi

ua_cfg="$YONDER_BOOT_DIR/config.txt"
ua_cmdline="$YONDER_BOOT_DIR/cmdline.txt"
if [ ! -f "$ua_cfg" ] || [ ! -f "$ua_cmdline" ]; then
    log "no config.txt/cmdline.txt under $YONDER_BOOT_DIR and no $YONDER_ARMBIAN_ENV; neither boot layout, skipping"
    return 0
fi
```

- [ ] **Step 5: Lint, test, dry-run**

```bash
shellcheck installer/roles/40-uart.sh installer/lib/common.sh
npx vitest run --root packages/yonder-core src/installer.test.ts -t "40-uart|Armbian|console=serial0"
./installer/install.sh --dry-run 2>&1 | grep -A2 "^== 40-uart"
```

Expected: shellcheck clean; every UART case PASSES, Pi and Armbian alike; the dry run on this machine logs *neither boot layout, skipping*.

- [ ] **Step 6: Mutation-check**

Remove the `ua_drop_serial_console` call → *"frees UART2 on Armbian"* goes red on `console=both`. Restore. Make `ua_names_overlay` always succeed → *"adds user_overlays when the file has none"* goes red. Restore.

- [ ] **Step 7: The roadmap, and commit**

In `docs/roadmap.md`, in the M5 list after `- Flight-controller autodetect by baud sweep — R-MAV-01, R-MAV-02`, add
`- The header UART freed by the installer on both boot layouts, Armbian included — R-MAV-02, R-HW-04`.

```bash
git add installer/roles/40-uart.sh installer/lib/common.sh packages/yonder-core/src/installer.test.ts docs/roadmap.md
git commit -s -m "feat(installer): free the header UART on Armbian — UART2 overlay, no serial console, no FIQ getty — R-MAV-02, R-HW-04"
```

---

### Task 11: Prove it on the board, to a ground station, over cellular — and write it down

Everything above is unit-tested against stand-ins. This task is the board, the ground
station and the note, in that order, and it is what closes K-63. Nothing here is a claim
until the command beside it has printed the number.

**Files:**
- Create: `docs/hardware/rockchip-video-shipped.md`
- Modify: `docs/known-issues.md` (K-63's *Proven* line gets the date and the figures)
- Board: `/opt/yonder-src` (staged tree), `/etc/yonder/config.yaml` (through `POST /apply` only)

- [ ] **Step 1: Stage and install**

```bash
npm run build
rsync -az --delete --exclude .git --exclude node_modules --exclude 'docs/console/design' \
  ./packages ./config ./flows ./systemd ./installer ./scripts ./vendor ./package.json ./package-lock.json \
  root@<radxa>:/opt/yonder-src/
ssh root@<radxa> 'cd /opt/yonder-src && rm -rf packages/yonder-core/dist && for r in 50-mediamtx 52-gst-rockchip 55-pipeline-host 20-yonder-core 30-console 40-uart; do ./installer/install.sh --only $r 2>&1 | tail -4; done'
```

Expected, in order: *GStreamer resolves every board-independent element*; *libgstrockchipmpp.so is built for ELF machine 183*, *GStreamer resolves mpph264enc, mpph265enc and mppjpegdec*; *the pipeline host starts*; yonder-core builds on the board and *everything it imports load*; the console installs; `40-uart` reports the overlay, the token and the console *already* in place (the hand-applied state from 2026-09-07 — the role's idempotency proven on the real file).

```bash
ssh root@<radxa> 'systemctl daemon-reload && systemctl restart yonder-core && sleep 15 && systemctl restart yonder-console && sleep 5 && systemctl is-active yonder-core yonder-console mediamtx'
```

Expected: `active` ×3.

- [ ] **Step 2: The probe, on the board**

```bash
ssh root@<radxa> 'curl -s --unix-socket /run/yonder/core.sock http://localhost/cameras/cam0 | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d[\"encoder\"], indent=1)); print(\"refusal:\", d[\"refusal\"])"'
```

Expected: `element: mpph264enc`, `h265: mpph265enc`, `decoder: mppjpegdec`, `device: /dev/mpp_service`, `hardware: true`, the detail naming both; `refusal: None`.

- [ ] **Step 3: H.264 — start, look, cost**

```bash
ssh root@<radxa> 'curl -s -X POST --unix-socket /run/yonder/core.sock -H "Content-Type: application/json" -d "{\"action\":\"start\"}" http://localhost/cameras/cam0/run; sleep 12; curl -s --unix-socket /run/yonder/core.sock http://localhost/cameras/cam0/run; echo; pid=$(pgrep -f "yonder-pipeline" | head -1); tr "\0" " " < /proc/$pid/cmdline; echo'
```

Expected: `state: running`, `restarts: 0`; the command line carries `mppjpegdec`, `mpph264enc name=enc-stream bps=2000000`, `mpph264enc name=enc-preview bps=400000 gop=15 width=640 height=360`, `caps=video/x-raw(ANY),framerate=15/1`, and no `v4l2convert`. If `restarts` is not 0, `journalctl -u yonder-core -n 40` names the element that did not parse; that is the finding to record before anything else.

```bash
ssh root@<radxa> 'gst-launch-1.0 -q rtspsrc location=rtsp://127.0.0.1:8554/cam0 latency=200 ! rtph264depay ! h264parse ! mppvideodec ! videoconvert ! jpegenc snapshot=true ! filesink location=/tmp/full.jpg 2>/dev/null; gst-launch-1.0 -q rtspsrc location=rtsp://127.0.0.1:8554/cam0-preview latency=200 ! rtph264depay ! h264parse ! mppvideodec ! videoconvert ! jpegenc snapshot=true ! filesink location=/tmp/preview.jpg 2>/dev/null; /usr/lib/jellyfin-ffmpeg/ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0 /tmp/full.jpg /tmp/preview.jpg'
scp root@<radxa>:/tmp/full.jpg root@<radxa>:/tmp/preview.jpg /tmp/
```

Expected: `mjpeg,1280,720` and `mjpeg,640,360`; look at both files — a picture of the room, not a grey frame.

```bash
ssh root@<radxa> 'b() { f=$(head -1 /proc/stat); set -- $f; echo $(( $2+$3+$4+$6+$7+$8 )) $(( $2+$3+$4+$5+$6+$7+$8 )); }; s=$(b); sleep 10; e=$(b); set -- $s $e; echo "busy $(( ($3-$1)*100/($4-$2) ))% over 10 s with the pipeline running"'
```

Expected: about **26%** with `yonder-core`, Node-RED and mediamtx idle at ~21–23% — the bench's +4. If it reads +20 or more, the preview branch fell to system memory: record it, then re-measure with the rate filter removed from the launch line by hand (`gst-launch-1.0` the same tokens minus `videorate ! capsfilter …`) to say which it was, and file it against Task 3 rather than shipping around it.

- [ ] **Step 4: The live retune, through the daemon**

```bash
ssh root@<radxa> 'rate() { /usr/lib/jellyfin-ffmpeg/ffmpeg -v error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/cam0 -t 10 -c copy -f null - 2>&1 | grep -oE "video:[0-9]+kB" ; }; echo "before: $(rate)"; curl -s --unix-socket /run/yonder/core.sock http://localhost/cameras/cam0/run; echo; curl -s -X POST --unix-socket /run/yonder/core.sock -H "Content-Type: application/json" -d "{\"streamBitrate\":3500}" http://localhost/cameras/cam0/apply | head -c 600; echo; sleep 3; echo "after: $(rate)"; curl -s --unix-socket /run/yonder/core.sock http://localhost/cameras/cam0/run; echo'
```

Expected: `before` about `video:2500kB` (2000 kb/s × 10 s ÷ 8); the apply answer's `interruption` says the picture is **not** restarted; `after` about `video:4375kB`; the two `run` readings show the **same `since`** — the pipeline that was running is the pipeline still running, and its rate moved. Confirm the apply with `POST /confirm` carrying the id the answer returned (or watch it be kept without a window — `codec`, `bitrate_kbps` under `stream` are what `interruption()` and `CAMERA_EXEMPT_LEAVES` decide; record which happened).

- [ ] **Step 5: H.265**

```bash
ssh root@<radxa> 'curl -s -X POST --unix-socket /run/yonder/core.sock -H "Content-Type: application/json" -d "{\"codec\":\"h265\"}" http://localhost/cameras/cam0/apply | head -c 400; echo; sleep 15; curl -s --unix-socket /run/yonder/core.sock http://localhost/cameras/cam0/run; echo; pid=$(pgrep -f yonder-pipeline | head -1); tr "\0" " " < /proc/$pid/cmdline | grep -oE "mpph26[45]enc name=enc-[a-z]+|h26[45]parse" | tr "\n" " "; echo; /usr/lib/jellyfin-ffmpeg/ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name,width,height -of csv=p=0 rtsp://127.0.0.1:8554/cam0; /usr/lib/jellyfin-ffmpeg/ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name -of csv=p=0 rtsp://127.0.0.1:8554/cam0-preview'
```

Expected: the apply says the picture restarts; a new `since`; `mpph265enc name=enc-stream h265parse mpph264enc name=enc-preview h264parse`; `hevc,1280,720` on `cam0` and `h264` on `cam0-preview`. Repeat Step 4's rate measurement once here — H.265 retunes live too (the bench: 0.97 → 3.91). Then open the console in Chrome, sign in, and confirm the camera page's preview still plays (R-VID-20) and its encoder line reads `mpph264enc · hardware`. Put `codec` back to `h264` or leave it — say which in the note.

- [ ] **Step 6: The ground station**

On the Mac, open Mission Planner, choose **UDP**, port **14550**, and press Connect (it listens and waits). Then, on the board, add the endpoint through the daemon — the one writer:

```bash
ssh root@<radxa> 'curl -s --unix-socket /run/yonder/core.sock http://localhost/config > /tmp/config.json && python3 - <<"PY"
import json
c = json.load(open("/tmp/config.json"))
c["mavlink"]["endpoints"] = [{"name": "gcs0", "host": "<gs>", "port": 14550}]
json.dump(c, open("/tmp/next.json", "w"))
PY
curl -s -X POST --unix-socket /run/yonder/core.sock -H "Content-Type: application/json" --data-binary @/tmp/next.json http://localhost/apply | head -c 400; echo; sleep 5; curl -s --unix-socket /run/yonder/core.sock http://localhost/status; echo; grep -A3 "UdpEndpoint gcs0" /etc/mavlink-router/main.conf'
```

Expected: the apply is **kept, not held** (`R-CFG-12`: `mavlink.endpoints` is exempt) — `/status` reads `idle` with no window; `main.conf` gains `[UdpEndpoint gcs0] Mode = Normal Address = <gs> Port = 14550`.

With the flight controller on pins 8 (TX), 10 (RX) and a ground:

```bash
ssh root@<radxa> 'sleep 40; curl -s --unix-socket /run/yonder/core.sock http://localhost/mav/state | python3 -c "import json,sys; d=json.load(sys.stdin); l=d[\"link\"]; print(l[\"phase\"], l[\"device\"], l[\"baud\"], l[\"vehicle\"], round(l[\"heartbeatHz\"] or 0,2), \"Hz\"); print(l[\"groundStations\"]); print(\"router\", d[\"routerRunning\"], \"traffic\", l[\"traffic\"])"'
```

Expected: `linked /dev/ttyS2 <baud> <vehicle> ~1.0 Hz`; `groundStations: [{name: gcs0, answering: True, lastHeardMs: <small>}]` — Mission Planner heartbeats back; Mission Planner's HUD is live. Without the flight controller wired, prove the router→ground-station leg with the synthetic autopilot the 2026-09-07 session used (a pty emitting MAVLink v2 heartbeats, `mavlink.serial.device` pointed at it through `/apply`, then pointed back): Mission Planner shows an ArduCopter, system 1, and `answering` goes true. Record which of the two was done.

- [ ] **Step 7: Video on the ground, and the cellular leg**

On the Mac (the RTSP password is `rtsp_password` in `/etc/yonder/secrets.yaml`, read as root; never written anywhere else):

```bash
ffplay -rtsp_transport tcp "rtsp://yonder:<rtsp-password>@<radxa>:8554/cam0"
```

Expected: the picture, H.265 if that is what was left on. In Mission Planner: HUD → right-click → *Video* → *Set GStreamer Source*:
`rtspsrc location=rtsp://yonder:<rtsp-password>@<radxa>:8554/cam0 latency=0 ! decodebin ! videoconvert ! video/x-raw,format=BGRA ! appsink name=outsink`.
Record whether Mission Planner on the Mac decodes it (its GStreamer is its own).

Then take the Mac off the LAN — a phone hotspot — so the mesh has no direct path left:

```bash
ssh root@<radxa> '/usr/sbin/zerotier-cli listpeers | grep LEAF; curl -s --unix-socket /run/yonder/core.sock http://localhost/reach/state | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[\"inUse\"], d[\"carrying\"])"; sleep 30; curl -s --unix-socket /run/yonder/core.sock http://localhost/mav/state | python3 -c "import json,sys; print(json.load(sys.stdin)[\"link\"][\"groundStations\"])"; curl -s --unix-socket /run/yonder/core.sock http://localhost/remote/state | python3 -c "import json,sys; d=json.load(sys.stdin); print(\"relayed\", d[\"relayed\"], \"latency\", d[\"latencyMs\"], \"tx bps\", int(d[\"txBitsPerSecond\"]))"'
```

Expected: the Mac's peer line no longer shows a `192.168.68.x` path; `modem True`; `answering: True` still; `relayed False` (or `True`, recorded either way) with the latency and the uplink rate the mesh reports while Mission Planner and `ffplay` are both consuming. That is the whole chain — camera to MPP to mediamtx to the mesh to cellular to the ground, and MAVLink both ways beside it.

- [ ] **Step 8: Write the note, close K-63, commit**

Create `docs/hardware/rockchip-video-shipped.md` in the form of `hardware-encode-on-a-radxa-zero-3w.md`: a *What was in front of us* table (board, kernel, Armbian version, the three commits from `vendor/gst-rockchip/MANIFEST` and the plugin's sha256, camera, modem, date); then one section per step above with the command run and what it printed — the probe's answer, the launch line, the two frames, the busy figure against the bench's +4, the retune before/after with the unchanged `since`, the H.265 `ffprobe` lines and the preview still H.264, the ground station's `answering`, the cellular peer path and rates; a *What the UART needed* section recording what the hand-applied state was and that `40-uart.sh` found it already in place (and whether the camera's by-path name held across this session's reboots — R-CAM-05's second clean reboot); and *Not settled* for what it did not measure (latency on Rockchip, picture quality across sources and sizes, sustained load, Mission Planner's own decoder on macOS).

In `docs/known-issues.md`, K-63's *Proven on the board* line gains the date and the two numbers that matter: the busy figure and the retune's before/after.

```bash
git add docs/hardware/rockchip-video-shipped.md docs/known-issues.md
git commit -s -m "docs(hardware): Rockchip video and telemetry shipped, measured on the board and on the ground — R-HW-03, R-CAM-08, R-VID-07, R-MAV-03"
```

Leave the board with `cam0` stopped (`{"action":"stop"}`), the endpoint in place, and nothing in `/tmp`.

---

## Self-Review

**Spec coverage** (`2026-09-05-rockchip-hardware-encode-design.md`, as revised by Task 8):

| Section | Where |
|---|---|
| §1 three problems, one cause | Tasks 1, 3 (the probe, `v4l2convert`, the detail string) |
| §2 composer decision | Reversed by Task 8 on the addendum Task 0 merges; the GStreamer composer stays (Task 3) |
| §3 delivery | Superseded: Task 6 (payload), Task 7 (role) |
| §4 the probe widens; the converter | Task 1 (registry), Task 3 (RGA in the encoder; Pi unchanged) |
| §5 hardware decode | Task 3 (`encoder.decoder ?? "jpegdec"`), measured in Task 11 |
| §6 H.265 | Task 2 (schema, receive line, docs), Task 3 (compose, refuse), Task 5 (recording), Task 11 (proof); the preview rule is R-VID-20 (Task 8) |
| §7 demand-driven output | **Not in this plan**, stated in the header and in Task 8's revision |
| §8 three corrections | Task 1 (detail string), Task 8 (architecture, roadmap) |
| §9 a new requirement | Task 8 (R-HW-07) |
| §10 tests | Tasks 1, 3, 7 (the exact three the spec names: MPP probe case, no-`v4l2convert` regression, elements resolved by a role) |
| §11 open items | By-path second reboot recorded in Task 11's note; limits, mediamtx API, privileges, latency on Rockchip stay open and are named as such |

The user's ask beyond the spec — MAVLink to Mission Planner over the mesh and cellular —
is Tasks 9, 10 and 11 (Steps 6–7); it needed a UART the installer can free and an endpoint,
not new code in the router path.

**Placeholder scan:** run `grep -nE "TBD|TODO|later|fill in|Similar to|edge cases|appropriate" docs/superpowers/plans/2026-09-07-rockchip-video-and-ground-station.md` — every hit is prose about the domain (a "later" milestone, an "appropriate" quoted from an existing comment), not an instruction to an implementer. Every code step carries its code.

**Type consistency:** `Encoder` (Task 1) is `{ element, h265, decoder, device, hardware, detail }` everywhere — the fixtures in Tasks 3, 4 and 5 all spell `MPP` the same way; `EncodeKind`, `encoderFor`, `scalesInEncoder`, `encodeControl`, `encodesIn`, `refuse` (Task 3) are the names Tasks 4 and 5 import; the payload layout Task 6 produces (`lib/`, `gstreamer-1.0/`, `MANIFEST`, `inspect.txt`) is what Task 7's role and tests read; the `YONDER_*` defaults Tasks 7 and 10 add to `common.sh` are the names their tests set; `docs/hardware/rockchip-video-shipped.md` is cited by Task 8's K-63 and created by Task 11.

## Execution notes

- Tasks 1–5 and 8–9 need no board and no Docker. Task 6 needs Docker (arm64 native on this
  Mac; emulated in CI). Task 7 is testable without a board (`/dev/null` stands in for the
  MPP device). Task 10 is testable without a board. Task 11 needs the board, the camera,
  the flight controller (or the synthetic one), Mission Planner on the Mac, and a hotspot.
- Order matters up to Task 5 (types flow forward); 6→7; 8 and 9 are free; 10 before 11.
- No per-task review: one review at the end, as this project runs plans.
