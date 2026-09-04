// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";
import { CAPABILITY_KEYS, type CameraCapabilities, type Capability } from "./capability.js";

/**
 * What a camera page *reads*, as strings a widget can bind.
 *
 * It is here, in a package, and not in a `change` node in `flows.json`, for
 * the reason CLAUDE.md rule 2 gives: a JSONata expression composing
 * `1280 × 720` beside a wire coordinate is presentation logic serialised into
 * an artefact nobody can review. `system/format.ts` made the same move for the
 * Status page's numbers and `displayFacts` is the shape this follows.
 *
 * **Nothing here decides anything about a camera.** Every value is a
 * restatement of what the device or the configuration already said; the one
 * arithmetic in the file is the IP overhead below, and it carries its
 * measurement.
 */

/**
 * What the encoder's configured rate costs on an uplink, measured.
 *
 * One 2000 kb/s stream on the board was 2003 kb/s of elementary stream, 2022
 * kb/s once RTP framing was added, and ~2067 kb/s at IP and UDP — over an 8 s
 * steady-state window. Rate control itself is within 0.2%, so the whole 3.35%
 * is framing rather than the encoder missing its target.
 *
 * **The IP figure is the one an uplink actually carries**, so it is the one
 * every number in this file counts, and the label says so. A budget that did
 * not name its layer would invite exactly the wrong conclusion from the 3%
 * an operator can see between the figure they chose and the figure they are
 * billed for.
 */
export const IP_OVERHEAD = 1.0335;

/**
 * What a field cellular uplink is taken to carry, in kb/s.
 *
 * **An assumption, and labelled as one wherever it is drawn.** Nothing in this
 * repository measures a carrier's uplink yet, and 1–5 Mb/s is the range these
 * links are actually seen at; 5000 is the optimistic end, so the budget errs
 * towards *not* crying oversubscription at a configuration that might fit.
 * The moment R-VID-11 has a measurement to use, this constant is what it
 * replaces.
 */
export const ASSUMED_UPLINK_KBPS = 5000;

/** The IP-layer cost of a configured encoder rate, rounded to whole kb/s. */
export function atIp(kbps: number): number {
  return Math.round(kbps * IP_OVERHEAD);
}

/** One output leaving over the path the budget measures (R-VID-11). */
export interface BudgetSegment {
  readonly label: string;
  /** At IP, the layer an uplink actually carries. */
  readonly kbps: number;
}

export interface UplinkBudget {
  readonly capacityKbps: number;
  readonly segments: readonly BudgetSegment[];
}

/**
 * Every stream this configuration puts on the uplink, and what the path
 * carries (R-VID-11).
 *
 * **The total lives on the Cameras page and not on any one camera's**, because
 * it is shared: *starting the second camera would need 2.1 Mb/s more* is a
 * sentence no single camera's page can say.
 *
 * A camera that is not enabled contributes nothing — it has no pipeline — and
 * the browser preview is counted once per camera because that is what watching
 * one costs while it is being watched (R-VID-13).
 */
export function uplinkBudget(
  cameras: readonly Camera[],
  capacityKbps: number = ASSUMED_UPLINK_KBPS,
): UplinkBudget {
  const segments: BudgetSegment[] = [];
  for (const camera of cameras) {
    if (!camera.enabled) continue;
    // One segment per consumer, not one per camera: the tee costs almost
    // nothing on the board (68% of a core for one output against 70% for two)
    // and every consumer that leaves over cellular costs its own bitrate. That
    // asymmetry is the whole reason this instrument exists.
    for (const output of camera.outputs) {
      segments.push({
        label: `${camera.name} · ${output.kind}`,
        kbps: atIp(camera.bitrate_kbps),
      });
    }
    segments.push({
      label: `${camera.name} · preview`,
      kbps: atIp(camera.preview.bitrate_kbps),
    });
  }
  return { capacityKbps, segments };
}

/**
 * One row of the facts row: a capability this camera's page does not offer a
 * control for, and which of the three reasons that is (R-UI-15).
 *
 *   - `not-offered` — the camera does not have it. Nothing is wrong.
 *   - `advertised` — it lists the capability, accepts the command and does
 *     nothing. Something is misreporting itself.
 *   - `undrawn` — the camera has it and this page does not draw it. Nothing is
 *     wrong with the device; the console has not been built that far.
 */
