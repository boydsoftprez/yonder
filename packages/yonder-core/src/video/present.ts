// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";
import {
  CAPABILITY_KEYS, noCapabilities, present,
  type CameraCapabilities, type Capability, type ControlRange,
  type RecordingCapability, type StillsCapability,
} from "./capability.js";
import { describe, type DescriptorView } from "./descriptors.js";
import { FLIP_KEYS, TURNED_BY_SAYS, turnedBy, turningSays, type FlipKey } from "./orientation.js";
import { outputReach, type OutputKind, type OutputReach, type ReachPaths } from "./outputs.js";
import type { RecordingState } from "./recorder.js";
import type { RunState } from "./supervisor.js";

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

/**
 * The other way: the largest encoder rate whose IP cost fits in `kbps`.
 *
 * The exact inverse of `atIp`, and it has to be exact rather than
 * `kbps / IP_OVERHEAD`: `atIp` rounds, so plain division loses a kb/s
 * wherever the rounding went down, and the rate controller that divides a
 * budget up (`video/rate.ts`) would then leave a kilobit of a cellular uplink
 * unspent on every allocation for ever. `atIp(w) ≤ k` exactly when
 * `w × overhead < k + 0.5`, which is what this computes.
 *
 * Here rather than beside its caller because it is the same measured
 * overhead read backwards, and a second copy of that number is a number that
 * can drift from this one.
 */
