// SPDX-License-Identifier: GPL-3.0-or-later
import type { BoardFacts } from "./facts.js";
import type { Versions } from "./versions.js";

/**
 * Board facts as strings a page can show without doing arithmetic.
 *
 * **This is why the pages need no logic in them.** A Dashboard widget binds a
 * value; it cannot divide bytes by 1024 twice or turn 190 000 seconds into
 * "2 days 4 hours". Doing that in a `function` node is what CLAUDE.md rule 2
 * forbids, and doing it in a contrib node is what this milestone's plan
 * forbids for the same reason — so it happens here, where it is a pure
 * function with tests.
 *
 * **Unknown is a word, not a blank.** Every one of these facts can be absent
 * on a legitimate board, and an empty cell on a status page reads as "this
 * page is broken" rather than "this board has no thermal sensor". One word,
 * the same word everywhere.
 */

export const UNKNOWN = "unknown";

export interface BoardDisplay {
  model: string;
  /** The three load averages, as they are conventionally read. */
  load: string;
  memory: string;
  uptime: string;
  temperature: string;
  yonder: string;
  os: string;
}

/** Mebibytes, to a whole number. Boards here have hundreds, not thousands. */
function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / 1024 / 1024))} MB`;
}

/**
 * A duration a person reads, largest two units only.
 *
 * "2 days 4 hours", not "2 days 4 hours 11 minutes 6 seconds". The third unit
 * has never once been the reason somebody was looking at an uptime, and a
 * status line that wraps is a status line that is harder to scan.
 */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return UNKNOWN;
  const whole = Math.floor(seconds);
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];

  const parts: string[] = [];
  let left = whole;
  for (const [size, name] of units) {
    const count = Math.floor(left / size);
    left -= count * size;
    if (count === 0 && parts.length === 0) continue;
    if (count > 0 || parts.length > 0) parts.push(`${String(count)} ${name}${count === 1 ? "" : "s"}`);
    if (parts.length === 2) break;
  }
  // Under a second, or exactly zero. A board that has just started is a fact
  // worth reporting accurately: it may have just restarted under the operator.
  return parts.length === 0 ? "0 seconds" : parts.join(" ");
}

export function formatMemory(memory: BoardFacts["memory"]): string {
  if (memory === null) return UNKNOWN;
  const total = megabytes(memory.totalBytes);
  if (memory.usedBytes === null) return `${total} total`;
  const percent = Math.round((memory.usedBytes / memory.totalBytes) * 100);
  return `${megabytes(memory.usedBytes)} of ${total} used (${String(percent)}%)`;
}

export function formatLoad(load: BoardFacts["load"]): string {
  if (load === null) return UNKNOWN;
  return [load.one, load.five, load.fifteen].map((n) => n.toFixed(2)).join(", ");
}

export function formatTemperature(celsius: number | null): string {
  return celsius === null ? UNKNOWN : `${celsius.toFixed(1)} °C`;
}

export function displayFacts(facts: BoardFacts, versions: Versions): BoardDisplay {
  return {
    model: facts.model ?? UNKNOWN,
    load: formatLoad(facts.load),
    memory: formatMemory(facts.memory),
    uptime: formatUptime(facts.uptimeSeconds),
    temperature: formatTemperature(facts.cpuTemperatureC),
    yonder: versions.yonder ?? UNKNOWN,
    os: versions.os ?? UNKNOWN,
  };
}