export interface CapabilityFact {
  readonly label: string;
  readonly state: "not-offered" | "advertised" | "undrawn";
  readonly reason?: string;
}

/**
 * The words an operator reads for each capability.
 *
 * Written out rather than derived from the key, because `whiteBalance` is not
 * a label and a page that showed one would be showing its own field names.
 */
const LABELS: Record<(typeof CAPABILITY_KEYS)[number], string> = {
  formats: "Capture formats",
  zoom: "Zoom",
  focus: "Focus",
  exposure: "Exposure",
  whiteBalance: "White balance",
  brightness: "Brightness",
  contrast: "Contrast",
  rotation: "Rotation",
  aim: "Aim",
  recording: "Recording",
  stills: "Stills",
};

/**
 * The capabilities a camera's page draws a control for.
 *
 * `brightness` and `contrast` are the two sliders on the Live deck.
 * `formats` is drawn as well, though not as a control: the readout strip
 * states the size and the rate the camera is capturing at, and the Setup deck
 * lets the rate be changed, so an operator is not left wondering what happened
 * to it.
 *
 * **Everything else the camera offers gets a row saying so**, which is the
 * half of R-UI-15 nobody was watching. `flows.test.ts` holds this list against
 * the shipped wiring, so a control added to the page without being named here
 * is drawn *and* reported as missing, and a control taken off the page is
 * reported.
 */
export const DRAWN_CAPABILITIES = ["formats", "brightness", "contrast"] as const;

/**
 * Everything this camera's page does not give the operator, stated (R-UI-15).
 *
 * **Three states, not two.** A capability that is `present` and has a control
 * is silent — a row as well would be the page saying both. A capability that
 * is `present` and has *no* control on this page was silent too, and that was
 * the requirement failing in the direction nothing was watching: the bench's
 * own camera answers `zoom`, `focus`, `exposure` and `whiteBalance` as
 * present, and the committed page image shows them nowhere at all — no
 * control, and no fact. An operator reads that page and concludes the camera
 * has two adjustable settings when it has six. R-UI-15 is *an operator must be
 * able to tell "this camera cannot" from "this page failed"*, and neither was
 * being said. `rotation` is the same hole: R-CTL-05 is built end to end in
 * `controls.ts` and has no control on any page.
 *
 * The order is `CAPABILITY_KEYS`, so adding a capability puts it in the right
 * place rather than at the end of whichever object literal was edited last.
 *
 * **Never hidden when the whole probe failed.** A camera that answered nothing
 * yields every row, which is the honest reading: an operator has to be able to
 * tell *this camera cannot* from *this page failed*, and an empty facts row on
 * a failed probe says neither.
 */
export function capabilityFacts(
  caps: CameraCapabilities,
  drawn: readonly (typeof CAPABILITY_KEYS)[number][] = [...DRAWN_CAPABILITIES],
): CapabilityFact[] {
  const facts: CapabilityFact[] = [];
  for (const key of CAPABILITY_KEYS) {
    const cap = caps[key] as Capability<unknown>;
    if (cap.state === "present") {
      if (!drawn.includes(key)) facts.push({ label: LABELS[key], state: "undrawn" });
      continue;
    }
    facts.push(
      cap.state === "advertised"
        ? { label: LABELS[key], state: "advertised", reason: cap.reason }
        : { label: LABELS[key], state: "not-offered" },
    );
  }
  return facts;
}

/**
 * The readout strip under the picture: what is running, and at what.
 *
 * Flat strings, because a widget binds a key and cannot divide bytes or
 * compose a resolution — see the file's opening note.
 */