export function fromIp(kbps: number): number {
  return Math.max(0, Math.ceil((kbps + 0.5) / IP_OVERHEAD) - 1);
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
 * one costs while it is being watched (R-VID-13). **A disabled output
 * contributes nothing either (R-VID-16)**: it has no branch in `compose()`
 * (`video/pipeline.ts`), so charging its bitrate here would bill an operator
 * for a stream that is not running — the fix mirrors `compose()`'s own
 * filter, one line above the loop it belongs to.
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
    for (const output of camera.outputs.filter((o) => o.enabled)) {
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
 * control for, and which of the four reasons that is (R-UI-20, R-UI-21).
 *
 *   - `not-offered` — the camera does not have it. Nothing is wrong.
 *   - `advertised` — it lists the capability, accepts the command and does
 *     nothing. Something is misreporting itself.
 *   - `gated` — another control has charge of it right now. Nothing is
 *     wrong, and `reason` names that control the way an operator would,
 *     rather than by its V4L2 identifier.
 *   - `undrawn` — the camera has it and this page does not draw it. Nothing is
 *     wrong with the device; the console has not been built that far.
 */
export interface CapabilityFact {
  readonly label: string;
  readonly state: "not-offered" | "advertised" | "gated" | "undrawn";
  readonly reason?: string;
}

/**
 * The words an operator reads for each capability.
 *
 * Written out rather than derived from the key, because `whiteBalance` is not
 * a label and a page that showed one would be showing its own field names.
 *
 * Exported so a test can ask for `LABELS.exposure` rather than repeating the
 * literal `"Exposure"` — the same reason `CAPABILITY_KEYS` is exported from
 * `capability.ts` rather than re-typed at every call site.
 */
export const LABELS: Record<(typeof CAPABILITY_KEYS)[number], string> = {
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
  saturation: "Saturation",
  hue: "Hue",
  autoWhiteBalance: "Auto white balance",
  gamma: "Gamma",
  gain: "Gain",
  powerLineFrequency: "Mains frequency",
  sharpness: "Sharpness",
  backlightCompensation: "Backlight compensation",
  autoExposure: "Auto exposure",
  autoFocus: "Auto focus",
  // The operator's words, not V4L2's `horizontal_flip`/`vertical_flip`
  // (R-CTL-05) — the same two strings `DESCRIPTORS` carries, for the same
  // reason `whiteBalance` is "White balance" here.
  horizontalFlip: "Mirror",
  verticalFlip: "Flip",
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
 * half of R-UI-20 nobody was watching. `flows.test.ts` holds this list against
 * the shipped wiring, so a control added to the page without being named here
 * is drawn *and* reported as missing, and a control taken off the page is
 * reported.
 */
export const DRAWN_CAPABILITIES = ["formats", "brightness", "contrast"] as const;

/**
 * The row for a capability the loop below has already ruled `present` out
 * of — built by a `switch` that **returns** from every case rather than
 * `push`ing and `break`ing, and carries no `default:`.
 *
 * That shape is load-bearing, not a style choice. This project's
 * `strict: true` turns "a path falls off the end of a function whose return
 * type excludes `undefined`" into a real compile error (`strictNullChecks`),
 * and TypeScript's reachability analysis knows exactly which `case` is left
 * uncovered — so a fifth `Capability` state is a compile error here, at the
 * one place a person must decide how it reads, rather than a silent
 * `not-offered` on a page (which is exactly the bug this function was
 * rewritten to fix: it used to be a ternary between `advertised` and
 * everything else, so `gated` fell into "everything else" and told an
 * operator their camera had none of a control it was actively using).
 * A `default:` would take the guarantee back — it is exactly the branch
 * that would swallow a state nobody has decided how to draw yet. A `switch`
 * that only `push`es and `break`s inside the caller's loop does **not** get
 * this guarantee either: nothing downstream would force the compiler to
 * prove it exhaustive, so it would compile cleanly with a case missing and
 * silently drop that capability's row.
 */
function absentFact(
  label: string,
  cap: Exclude<Capability<unknown>, { readonly state: "present" }>,
): CapabilityFact {
  switch (cap.state) {
    case "not-offered":
      return { label, state: "not-offered" };
    case "advertised":
      return { label, state: "advertised", reason: cap.reason };
    case "gated":
      return { label, state: "gated", reason: cap.by.label };
  }
}

/**
 * Everything this camera's page does not give the operator, stated (R-UI-20).
 *
 * **Three states, not two.** A capability that is `present` and has a control
 * is silent — a row as well would be the page saying both. A capability that
 * is `present` and has *no* control on this page was silent too, and that was
 * the requirement failing in the direction nothing was watching: the bench's
 * own camera answers `zoom`, `focus`, `exposure` and `whiteBalance` as
 * present, and the committed page image shows them nowhere at all — no
 * control, and no fact. An operator reads that page and concludes the camera
 * has two adjustable settings when it has six. R-UI-20 is *an operator must be
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
    facts.push(absentFact(LABELS[key], cap));
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
  /**
   * The camera's own name — the operator's, never a label typed into a page
   * (R-UI-27).
   *
   * It is on the readout strip and not only on the deck's placard because the
   * deck is exchanged: Live and Setup swap, and for the moment between them
   * the only thing on the page saying *which camera this is* was a literal in
   * `flows.json` (`"label": "Front camera"`, this fixture's name, frozen at
   * deploy time on every device). The strip is on screen whichever deck is.
   */
  readonly name: string;
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
   * R-UI-20's own exception clause is that the soft-key rail carries only what
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
 * on (R-CAM-05, R-UI-20).
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

/**
 * The socket a configured camera expects, where the sweep matched it to
 * nothing (R-CAM-05, R-UI-20).
 *
 * `identityWords()` has two branches and neither is this one. Both of its
 * answers are about a camera that *answered*: it either has a by-path name
 * that survives a reboot or an enumeration number that does not. Its `null`
 * branch — "not resolved — this camera did not answer" — is the camera's own
 * page, where the socket is already stated beside it; on an index row it
 * would drop the one fact this row exists to carry, which is **which socket
 * this camera is configured on**. That string is what the operator moves a
 * plug to, or removes the entry for.
 *
 * "Nothing there answered" rather than "nothing is attached", because the
 * board cannot tell the two apart and the second claims more than it saw: a
 * camera can be plugged in and refuse to enumerate, and it would appear here
 * exactly as an empty socket does.
 */
export function absentIdentityWords(device: string): string {
  return `${device} — configured on this socket; nothing there answered`;
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
    name: camera.name,
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

/* ------------------------------------------------------------------------ *
 * The three payloads the instrument library reads (R-UI-08, R-CAM-12).
 *
 * `ui-yonder-deck`, `ui-yonder-aim` and `ui-yonder-index` were each built
 * against a payload shape and none of them was ever wired: `Detection` and
 * `Rejection` carry `{ device, card, byPath, capabilities }` and
 * `{ device, card, reason }`, with no `id`, `name`, `bus`, `state`, `tone` or
 * `rate` anywhere between them. This is the seam, and it is here rather than
 * in `daemon/routes.ts` or in a `change` node for the reason the rest of this
 * file gives: composing a page's values is presentation, it belongs in a
 * package with tests, and a JSONata expression beside a wire coordinate is
 * CLAUDE.md rule 2 wearing a different hat.
 * ------------------------------------------------------------------------ */

/**
 * The four tones every state-bearing part of this console draws from
 * (`console/command.ts`'s own register, R-UI-11). Restated as a type here
 * rather than imported, because a camera's *run* state is not a
 * `CommandStatus` and must not be routed through `presentation()` — the
 * apply/confirm vocabulary (idle · pending · confirmed · rejected) means
 * something else entirely, and a run state passed through it would draw the
 * wrong words in the wrong colour. `YonderIndex.vue`'s own doc comment
 * states the same conclusion from the component's side.
 */
export type RunTone = "good" | "waiting" | "bad" | "neutral";

/** One camera as the Cameras index draws it. */
export interface CameraRow {
  /**
   * The configured id, or `null` where a camera was detected on a socket
   * nothing is configured for.
   *
   * **Not the enumeration number, and not the card name** (R-CAM-05). A
   * configuration stores the *socket* — the `/dev/v4l/by-path/` name — and
   * this id is the one whose `device` matches the socket this camera was
   * found on. That is the whole of how an id survives a replug: unplug the
   * camera and plug it back into the same socket and `byPath` is the same
   * string, so the same configured camera is matched, whatever `/dev/videoN`
   * the kernel hands it this time. Move it to a different socket and it is a
   * different camera as far as the configuration is concerned, which is the
   * honest answer — nothing here can tell one identical UVC camera from
   * another. `identity` below carries the case the kernel publishes no
   * by-path name at all, where the match is by enumeration number and will
   * mean a different camera after a reboot.
   */
  readonly id: string | null;
  readonly name: string;
  /** Where it is attached: the source and the node the socket resolves to now. */
  readonly bus: string;
  /** What it is configured to send, or why there is nothing to say. */
  readonly spec: string;
  /** R-CAM-05 in words, from `identityWords()` — the same sentence the page uses. */
  readonly identity: string;
  /** One word for the supervisor's observed run state. Never the configuration's. */
  readonly state: string;
  readonly tone: RunTone;
  /**
   * Measured egress, in Mb/s at IP — **never the configured target**.
   *
   * `null` until something measures it, which nothing in this repository does
   * yet (see `ASSUMED_UPLINK_KBPS` above, and spec §8.1's rate controller).
   * A configured `bitrate_kbps` is what an operator asked for; printing it
   * here would put a number on the page that nobody measured, in the column
   * an operator reads to find out what is actually going out. `YonderIndex`
   * draws `null` as "none" rather than as a gap, so absence is stated.
   */
  readonly rate: number | null;
  /**
   * The `by-path` socket this camera was found on — **not `/dev/videoN`**
   * (R-CAM-05).
   *
   * Carried so a row with no `id` has something to act on. A detected camera
   * on a socket nothing is configured for used to be a dead end: the row was
   * drawn, its OPEN key disabled with a correct reason, and nothing anywhere
   * could give it an entry. `POST /cameras { device }` takes exactly this
   * string, and it is the socket rather than the enumeration name because
   * that is what still means this camera after a replug.
   */
  readonly device: string;
  /**
   * What the device answered when the probe asked it, or **`null` where
   * nothing was asked because nothing answered** (R-CAM-14, R-UI-20).
   *
   * `null` on exactly one kind of row: a configured camera the sweep matched
   * to no detection. `noCapabilities()` would be the easy value to put here
   * and it would be a lie — it reads out as `aim: none · zoom: none · …`,
   * twenty-one statements about a camera this board cannot see, in the line
   * an operator reads to find out what a camera can do. An operator must be
   * able to tell *this camera cannot* from *this camera was not there to
   * ask*, which is R-UI-20's own sentence. `YonderIndex` draws no probe
   * summary at all for null.
   */
  readonly capabilities: CameraCapabilities | null;
  /**
   * Why this camera cannot be taken out of the configuration right now, or
   * `null` when nothing is stopping it (R-CAM-21).
   *
   * The same shape and the same reason as `CameraStrip.startCheck`: the row
   * carries the refusal so the key that would be refused is drawn inoperative
   * *with the reason on it*, rather than live and answered with a 409 the
   * page has nowhere to put. The Cameras page's own wiring reads the list
   * again after a press, so a refusal travelling back on `msg.yonder` is
   * overwritten by the next sweep before anything could draw it — which is
   * how a refusal "in words" becomes no words at all.
   *
   * Non-null on a row with no `id` too: there is no configured camera on that
   * socket, so there is nothing to remove. That row draws the key that
   * *adopts* it instead.
   */
  readonly removal: string | null;
}

/** One device the probe refused, and why (R-CAM-12). */
export interface RejectionRow {
  readonly device: string;
  readonly reason: string;
}

export interface CameraIndex {
  readonly cameras: readonly CameraRow[];
  readonly rejected: readonly RejectionRow[];
}

/**
 * The supervisor's run state, in the operator's words and a tone.
 *
 * Exhaustive by construction: every case returns, there is no `default:`, and
 * the return type is written out — all three, because an inferred return type
 * widens to `string | undefined` and lets a missing case through (the same
 * shape, and the same reasoning, as `absentFact` above).
 *
 * **One word, never the reason.** `runWords()` appends the supervisor's
 * failure reason for the readout strip, which has room for a sentence; an
 * index row draws this inside a lamp-and-caption pill, and a 104-character
 * GStreamer failure in it is a row that cannot be laid out at any width. The
 * reason is on that camera's own page, one press away, where the operator
 * goes to act on it.
 */
function runState(state: RunState): { state: string; tone: RunTone } {
  switch (state) {
    case "running":
      return { state: "Streaming", tone: "good" };
    case "starting":
      return { state: "Starting", tone: "waiting" };
    case "failed":
      return { state: "Failed", tone: "bad" };
    case "stopped":
      return { state: "Idle", tone: "neutral" };
  }
}

/**
 * Why a camera may not be taken out of the configuration, or `null`
 * (R-CAM-21).
 *
 * **Removing a camera is not a way to stop it.** A pipeline that is up is a
 * picture somebody is watching and an uplink somebody is paying for, and an
 * operator who wants it to stop has a Stop key that says so. Taking the
 * camera's entry out from under a running pipeline is the same press wearing
 * a disguise, and it is irreversible in the direction that matters: the
 * configuration is what the pipeline was composed from.
 *
 * `failed` and `stopped` both allow it, and the distinction is deliberate —
 * a camera that failed is a camera whose pipeline exited, which is very often
 * *because* the device is not there. Refusing to remove exactly the entries
 * an operator most needs to remove would be this guard defeating its own
 * purpose.
 *
 * Exhaustive by construction — every case returns, no `default:`, the return
 * type written out — for the reason `runState()` above gives.
 *
 * Exported so `daemon/routes.ts` refuses in the same words the row is drawn
 * with. Two sentences for one rule is how a page and a daemon come to
 * disagree about why something did not happen.
 */
export function removalRefusal(run: RunState): string | null {
  switch (run) {
    case "running":
      return "this camera is streaming; stop it before taking it out of the configuration";
    case "starting":
      return "this camera is starting; stop it before taking it out of the configuration";
    case "failed":
    case "stopped":
      return null;
  }
}

/** What a row with no configured camera behind it says about being removed. */
const NOTHING_TO_REMOVE = "nothing is configured on this socket, so there is nothing to remove";

/**
 * What the Cameras page draws (R-CAM-12, R-CAM-20, R-UI-03, R-CAM-05).
 *
 * **A row per detection *and* a row per configured camera** — the union, and
 * never one of the two alone.
 *
 * This used to map `input.found` only, and the sentence justifying it was
 * that a configured camera which is not plugged in "has no row here — its
 * absence is the fact". The operator found what that sentence costs. A camera
 * had been moved between USB ports; a camera's identity is its socket
 * (R-CAM-05), so each move made it a *different* camera as far as the
 * configuration was concerned, and the board ended up with two entries
 * pointing at empty ports and the camera actually in his hand matching
 * neither. The page said **"not configured"** about the only camera present
 * and drew nothing at all about the two it was configured for — while the
 * navigation, built from the configuration, carried both. The honest reading
 * of a page like that is that the console is broken.
 *
 * An absence is a fact only where something states it. This is R-UI-20's own
 * argument, one level up from the capability rows it was written about: an
 * absent reading and a reading of nothing are different facts, and drawing
 * neither is worse than drawing either.
 *
 * So there are three kinds of row, and every one of them is drawn:
 *
 * - **configured, and found** — the ordinary camera, with its supervisor's
 *   observed run state;
 * - **found, and configured nowhere** — `id: null`, `state: "Not
 *   configured"`. There is a camera here and Yonder is not set up for it,
 *   which is exactly the thing an operator has to be told; `YonderIndex`
 *   draws no OPEN key for it, because there is no page to open (R-UI-03),
 *   and offers the key that adopts it instead;
 * - **configured, and found nowhere** — `state: "Not attached"`, carrying
 *   the socket it expects and no capabilities, because nothing answered to
 *   be asked. `YonderIndex` offers the key that removes it (R-CAM-21).
 *
 * The rejection list beside all three is still where a device that is present
 * and unusable appears (R-CAM-12).
 */
export function cameraIndex(input: {
  readonly found: readonly {
    readonly device: string;
    readonly card: string;
    readonly byPath: string;
    readonly byPathStable: boolean;
    readonly capabilities: CameraCapabilities;
  }[];
  readonly rejected: readonly RejectionRow[];
  readonly cameras: readonly Camera[];
  /** The supervisor's own observation for a configured id (R-CTL-10). */
  readonly run: (id: string) => RunState;
  /**
   * Measured egress for a configured id, in kb/s at IP, or `null`.
   *
   * A seam and not a default: the daemon has nothing to put here today and
   * passes nothing, so every row reads `rate: null`. It exists so that the
   * day something measures egress there is one place to connect it, and so
   * that no caller can reach for `bitrate_kbps` instead without editing this
   * signature.
   */
  readonly egressKbps?: (id: string) => number | null;
}): CameraIndex {
  /**
   * Which configured cameras a detection accounted for — **by id, not by
   * socket.**
   *
   * By id because that is what makes "every configured camera is drawn
   * somewhere" true by construction rather than by luck. A configuration can
   * name two cameras on one socket — `POST /cameras` refuses to write the
   * second, but a hand-written `config.yaml` is not obliged to ask it — and a
   * set of matched sockets would mark that socket accounted for, leave the
   * second entry matched by nothing, and drop it from the page. Which is the
   * defect this function is being changed to fix, in miniature.
   */
  const matched = new Set<string>();
  const cameras = input.found.map((detected): CameraRow => {
    const configured = input.cameras.find((c) => c.device === detected.byPath);
    const identity = identityWords(detected.byPath, detected.byPathStable);
    const bus = `${configured?.source ?? "usb"} · ${detected.device}`;
    if (configured === undefined) {
      return {
        id: null,
        name: detected.card,
        bus,
        spec: "not configured",
        identity,
        state: "Not configured",
        tone: "neutral",
        rate: null,
        device: detected.byPath,
        capabilities: detected.capabilities,
        removal: NOTHING_TO_REMOVE,
      };
    }
    matched.add(configured.id);
    const measured = input.egressKbps?.(configured.id) ?? null;
    const run = input.run(configured.id);
    return {
      id: configured.id,
      // The socket the camera was found on, which is the socket the
      // configuration matched — carried on both branches so the row's shape
      // does not depend on whether it happens to be configured.
      device: detected.byPath,
      name: configured.name,
      bus,
      spec: `${configured.codec.toUpperCase()} · ${configured.width}×${configured.height}p${configured.framerate}`,
      identity,
      ...runState(run),
      // Mb/s at IP, the layer an uplink actually carries — the same layer
      // every other rate on this console is stated at (`IP_OVERHEAD` above).
      rate: measured === null ? null : Number((atIp(measured) / 1000).toFixed(2)),
      capabilities: detected.capabilities,
      removal: removalRefusal(run),
    };
  });

  /**
   * Every configured camera the sweep matched to nothing (R-CAM-20).
   *
   * **After the found rows, never interleaved with them.** What is attached
   * to this board is still the page's first subject, and an operator scanning
   * for the camera in their hand should not have to read past two entries for
   * cameras that are not there to find it. The order is also the one the
   * operator meets these in: a row appears down here on the day something is
   * unplugged, or on the day it is moved to another port and appears twice —
   * once up there with no id, once down here with no device.
   *
   * `state` is **not** `runState(input.run(id))`. The supervisor answers
   * `stopped` for a camera that is idle and for a camera that is not on the
   * bus at all, and drawing both as `Idle` is precisely the confusion that
   * left two dead entries on a board unnoticed. `run` is still asked, and it
   * still decides `removal`: a pipeline can outlive the device it was reading
   * from (a camera can fall off the bus mid-flight), and removing a camera is
   * not the way to stop one.
   */
  const absent = input.cameras
    .filter((camera) => !matched.has(camera.id))
    .map((camera): CameraRow => ({
      id: camera.id,
      name: camera.name,
      // Where the `/dev` node would be, there is none — said, rather than
      // left as an empty half of the line.
      bus: `${camera.source} · no device`,
      // What it is configured to send, exactly as a found camera's row states
      // it. The configuration has not stopped saying it; the camera has
      // stopped being there to say it to.
      spec: `${camera.codec.toUpperCase()} · ${camera.width}×${camera.height}p${camera.framerate}`,
      identity: absentIdentityWords(camera.device),
      state: "Not attached",
      // The strongest of the four, and deliberately: this is an aircraft
      // configured for a camera it does not have. It is either a camera that
      // fell off the bus — the failure K-46 is about, which an operator has
      // to know about while they can still act on it — or an entry left
      // behind by a replug, which is wrong and now has a key to clear it.
      // Drawn neutral, it is what nobody noticed for three configurations.
      tone: "bad",
      rate: null,
      // The socket it expects. The one string an operator can act on: move a
      // plug back to it, or remove the entry that names it.
      device: camera.device,
      capabilities: null,
      removal: removalRefusal(input.run(camera.id)),
    }));

  return { cameras: [...cameras, ...absent], rejected: input.rejected };
}

/** One output as the deck draws it. */
export interface DeckOutput {
  readonly kind: OutputKind;
  readonly label: string;
  readonly enabled: boolean;
  /** At IP, like every other rate here. */
  readonly costKbps: number;
  readonly reach: OutputReach;
}

/**
 * One of the three controls that turn the picture, as the deck draws it
 * (R-CTL-05, R-CTL-15).
 *
 * **There is no `state` here, and that absence is the whole point.** Every
 * other control on the deck carries one of `Capability`'s four, and
 * `not-offered` draws a fact where the control would have been. Orientation
 * can never be in that state: where the sensor will not turn the picture the
 * board does, after decoding (`video/orientation.ts`), so the operator is
 * offered a control that works either way and the row that says *this camera
 * has none* would be false on every camera Yonder has met. What varies is
 * not whether there is a control but **which of the two carries it**, and
 * that is `by`.
 */
export interface DeckTurn {
  readonly key: FlipKey;
  /** `sensor` where the camera will carry this one, `board` where the pipeline must. */
  readonly by: "sensor" | "board";
  /**
   * The sentence beside *this* control saying which of the two carries it, or
   * `null` when the group's own line already says it.
   *
   * `null` on every camera anyone has met, because all three are carried by
   * the same one and three copies of one sentence is three times the words
   * and none of the information. It is not null where the three genuinely
   * disagree — a camera that mirrors in its sensor and cannot rotate — which
   * is the only case one line under the group cannot carry.
   */
  readonly says: string | null;
  /**
   * Where this one is now, in the units the schema stores: `1`/`0` for the
   * two flips, degrees for the rotation, `null` for no reading at all.
   *
   * **Read from whichever of the two is actually carrying it.** A control the
   * sensor holds reports the device's own read-back (R-CTL-10, the same
   * `values` every other control on this deck draws from); a control the
   * board holds has no device reading to report — the sensor does not have
   * the control — so the stored request is the only fact there is, and it is
   * the one the pipeline is acting on. Showing `values` for a board-turned
   * control would draw `null` beside a picture that is visibly turned.
   */
  readonly value: number | null;
}

/** Who turns this camera's picture, for the deck to draw and to say (R-CTL-15). */
export interface DeckOrientation {
  /**
   * The one line beneath the group — `orientation.ts`'s own `turningSays()`.
   *
   * About the *camera*, not about the picture: which of the two would carry a
   * turn asked for here, which is the question an operator choosing between
   * remounting the camera and paying for the correction is asking, and it has
   * an answer while nothing is turned. It carries the quarter-turn cost when
   * the board is actually making one.
   */
  readonly says: string;
  /** The three, always drawn, in `FLIP_KEYS`' order. */
  readonly turns: readonly DeckTurn[];
}

/**
 * What this camera is configured to capture — the third policy block, beside
 * `stream` and `preview` (R-VID-07, R-CAM-14).
 *
 * **Schema-shaped and schema-cased**, exactly as the other two are: these are
 * `Camera`'s own four leaves, not a composed sentence. The `spec` string on
 * `CameraDeck.camera` says the same numbers in words for the placard, and
 * that is all it can do — a string is not a value a picker can be set from
 * and not a value `appliedForDraft()` can compare a staged edit against.
 *
 * It was absent, and the absence had teeth: the deck stages `width`,
 * `height` and `framerate` under those exact names, so with nothing to
 * compare them to every staged size stayed pending for ever and
 * `interruption()` warned of a restart even when the operator picked the
 * size already running.
 */
export interface DeckCapture {
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly codec: Camera["codec"];
}

/** `ui-yonder-deck`'s whole payload — `YonderDeck.vue`'s own documented shape. */
export interface CameraDeck {
  readonly camera: { readonly id: string; readonly name: string; readonly spec: string };
  readonly capabilities: CameraCapabilities;
  readonly descriptors: Record<string, DescriptorView>;
  readonly values: Record<string, number | null>;
  readonly commanded: Record<string, number | null>;
  readonly policy: {
    readonly capture: DeckCapture;
    readonly stream: Camera["stream"] & { bitrate_kbps: number };
    readonly preview: Camera["preview"];
  };
  readonly applied: {
    readonly capture: DeckCapture;
    readonly stream: Camera["stream"] & { bitrate_kbps: number };
    readonly preview: Camera["preview"];
  };
  readonly outputs: readonly DeckOutput[];
  readonly captures: { readonly count: number };
  /**
   * What this camera's recorder is doing, and what the medium has left
   * (R-CAM-17, R-STO-06).
   *
   * **On the deck's own payload, not only on the camera view beside it.**
   * The capture column draws the shutter key, the line under it saying where
   * a capture lands and how much of the medium is left, and the elapsed time
   * while one is running — all three from this one field. Carried here rather
   * than left for the flow to graft on, because a `change` node copying a
   * sibling field across is wiring that has to be right, and this deck and
   * the REC pill on the picture would then be reading two different answers
   * from the same read.
   *
   * `null` where the daemon has no video layer at all — deliberately not a
   * state saying `recording: false`, which would be this payload claiming to
   * know something it has no source for.
   */
  readonly recorder: RecordingState | null;
  readonly orientation: DeckOrientation;
}

/**
 * Which medium holds a capture, in the words an operator reads (R-CAM-17,
 * R-CAM-18).
 *
 * Three surfaces say this same thing about the same fact — the line under the
 * shutter key (*to this board*), the banner over the picture when a still
 * lands (*saved · to this board*), and a row in the captures panel that Yonder
 * cannot fetch (*the camera's card*). Written once, because three copies of a
 * two-branch ternary is three chances for one of them to say "the board" while
 * the other two say "this board", on the same screen.
 */
export function heldWords(held: "board" | "camera"): string {
  return held === "board" ? "this board" : "the camera's card";
}

/**
 * The headroom under the shutter key, in the unit the mode is working in
 * (R-CAM-17, R-STO-06; blueprint L-45 and L-46).
 *
 * `to this board · 118 min free` in Video, `to this board · 3900 photos free`
 * in Photo, and `to the camera's card · no card in the camera` where the
 * medium is one this device does not measure. **One function, because the two
 * modes differ in a unit and in nothing else**, and a deck that composed each
 * separately is a deck where one of them keeps the destination and the other
 * loses it.
 *
 * **Minutes, not seconds.** `remainingSeconds` is what the reserve is measured
 * in and `01:58:20` is not a figure anybody plans a flight with; the
 * blueprint's own line reads minutes and so does this. Rounded down for the
 * reason the still estimate is: a number that turns out pessimistic costs
 * nothing, and an optimistic one costs the operator the recording they thought
 * they had room for.
 *
 * A `null` count is a medium nothing here can measure — the camera's own card
 * today — so the sentence says that rather than an amount. It never says
 * *0 min free* for *unknown*: those are opposite facts and the operator acts
 * differently on each.
 */
export function captureDestination(
  state: RecordingState | null,
  mode: "video" | "photo",
): string {
  if (state === null) return "";
  const where = `to ${heldWords(state.destination)}`;
  const left = mode === "photo" ? state.remainingPhotos : state.remainingSeconds;
  if (left === null) {
    return state.destination === "camera"
      ? `${where} · this device cannot see what is left on it`
      : `${where} · nothing here knows what is left`;
  }
  return mode === "photo"
    ? `${where} · ${String(left)} photos free`
    : `${where} · ${String(Math.floor(left / 60))} min free`;
}

/**
 * Why the last recording ended, when it ended by itself (R-STO-06).
 *
 * Empty while one is running and after an operator's own stop — a stop
 * somebody pressed needs no explanation, and a sentence under the key after
 * every stop would train them to stop reading it. `ended.reason` is the
 * recorder's own words, never a paraphrase: it names the reserve and the
 * figure, which is the thing the operator has to change.
 */
export function endedWords(state: RecordingState | null): string {
  if (state === null || state.recording || state.ended === null) return "";
  return `the recording ended by itself · ${state.ended.reason}`;
}

/**
 * Who records this camera, and who photographs it (R-CAM-17, R-CAM-18).
 *
 * **This is the second place a `not-offered` capability does not become a
 * fact on the page, and it is deliberate for the same reason the first one
 * is** (`deckOrientation()`, R-CTL-15). `probe/camera.ts` is right that a USB
 * camera offers neither `recording` nor `stills`: it has no card and no
 * shutter, that is what the device answered, and `capabilityFacts()` and the
 * Cameras index both depend on it. It is not what *Yonder* can do.
 * `video/recorder.ts` records that camera off its own running pipeline and
 * takes a still off the raw tee — both proven on the board — so the picture
 * an operator is watching can be recorded and photographed either way.
 *
 * Read through the device's own answer, the capture column would be omitted
 * entirely on every camera this project has: no shutter key at all, on a
 * console that can record all of them. That is the page this function exists
 * to stop, and it is the same shape of mistake the Orientation group was
 * rewritten to remove.
 *
 * So the question asked here is not *does the device have a recorder* but
 * *who would carry a capture*: the camera's own medium where it has one — no
 * camera in this build does, and `CameraMedium` is the seam that answers
 * differently when one arrives — and this board otherwise. A daemon with no
 * video layer has neither, and there the device's own `not-offered` stands.
 */
export function deckCapture(
  caps: CameraCapabilities,
  recorder: RecordingState | null,
): Pick<CameraCapabilities, "recording" | "stills"> {
  if (recorder === null) return { recording: caps.recording, stills: caps.stills };
  const onCamera = recorder.destination === "camera";
  return {
    // A camera that answered for itself is left alone: the device saying
    // *this is mine* outranks anything composed here, which is what makes
    // this an addition rather than an override.
    recording: caps.recording.state === "not-offered"
      ? present<RecordingCapability>({ medium: onCamera ? "camera" : "board" })
      : caps.recording,
    stills: caps.stills.state === "not-offered"
      ? present<StillsCapability>({ source: onCamera ? "camera" : "pipeline" })
      : caps.stills,
  };
}

/** The words for an output kind, once, so two pages cannot disagree. */
const OUTPUT_LABEL: Record<OutputKind, string> = {
  rtp: "RTP · to the ground station",
  rtsp: "RTSP · a player connects",
  srt: "SRT · a player connects",
};

/**
 * Everything `ui-yonder-deck` draws, composed from what the device answered
 * and what the configuration holds (R-UI-08, R-CTL-10).
 *
 * **`descriptors` and `values` are the device's, `policy` is the
 * configuration's**, and the two are never mixed: an image control's current
 * reading comes from the probe (`ControlRange.current`, "what the device says
 * it is *now* — never what was last sent"), while a stream or preview policy
 * is what `config.yaml` holds, because that is the thing Apply changes.
 * `commanded` is the third and separate fact — the value `config.yaml` last
 * asked the device for — so a control whose reading disagrees with what was
 * commanded can draw both rather than silently showing one.
 *
 * **`applied` is `policy` today, and is still a second field.** Nothing on
 * this branch tracks a running pipeline's own settings apart from the
 * document it was started from, so the two are equal on every read. They stay
 * two names because a respawn in flight is exactly the moment they can
 * disagree, and the deck compares its draft against `applied` — pointing that
 * comparison at `policy` would be right by coincidence and wrong the day a
 * runtime tracker exists.
 *
 * **`captures.count` and `recorder` are the caller's**, read from the one
 * `Recorder` that holds both and handed in. They were `0` and absent here
 * while board recording was unbuilt; it is built now (R-CAM-17, R-CAM-18,
 * R-STO-06), and the capture column draws the count as a link to the panel
 * that lists them and the recorder state as the sentence under the shutter
 * key. A caller with no video layer passes neither, and a deck that says the
 * count is zero and the recorder is unknown is the honest reading of that.
 *
 * **There is no `interruption` here, and there was never a value this
 * function could put in it.** What a draft would interrupt is a fact about a
 * draft that has not been sent, and this daemon has never seen one: the field
 * was `[]` on every read, `YonderDeck` drew it, and the warning spec §8.1
 * asks for *before* Apply is pressed could not appear while two doc comments
 * said it did. The deck calls `interruption()` itself now, over its own
 * staged draft, and the apply route calls the same function over the draft it
 * was actually sent — one calculation, two callers, neither of them this one.
 */
export function cameraDeck(view: {
  readonly camera: Camera;
  readonly capabilities: CameraCapabilities | null;
  readonly encoder: { readonly element: string; readonly hardware: boolean };
  readonly paths: ReachPaths;
  /**
   * What the recorder answered for this camera, and how many captures it is
   * holding — both read by the caller, from the one recorder that owns them,
   * and handed in rather than reached for here.
   *
   * Injected for the same reason `capabilities` is: this function composes,
   * it does not go and find things out. Omitted on a caller with no video
   * layer, which is what `recorder: null` and a count of zero then say — and
   * the two are separate omissions because a device that is not recording
   * still holds every capture it made before it stopped.
   */
  readonly recorder?: RecordingState | null;
  readonly captures?: number;
}): CameraDeck {
  const { camera } = view;
  const caps = view.capabilities ?? noCapabilities();
  const descriptors: Record<string, DescriptorView> = {};
  const values: Record<string, number | null> = {};
  for (const key of CAPABILITY_KEYS) {
    const cap = caps[key] as Capability<unknown>;
    // A range is what `describe()` converts, and only these keys carry one:
    // `formats` is a list, `aim` a pair of ranges, `recording` and `stills`
    // are facts about where a capture goes. Each of those is drawn by its own
    // branch in `YonderDeck`, from `capabilities` directly.
    const value = cap.state === "not-offered" ? undefined : (cap as { value?: unknown }).value;
    if (value === undefined || typeof value !== "object" || !("current" in (value as object))) continue;
    const range = value as ControlRange;
    descriptors[key] = describe(key, range);
    values[key] = descriptors[key].current;
  }
  const commanded: Record<string, number | null> = {};
  for (const [key, raw] of Object.entries(camera.controls)) {
    commanded[key] = typeof raw === "number" ? raw : raw === null ? null : raw ? 1 : 0;
  }
  const policy = {
    capture: {
      width: camera.width,
      height: camera.height,
      framerate: camera.framerate,
      codec: camera.codec,
    },
    stream: { ...camera.stream, bitrate_kbps: camera.bitrate_kbps },
    preview: camera.preview,
  };
  return {
    camera: {
      id: camera.id,
      name: camera.name,
      spec: `${camera.source.toUpperCase()} · ${camera.codec.toUpperCase()} · `
        + `${camera.width}×${camera.height}p${camera.framerate} · ${view.encoder.element}`,
    },
    // The two the board carries for a camera that has neither of its own.
    // See `deckCapture()` for why this is composed rather than read.
    capabilities: { ...caps, ...deckCapture(caps, view.recorder ?? null) },
    descriptors,
    values,
    commanded,
    policy,
    applied: policy,
    outputs: camera.outputs.map((output) => ({
      kind: output.kind,
      label: OUTPUT_LABEL[output.kind],
      enabled: output.enabled,
      costKbps: atIp(camera.bitrate_kbps),
      reach: outputReach(output.kind, view.paths),
    })),
    captures: { count: view.captures ?? 0 },
    recorder: view.recorder ?? null,
    orientation: deckOrientation(caps, camera, values),
  };
}

/**
 * The Orientation group's whole answer: three controls that always draw, and
 * which of the two is turning the picture (R-CTL-05, R-CTL-15).
 *
 * **This is the one place a `not-offered` capability does not become a fact
 * on the page, and it is deliberate.** `probe/camera.ts` is right that the
 * bench camera offers no `horizontal_flip`, no `vertical_flip` and no
 * `rotate` — that is what the device answered and other things depend on it,
 * `applyControls`'s refusal among them. It is not what *Yonder* can do:
 * `video/pipeline.ts` composes a `videoflip` for exactly that camera, so the
 * picture turns either way. A deck that read the capability state directly
 * would draw three sentences saying the camera cannot, on a console that can
 * do all three — which is the page this function exists to stop.
 *
 * So the presentation layer answers a different question from the probe's:
 * not *does the device have this control* but *who carries it*. `turnedBy()`
 * is that answer, taken from `orientation.ts` rather than re-derived here, so
 * the sentence beside a control and the element in the launch line cannot
 * disagree.
 *
 * **`says` is about the camera, not about the picture, and that is the whole
 * difference.** `orientation()`'s own `method`/`note` report what is being
 * done to the picture right now, which says nothing at all while nothing is
 * turned — and *nothing is turned* is exactly the moment an operator is
 * deciding whether to turn something and needs to know what it will cost. So
 * the line drawn is `turningSays()`, which answers the standing question in
 * the same two sentences `note` uses, and carries the quarter-turn cost when
 * the board is actually making one.
 *
 * **Nothing on this payload is undrawn.** `method` and `note` are not carried
 * here: a field the deck reads nothing from is a field no test at the join
 * has to keep honest, which is how a guarantee on this branch has twice
 * stayed green while the feature did nothing. What they say reaches the page
 * through `says` and `by`, and `orientation.test.ts` holds those against
 * `orientation()` itself.
 */
function deckOrientation(
  caps: CameraCapabilities,
  camera: Camera,
  values: Record<string, number | null>,
): DeckOrientation {
  const carriers = FLIP_KEYS.map((key) => turnedBy(caps[key]));
  // Beside a control only where the group's own line cannot carry it — see
  // `DeckTurn.says`, and `turningSays()`'s own note on why that is one line.
  const agreed = carriers.every((by) => by === carriers[0]);
  return {
    says: turningSays(caps, camera.controls),
    turns: FLIP_KEYS.map((key, i) => {
      const by = carriers[i] as "sensor" | "board";
      // The two flips are booleans in the schema and `1`/`0` on the wire —
      // the same encoding `applyControls` sends and `commanded` above uses,
      // so one control's value means one thing everywhere on this payload.
      const stored = camera.controls[key];
      const asked = typeof stored === "number" ? stored : stored === null || stored === undefined ? null : stored ? 1 : 0;
      const read = values[key];
      return {
        key,
        by,
        says: agreed ? null : TURNED_BY_SAYS[by],
        value: by === "sensor" ? read ?? asked : asked,
      };
    }),
  };
}

/** `ui-yonder-aim`'s whole payload — `YonderAim.vue`'s own documented shape. */
export interface AimPanel {
  readonly state: Capability<unknown>["state"];
  readonly reason: string | null;
  readonly pan: number | null;
  readonly tilt: number | null;
  readonly bounds: { readonly pan: readonly [number, number]; readonly tilt: readonly [number, number] } | null;
  readonly atLimit: { readonly pitch: boolean; readonly yaw: boolean };
  readonly mode: string | null;
  readonly modes: readonly string[];
  readonly inhibited: string | null;
}

/**
 * The Aim panel, from the one capability that answers for it (R-CAM-11,
 * R-UI-28).
 *
 * Its own payload rather than a slice of the deck's, exactly as
 * `YonderAim.vue` states: the Cockpit (M5) carries this panel and the picture
 * with no deck beside them, so the panel's payload must not be a projection
 * of a shape the deck owns.
 *
 * **`mode`, `modes` and `atLimit` are what no camera on this branch answers.**
 * The gimbal mode byte (`0x4C`) and the limit flags (byte 10 of the `0x05`
 * push) are spec §8.7's, unbuilt — so the mode is `null`, the list is empty
 * and neither limit is set. Reporting a *guessed* mode would be the panel
 * claiming a fact about the gimbal that nothing read, which is the same
 * defect as an unmeasured rate one field over.
 */
export function aimPanel(caps: CameraCapabilities | null): AimPanel {
  const aim = (caps ?? noCapabilities()).aim;
  const empty = {
    pan: null, tilt: null, bounds: null,
    atLimit: { pitch: false, yaw: false },
    mode: null, modes: [] as string[],
  };
  if (aim.state === "not-offered") {
    return { state: "not-offered", reason: null, inhibited: null, ...empty };
  }
  if (aim.state === "advertised") {
    return { state: "advertised", reason: aim.reason, inhibited: null, ...empty };
  }
  if (aim.state === "gated") {
    return { state: "gated", reason: `${aim.by.label} has it`, inhibited: null, ...empty };
  }
  // The envelope, only where the device answered both ends of both axes.
  // A half-known envelope is not an envelope: drawing a gauge against a
  // bound nothing reported would put a scale on the page that no device
  // agreed to, and `YonderPositionGauge`'s own `dead` state exists for
  // exactly this case. `yaw` is pan and `pitch` is tilt — the gimbal's own
  // axis names on one side of this seam, the operator's on the other.
  const { yaw, pitch } = aim.value;
  const known = yaw.min !== null && yaw.max !== null && pitch.min !== null && pitch.max !== null;
  return {
    state: "present",
    reason: null,
    // §8.7's 20 Hz attitude push is unbuilt, so nothing has reported where
    // this gimbal is pointing. `null` is that fact; a zero would be a claim.
    pan: null,
    tilt: null,
    bounds: known
      ? { pan: [yaw.min as number, yaw.max as number], tilt: [pitch.min as number, pitch.max as number] }
      : null,
    atLimit: { pitch: false, yaw: false },
    // The one mode the probe does answer: the work mode the envelope above
    // was learned in. There is no list to choose from until `0x44` is built,
    // so the mode is drawn and cannot be changed.
    mode: aim.value.mode,
    modes: [],
    // §8.7's guard is unbuilt, and the honest report of an unbuilt guard is
    // that the panel is inhibited until one exists — not that it is live.
    // R-CMD-04: nothing here originates a motion command, and a pad that
    // could send one with no bounds check behind it would be the console
    // deciding what is safe.
    inhibited: "the motion guard is not built yet, so nothing is sent",
  };
}
