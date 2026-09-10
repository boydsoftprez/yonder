// SPDX-License-Identifier: GPL-3.0-or-later
import type { ControlRange, VideoFormat } from "../capability.js";

/**
 * `v4l2-ctl` output, parsed.
 *
 * **Nothing in this file throws.** R-CAM-12 asks for what was found, what was
 * rejected, and why — so a device that answers nothing is an empty list and a
 * reason, never an exception. A probe that threw would take the Cameras page
 * down with the one camera it could not read.
 *
 * The formats these regexes match were recorded off a board and committed
 * beside this file. Do not adjust them against remembered output; adjust the
 * fixture, from the board, and let the test tell you what changed.
 */

/**
 * `[0]: 'MJPG' (Motion-JPEG, compressed)`.
 *
 * **Four bytes, not four word characters.** A V4L2 fourcc is four *bytes* and
 * several real ones carry a trailing space — `'Y16 '` (16-bit greyscale),
 * `'Y12 '`, `'Y10 '`, which is what a thermal or greyscale camera reports.
 * `\w{4}` did not match those, so the whole format block was skipped and its
 * sizes were left in `pending` for the next format that did parse to collect:
 * a 160x120 greyscale mode arrived at the operator's picker as an MJPG mode,
 * passed `camera.ts`'s compressed-format filter as flyable, and `refuse()`
 * accepted a size the camera cannot deliver at that fourcc. The only report
 * was `Internal data stream error`.
 */
const FORMAT_LINE = /^\s*\[\d+\]:\s*'(.{4})'/;
const SIZE_LINE = /^\s*Size:\s*Discrete\s+(\d+)x(\d+)/;
const INTERVAL_LINE = /\(([\d.]+)\s*fps\)/;

export function parseFormats(stdout: string): VideoFormat[] {
  const out: VideoFormat[] = [];
  let fourcc: string | null = null;
  let pending: { width: number; height: number; rates: number[] } | null = null;

  const flush = (): void => {
    // `pending` first, and not only on the way out: sizes collected under a
    // fourcc this parser could not read belong to no format, and leaving them
    // here donates them to the next format that parses. See FORMAT_LINE.
    if (fourcc === null || pending === null) { pending = null; return; }
    out.push({
      fourcc,
      width: pending.width,
      height: pending.height,
      // Largest first, so a picker's first entry is the best the camera offers.
      rates: [...new Set(pending.rates)].sort((a, b) => b - a),
    });
    pending = null;
  };

  for (const line of stdout.split("\n")) {
    const format = FORMAT_LINE.exec(line);
    if (format) {
      flush();
      fourcc = format[1];
      continue;
    }
    const size = SIZE_LINE.exec(line);
    if (size) {
      flush();
      pending = { width: Number(size[1]), height: Number(size[2]), rates: [] };
      continue;
    }
    const interval = INTERVAL_LINE.exec(line);
    // The parenthesised figure, not 1/interval: `Interval: Discrete 0.033s
    // (30.000 fps)` derives 30.3 the other way, and a picker then offers a
    // rate the camera never named.
    if (interval && pending) pending.rates.push(Math.round(Number(interval[1])));
  }
  flush();
  return out;
}

const CONTROL_LINE = /^\s*(\w+)\s+0x[0-9a-f]+\s+\((int|menu|bool)\)\s*:\s*(.*)$/;

/**
 * `1: Manual Mode`, indented beneath a `(menu)` control. Never confused with
 * one: `CONTROL_LINE` needs a hex id and a parenthesised type, which no menu
 * entry line carries, so the two patterns never compete for the same line —
 * a heading or a blank line matches neither and simply ends the run of
 * entries below.
 */
const MENU_ENTRY_LINE = /^\s+(\d+):\s+(.+)$/;

/**
 * `flags=inactive, has-min-max`. Captured whole so the value can be split on
 * commas and matched *word* for word — `flags=deactivated` shares no word
 * with `inactive` and must read as ungated, which a substring test on the
 * raw line would get wrong.
 */
const FLAGS_LINE = /\bflags=([\w\-, ]+)/;

export function parseControls(stdout: string): Map<string, ControlRange> {
  const out = new Map<string, ControlRange>();
  const lines = stdout.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = CONTROL_LINE.exec(lines[i]);
    if (!m) continue;
    const [, name, kind, rest] = m;
    const field = (key: string): number | null => {
      const f = new RegExp(`\\b${key}=(-?\\d+)`).exec(rest);
      return f ? Number(f[1]) : null;
    };
    // `value=` is what the device reports now; `default=` is the factory
    // setting. R-CTL-10 wants the reading, and a control that showed the
    // default would be showing a form default by another name.
    const current = field("value");
    if (current === null) continue;

    // R-UI-21: a control another control has charge of still answers its
    // own range — it is gated, not a fault. `exposure_time_absolute` and
    // `white_balance_temperature` both report this on the bench camera,
    // gated by `auto_exposure` and `white_balance_automatic` respectively.
    const flagsValue = FLAGS_LINE.exec(rest)?.[1];
    const inactive = flagsValue !== undefined
      && flagsValue.split(",").map((flag) => flag.trim()).includes("inactive");

    // A `(menu)` control's entries are the indented lines that follow it,
    // consumed here rather than left for a caller. R-CAM-14: kept only if
    // the device actually listed them, never widened from min..max — see
    // the field comment on `ControlRange.menu`.
    let menu: { id: number; label: string }[] | undefined;
    if (kind === "menu") {
      const entries: { id: number; label: string }[] = [];
      while (i + 1 < lines.length) {
        const entry = MENU_ENTRY_LINE.exec(lines[i + 1]);
        if (!entry) break;
        entries.push({ id: Number(entry[1]), label: entry[2] });
        i++;
      }
      if (entries.length > 0) menu = entries;
    }

    out.set(name, {
      min: field("min") ?? 0,
      max: field("max") ?? 1,
      step: field("step") ?? 1,
      default: field("default") ?? current,
      current,
      inactive,
      menu,
    });
  }
  return out;
}

export function parseDevices(stdout: string): { card: string; nodes: string[] }[] {
  const out: { card: string; nodes: string[] }[] = [];
  let current: { card: string; nodes: string[] } | null = null;
  for (const raw of stdout.split("\n")) {
    if (raw.trim() === "") continue;
    if (!/^\s/.test(raw)) {
      current = { card: raw.replace(/\s*\(.*\)\s*:?\s*$/, "").trim(), nodes: [] };
      out.push(current);
      continue;
    }
    const node = raw.trim();
    if (current && node.startsWith("/dev/")) current.nodes.push(node);
  }
  return out;
}