export interface CameraStrip {
  /** What the supervisor observed, never what the configuration asked for. */
  readonly state: string;
  readonly picture: string;
  readonly rate: string;
  readonly bitrate: string;
  /** This camera's own share of the uplink, at IP. */
  readonly uplink: string;
  /**
   * Whether Start would be refused, and why (R-CAM-10).
   *
   * Always a sentence, never an empty string. A row labelled "cannot start"
   * with nothing after it reads as *this camera cannot start* — the opposite
   * of what a null refusal means — and a page that says the opposite of the
   * truth when everything is fine is worse than one that says nothing.
   */
  readonly startCheck: string;
  /**
   * What watching this camera in the browser costs, both copies, before it is
   * asked for (R-VID-11).
   *
   * **Computed here, and it has to be.** These two strings were literals in
   * `flows.json` — `preview 0.41 Mb/s · full rate 2.07 Mb/s at IP` — which are
   * this fixture's numbers frozen at deploy time. Raise `bitrate_kbps` to 8000
   * and the page said 2.07 while the readout strip beside it, which *is*
   * computed, said 8.27: the figure an operator uses to decide whether to
   * spend a field uplink, wrong by four times, sitting next to the right one.
   * R-VID-11 is about stating the cost *before* it is asked, so a stale cost
   * is the requirement failing rather than a cosmetic slip.
   */
  readonly pictureCost: string;
  /** What holding the full-rate key costs, or why there is nothing to hold. */
  readonly holdCost: string;
  /**
   * Whether a full-rate stream exists on this device at all.
   *
   * The full-rate path is published only where an RTSP output is configured
   * (`media/config.ts`, `pipeline.ts`), so on a camera with only an `rtp`
   * output — or none — holding FULL RATE asks for a path that does not exist
   * and gets a 404 the picture reports as "this camera is not streaming".
   * R-UI-15's own exception clause is that the soft-key rail carries only what
   * can be done.
   */
  readonly fullRate: boolean;
  /** The `/dev` node the configured by-path name resolves to right now. */
  readonly device: string;
  /** Whether that identity survives a reboot (R-CAM-05), in words. */
  readonly identity: string;
  readonly encoder: string;
}

/** What `state()` reports, and the reason where the supervisor has one. */
function runWords(state: string, reason: string | undefined): string {
  return reason === undefined || reason === "" ? state : `${state} — ${reason}`;
}

/**
 * `byPathStable` in words, which is the only form of it an operator can act
 * on (R-CAM-05, R-UI-15).
 *
 * Nothing rendered this until the Cameras page did, and until something does
 * the stable-identity work stops at the type: a `false` here means the
 * configured camera is held by an enumeration number that the next boot may
 * hand to a different device, and the operator is the only one who can move
 * the plug or fix the configuration.
 */
export function identityWords(byPath: string | null, stable: boolean): string {
  if (byPath === null) return "not resolved — this camera did not answer";
  return stable
    ? `${byPath} — survives a reboot`
    : `${byPath} — an enumeration number; it may mean a different camera after a reboot`;
}

export function cameraStrip(view: {
  camera: Camera;
  run: { state: string; reason?: string };
  device: string | null;
  byPathStable: boolean;
  encoder: { element: string; hardware: boolean };
  refusal?: string | null;
}): CameraStrip {
  const { camera } = view;
  const outputs = camera.outputs.length;
  const own = atIp(camera.bitrate_kbps) * outputs + atIp(camera.preview.bitrate_kbps);
  const mbps = (kbps: number): string => (atIp(kbps) / 1000).toFixed(2);
  // The browser's full rate comes off the same path a ground station's RTSP
  // does, so it exists exactly where that output does.
  const fullRate = camera.outputs.some((o) => o.kind === "rtsp");
  return {
    state: runWords(view.run.state, view.run.reason),
    picture: `${camera.width} × ${camera.height}`,
    // Units keep their case, always: `FPS` says nothing and `KB/S` says
    // kilobytes.
    rate: `${camera.framerate} fps`,
    bitrate: `${camera.bitrate_kbps} kb/s`,
    uplink: `${(own / 1000).toFixed(2)} Mb/s at IP`,
    pictureCost: fullRate
      ? `preview ${mbps(camera.preview.bitrate_kbps)} Mb/s · full rate ${mbps(camera.bitrate_kbps)} Mb/s at IP`
      : `preview ${mbps(camera.preview.bitrate_kbps)} Mb/s at IP`,
    holdCost: fullRate
      ? `${mbps(camera.bitrate_kbps)} Mb/s while held`
      : "no full-rate stream on this camera; add an RTSP output",
    fullRate,
    startCheck: view.refusal ?? "nothing is stopping it",
    device: view.device ?? "not resolved",
    identity: identityWords(view.device === null ? null : camera.device, view.byPathStable),
    encoder: `${view.encoder.element} · ${view.encoder.hardware ? "hardware" : "software"}`,
  };
}
