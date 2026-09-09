// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";
import type { Capability, CameraCapabilities, ControlRange } from "./capability.js";

/**
 * Which way up the picture leaves this board, and who turned it (R-CTL-05).
 *
 * **The sensor first, the board only when it must.** `video/controls.ts`
 * writes `horizontal_flip`, `vertical_flip` and `rotate` to the capture
 * device, and a sensor that turns its own readout costs nothing at all. The
 * bench camera implements none of the three — `probe/camera.ts` reads all
 * three names and this ELP answers `not-offered` to every one — so a mount
 * that needs the picture turned has nowhere to turn it, and the operator is
 * offered a control that cannot move. That is the whole reason this file
 * exists: when the sensor cannot, the board does, in the pipeline.
 *
 * **What the board's correction costs, and what it does not.** It is a
 * `videoflip` on already-decoded frames, so it adds no decode and no encode
 * — those are already there. A half-turn and either flip are memory moves.
 * A quarter-turn is a transpose, and a transpose is the dearest of the
 * eight. **No figure is written here or in `docs/hardware/`: this has not
 * been measured on a board**, and this project's hardware notes carry only
 * observed numbers. The measurement is owed.
 *
 * **Two things this file must never do, each with its own failure:**
 *
 * 1. **Turn the picture twice.** `applyControls` writes to the sensor
 *    whatever the sensor offers, whether or not this file is consulted. A
 *    board correction that repeated the sensor's would mirror a mirror —
 *    which is no mirror at all, silently, with `config.yaml`, the page and
 *    the launch line all agreeing that the picture is mirrored. So the board
 *    is given the *remainder*: the turn that takes what the sensor is
 *    actually doing to what the operator actually asked for, and nothing
 *    more. `orientation()` below does that subtraction as group arithmetic
 *    rather than by a table of cases, because eight orientations times eight
 *    is sixty-four cases and a table of sixty-four is a table with a mistake
 *    in it.
 *
 * 2. **Disagree with the sensor about which way round a quarter-turn goes.**
 *    A mirror and a half-turn commute with everything here, so splitting
 *    them between the sensor and the board is safe in any order. A
 *    quarter-turn does not commute with a mirror: mirror-then-quarter and
 *    quarter-then-mirror are two different pictures. The order is fixed
 *    below and stated, once, so the two halves cannot each pick their own.
 */

/**
 * `videoflip`'s `video-direction`, and the whole of it — the eight
 * symmetries of a rectangle, which is every orientation a camera on a mount
 * can be in. `auto` is deliberately absent: it reads the JPEG's own
 * orientation tag, which is a claim made by the camera about itself rather
 * than a correction the operator asked for, and R-CMD-04's rule that Yonder
 * relays and never originates applies to the picture as much as to a
 * command — the board turns the picture the operator asked it to turn, not
 * the one a file's metadata suggested.
 */
export type VideoDirection =
  | "identity" | "90r" | "180" | "90l"
  | "horiz" | "vert" | "ul-lr" | "ur-ll";

/** Who turns this camera's picture, and what the board adds to do its part. */
export interface Orientation {
  /**
   * `sensor` — the camera is doing all of it and the pipeline adds nothing.
   * `board` — some or all of it falls to the pipeline.
   * `none` — the picture is not turned at all.
   */
  readonly method: "sensor" | "board" | "none";
  /** The `videoflip` `video-direction` to compose, or null for no element. */
  readonly flip: VideoDirection | null;
  /** One sentence, for an operator, about which of them is turning it. */
  readonly note: string;
  /**
   * Whether the board's share is a **quarter** turn — a transpose, the
   * dearest of the eight, and the only one that swaps the picture's width and
   * height. A field rather than something a caller re-derives from `flip`,
   * because there are four directions that transpose and a second list of
   * them somewhere else is a second list to get wrong.
   */
  readonly transposes: boolean;
}

/**
 * What a quarter turn costs, appended to whatever sentence is being said
 * about it — one copy, because two pages saying it in two wordings is two
 * chances to soften one of them. Stated as a kind of cost, never as a number:
 * nothing here has been measured on a board.
 */
export const QUARTER_TURN_NOTE =
  " — a quarter turn transposes every frame, and swaps its width and height";

