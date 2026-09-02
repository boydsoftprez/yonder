// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { boardFacts, type BoardFacts, type FactSources } from "./facts.js";

/**
 * The half of the board-facts reader that touches the filesystem.
 *
 * Separated from `facts.ts` for the same reason every renderer takes a
 * `CommandRunner`: the parsing is where the mistakes live and it must be
 * testable against captured text, while the reading is four paths and a
 * `try`. A test injects a reader and never opens `/proc` — which it could
 * not do anyway on the machine this is developed on.
 */

/**
 * Reads a file, or reports that it is not there.
 *
 * `null` is *absent, unreadable, or not something this process may open* —
 * all of which mean the same thing to a status page, which is that the fact is
 * unknown. Distinguishing them would give a page three ways to say "no
 * reading" and an operator no more information than one.
 */
export type FileReader = (path: string) => string | null;

/** The real one. Never throws: a missing `/proc` entry is an answer. */
export const systemReader: FileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Where each fact lives on a Linux board.
 *
 * Named, and overridable, so a test can point at a fixture directory and so
 * nothing here hard-codes a path into a function that would then be untestable
 * without it.
 */
export interface FactPaths {
  model: string;
  loadavg: string;
  meminfo: string;
  uptime: string;
  thermal: string;
}

export const DEFAULT_FACT_PATHS: FactPaths = {
  model: "/proc/device-tree/model",
  loadavg: "/proc/loadavg",
  meminfo: "/proc/meminfo",
  uptime: "/proc/uptime",
  thermal: "/sys/class/thermal/thermal_zone0/temp",
};

export interface ReadFactsOptions {
  read?: FileReader;
  paths?: Partial<FactPaths>;
}

/** The text of every fact file, with `null` for each one that is not there. */
export function readFactSources(opts: ReadFactsOptions = {}): FactSources {
  const read = opts.read ?? systemReader;
  const paths = { ...DEFAULT_FACT_PATHS, ...opts.paths };
  return {
    model: read(paths.model),
    loadavg: read(paths.loadavg),
    meminfo: read(paths.meminfo),
    uptime: read(paths.uptime),
    thermal: read(paths.thermal),
  };
}

/** What this board says about itself. Every field may be null. */
export function readBoardFacts(opts: ReadFactsOptions = {}): BoardFacts {
  return boardFacts(readFactSources(opts));
}
