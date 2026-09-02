// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The presentation vocabulary, and nothing that touches the machine.
 *
 * `yonder-core`'s main entry pulls in the config loader, the daemon, the
 * nmcli client — everything that makes this a device package. None of that can
 * be bundled into a browser, and the first attempt to import `reading()` into
 * a Vue component failed exactly there: rollup followed the barrel to
 * `readFileSync`.
 *
 * The fix is not a deep path into `dist/`, which would couple the widget
 * package to this one's build layout. It is this: a second entry point that
 * exports **only the pure decisions a page needs**, reachable as
 * `yonder-core/presentation`, with the boundary stated rather than implied.
 *
 * The rule for what belongs here: it must be a pure function of its
 * arguments, it must import nothing from `node:`, and it must be something
 * both a node and a component legitimately need to agree about. Those are the
 * decisions that would otherwise get made twice and drift — which is the
 * whole reason ADR-0005 asked for the command-state language to be built once.
 */

export {
  presentation,
  type CommandState,
  type CommandStatus,
  type CommandPresentation,
} from "./command.js";

export {
  reading,
  type Reading,
  type ReadingBounds,
  type ReadingTone,
} from "./reading.js";