/**
 * One of the eight orientations, in the normal form the arithmetic below
 * needs: **mirror first, then quarter-turns** — `R^quarters ∘ H^mirrored`.
 *
 * Every one of the eight is exactly one such pair, so `then` and `undo` are
 * total and there is no orientation this type cannot name.
 */
interface Turn {
  /** Quarter-turns **clockwise**, applied after the mirror. */
  readonly quarters: 0 | 1 | 2 | 3;
  /** A left-for-right mirror, applied first. */
  readonly mirrored: boolean;
}

const STILL: Turn = { quarters: 0, mirrored: false };

/** Whether a turn leaves the picture exactly as it found it. */
function isStill(turn: Turn): boolean {
  return turn.quarters === STILL.quarters && turn.mirrored === STILL.mirrored;
}

/** Two quarter-turn counts, added into the four the group has. */
function quartersOf(n: number): 0 | 1 | 2 | 3 {
  return (((n % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

/**
 * `first`, and then `second` — the composition, in the order a frame meets
 * them, so `then(sensor, board)` reads the way the pipeline is built.
 *
 * The one identity the arithmetic rests on is that a mirror reverses the
 * sense of a rotation: `H ∘ R^k = R^-k ∘ H`. Pushing `second`'s mirror back
 * past `first`'s rotation therefore negates `first.quarters` exactly when
 * `second` is mirrored, and the two mirrors then meet and cancel or do not.
 * That is the whole rule, and it is why a quarter-turn cannot simply be
 * added to a mirror and left in either order.
 */
function then(first: Turn, second: Turn): Turn {
  return {
    quarters: quartersOf(second.quarters + (second.mirrored ? -first.quarters : first.quarters)),
    mirrored: first.mirrored !== second.mirrored,
  };
}

/** The turn that puts `turn` back — `then(turn, undo(turn))` is `STILL`. */
function undo(turn: Turn): Turn {
  // A mirrored turn is its own inverse: reflections have order two, whatever
  // axis they are about. An unmirrored one is undone by turning back.
  return { quarters: turn.mirrored ? turn.quarters : quartersOf(-turn.quarters), mirrored: turn.mirrored };
}

/**
 * The eight, named as `videoflip` names them.
 *
 * Derived rather than believed, with x to the right and y **down** the
 * frame, `R` a clockwise quarter-turn `(x, y) -> (-y, x)` and `H` the mirror
 * `(x, y) -> (-x, y)`:
 *
 * - `R¹ ∘ H` sends `(x, y)` to `(-y, -x)` — the reflection about the line
 *   from the upper *right* to the lower left, which is `ur-ll`.
 * - `R² ∘ H` sends `(x, y)` to `(x, -y)` — top for bottom, which is `vert`.
 *   **This is the brief's third case and it holds: a mirror followed by a
 *   half-turn is a vertical flip**, and because a half-turn commutes with
 *   everything, it is a vertical flip in either order.
 * - `R³ ∘ H` sends `(x, y)` to `(y, x)` — the transpose, the reflection
 *   about the upper-left-to-lower-right diagonal, which is `ul-lr`.
 */
const DIRECTION: Readonly<Record<"plain" | "mirrored", readonly VideoDirection[]>> = {
  plain: ["identity", "90r", "180", "90l"],
  mirrored: ["horiz", "ur-ll", "vert", "ul-lr"],
};

function directionOf(turn: Turn): VideoDirection {
  return DIRECTION[turn.mirrored ? "mirrored" : "plain"][turn.quarters];
}

/** The applied display transform, including both sensor and board contributions. */
export function imageDirection(controls: Partial<Camera['controls']>): VideoDirection {
  return directionOf(asked(controls, () => true));
}

/**
 * The turn a set of controls asks for: **the flips first, then the
 * rotation.**
 *
 * The order is a decision, not a discovery, and it is made here once because
 * the sensor and the board each perform a share of it (see rule 2 in the
 * header). It follows the physical chain — a mirror describes the optics,
 * which are fixed in the camera, and a rotation describes how the camera is
 * bolted to the airframe, which happens afterwards — and it is the order the
 * two flips would be read out of a sensor in before anything downstream
 * turned the result. The two flips commute with each other, so `horizontal`
 * and `vertical` need no order between them.
 *
 * `rotation` is degrees **clockwise**. V4L2's own `V4L2_CID_ROTATE` does not
 * state a direction, so this is a convention rather than a fact about the
 * kernel — written down because the sensor's share and the board's share
 * must agree about it, and because no camera on the bench implements
 * `rotate` for it to be checked against.
 */
function asked(controls: Partial<Camera["controls"]>, offered: (key: FlipKey) => boolean): Turn {
  // `null` is the schema's own "leave the camera alone" and `undefined` is a
  // key a `Partial` simply does not carry. Neither asks for anything, so
  // neither contributes a turn — the same reading `applyControls` gives them.
  const horizontal = controls.horizontalFlip === true && offered("horizontalFlip");
  const vertical = controls.verticalFlip === true && offered("verticalFlip");
  // A vertical flip is a mirror and a half-turn, which is how both flips
  // together come out as a plain half-turn and neither alone comes out as
  // any rotation at all — the fact `schema/config.ts` gives as its reason
  // for storing two switches rather than more degrees on `rotation`.
  const flips: Turn = {
    quarters: vertical ? 2 : 0,
    mirrored: horizontal !== vertical,
  };
  const degrees = offered("rotation") ? controls.rotation ?? 0 : 0;
  return then(flips, { quarters: quartersOf(degrees / 90), mirrored: false });
}

/** The three controls that turn a picture, as `CameraCapabilities` names them. */
export type FlipKey = "horizontalFlip" | "verticalFlip" | "rotation";

/**
 * The three, written out — the order the console draws them in.
 *
 * Written down rather than derived from `CameraCapabilities`, for the reason
 * `CAPABILITY_KEYS` itself is: a fourth way of turning a picture must be a
 * decision somebody made here, not a key that quietly appears or quietly
 * does not on a page.
 */
export const FLIP_KEYS = ["horizontalFlip", "verticalFlip", "rotation"] as const satisfies readonly FlipKey[];

/**
 * The sentence beside **one** control saying which of the two carries it
 * (R-CTL-15).
 *
 * **Drawn only where the three controls disagree.** Where they agree —
 * every camera anyone has met — `turningSays()` below says it once for the
 * whole group and these are not drawn at all: three copies of one sentence
 * is three times the words and none of the information, which is the shape
 * this shipped as once and the first thing visible in the capture.
 *
 * **Here rather than in the component**, beside the `note` wording below,
 * because these are the same sentence said about one control instead of the
 * whole picture: a page that wrote its own would be a second vocabulary for
 * one fact, free to drift from `note` the first time either is reworded.
 */
export const TURNED_BY_SAYS: Readonly<Record<"sensor" | "board", string>> = {
  sensor: "the camera turns this itself",
  board: "the board turns this after decoding",
};

/** The whole picture, carried by the sensor — `note`'s wording and `turningSays()`'s. */
const SENSOR_NOTE = "the camera turns this picture itself";
/** The whole picture, carried by the board. Same two callers, same one string. */
const BOARD_NOTE = "this camera cannot turn the picture itself, so the board turns it after decoding";

/**
 * Whether the **sensor** will carry out `key` — which is exactly the
 * question `applyControls` answers when it decides to run `v4l2-ctl`, and
 * is answered here the same way so the two cannot disagree about who is
 * turning the picture.
 *
 * Exhaustive over `Capability`'s states with the return type written out and
 * no `default:`, for the reason `capability.ts`'s own `summarise` gives: a
 * fifth state must fail to compile here rather than fall through to a
 * silent `false` and hand the board a correction the sensor is already
 * making.
 */
function sensorWillDo(capability: Capability<ControlRange>): boolean {
  switch (capability.state) {
    case "present":
      return true;
    case "not-offered":
      // The device does not have the control. This is the bench camera's
      // answer to all three, and the case this file was built for.
      return false;
    case "advertised":
      // It lists the control, takes the command and does nothing (R-UI-21).
      // `applyControls` refuses it, so the sensor turns nothing.
      return false;
    case "gated":
      // Real, working, and another control has charge of it right now.
      // `applyControls` refuses it too, so again the sensor turns nothing.
      return false;
  }
}

/**
 * Which of the two will carry `capability`'s share of the turn (R-CTL-15).
 *
 * **Never a third answer, and never "neither".** Turning the picture is
 * available on every camera: where the sensor will not do it, the board
 * does, after decoding — so this is a choice between two, not a report of
 * whether the device has a control. That is the whole difference between
 * this function and the `Capability` state it reads: `not-offered` is a true
 * fact about the *device* and it is never a true fact about *Yonder*, which
 * is why a page must ask this rather than reading the state directly and
 * drawing "this camera has none" over a control that works.
 *
 * The same `sensorWillDo` the board's own share is computed from, so the
 * sentence beside a control and the element in the pipeline cannot disagree
 * about who is turning the picture.
 */
export function turnedBy(capability: Capability<ControlRange>): "sensor" | "board" {
  return sensorWillDo(capability) ? "sensor" : "board";
}

/**
 * Who turns this camera's picture, and what the pipeline must add.
 *
 * The board's share is `asked ∘ sensor⁻¹` — the turn that takes the picture
 * the sensor is producing to the picture the operator asked for. When the
 * sensor is doing all of it that is the identity and no element is composed;
 * when the sensor is doing none of it, it is the whole correction; and when
 * the sensor is doing part of it, it is the rest, computed rather than
 * guessed. Rule 1 in the header is what that expression is for.
 */
export function orientation(
  capabilities: CameraCapabilities,
  controls: Partial<Camera["controls"]>,
): Orientation {
  const sensor = asked(controls, (key) => sensorWillDo(capabilities[key]));
  const wanted = asked(controls, () => true);
  const board = then(undo(sensor), wanted);

  if (isStill(board)) {
    return isStill(wanted)
      ? { method: "none", flip: null, note: "this picture is not turned", transposes: false }
      : { method: "sensor", flip: null, note: SENSOR_NOTE, transposes: false };
  }

  const flip = directionOf(board);
  // A quarter-turn is the one correction that transposes every frame rather
  // than moving it, and it is the one that also swaps the picture's width
  // and height — both worth saying to whoever is choosing it.
  const transposes = board.quarters === 1 || board.quarters === 3;
  return {
    method: "board",
    flip,
    note: transposes ? BOARD_NOTE + QUARTER_TURN_NOTE : BOARD_NOTE,
    transposes,
  };
}

/**
 * The one line the console draws beneath Mirror, Flip and Rotation
 * (R-CTL-15).
 *
 * **It is about the camera, not about the picture.** `orientation()`'s own
 * `note` says what is being done to the picture *right now*, which is the
 * honest report of a state and says nothing at all while nothing is turned —
 * and *nothing is turned* is exactly when an operator is deciding whether to
 * turn something, and needs to know what it will cost. So this answers the
 * standing question instead: which of the two would carry a turn asked for
 * here. It borrows the same two sentences, so the line under the group and
 * the line `orientation()` writes cannot drift apart.
 *
 * **One line and not three.** Drawn once for the whole group rather than
 * beside each control, because on every camera anyone has met all three are
 * carried by the same one and three copies of one sentence is three times
 * the words and none of the information — the shape this shipped as once,
 * and the first thing visible in the capture. Where the three genuinely
 * disagree this says so and stands aside: the deck then draws
 * `TURNED_BY_SAYS` on each control, which is the only case a single sentence
 * cannot carry.
 *
 * The quarter-turn clause is appended when the board is actually making one,
 * because that is a fact about what is happening rather than about what
 * could — and it is the one cost on this group worth interrupting a decision
 * for.
 */
export function turningSays(
  capabilities: CameraCapabilities,
  controls: Partial<Camera["controls"]>,
): string {
  const carriers = FLIP_KEYS.map((key) => turnedBy(capabilities[key]));
  const tail = orientation(capabilities, controls).transposes ? QUARTER_TURN_NOTE : "";
  if (carriers.every((by) => by === "sensor")) return SENSOR_NOTE + tail;
  if (carriers.every((by) => by === "board")) return BOARD_NOTE + tail;
  return "this camera turns part of the picture itself, and each control says which" + tail;
}
