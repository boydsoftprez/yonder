// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `mmcli --output-keyvalue` is ModemManager's machine mode, and parsing it is
 * the same trade ADR-0006 recorded for `nmcli -t`: a supported terse output,
 * not screen-scraping. Its shape is
 *
 *     modem.generic.model                             : EC25
 *     modem.generic.state-failed-reason               : --
 *
 * — a key, alignment padding, a colon, a space, and the rest of the line.
 *
 * **Split on the first colon-space, never on the colon.** A bearer's IPv6
 * address is `2600:382:859c:…` and a naive split loses all but its first
 * group. The separator mmcli actually writes is `" : "`, so that is what is
 * matched.
 */
export function parseKeyValue(text: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(" : ");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    if (key === "") continue;
    const value = line.slice(at + 3).trim();
    // `--` is mmcli's absent. Reading it as a string puts the literal two
    // characters on a console, which is worse than nothing because it looks
    // like data.
    out[key] = value === "--" ? null : value;
  }
  return out;
}

/**
 * An array, which mmcli writes as a `.length` and one `.value[n]` per element,
 * one-indexed.
 *
 * Read by index up to the stated length rather than by collecting every
 * matching key: `modem.generic.bearers` and `modem.generic.bearers-something`
 * would both match a prefix scan, and the order of object keys is not the
 * order of a list.
 */
export function arrayAt(record: Record<string, string | null>, prefix: string): string[] {
  const length = Number(record[`${prefix}.length`] ?? "0");
  if (!Number.isInteger(length) || length <= 0) return [];
  const out: string[] = [];
  for (let i = 1; i <= length; i++) {
    const value = record[`${prefix}.value[${i}]`];
    if (value !== undefined && value !== null) out.push(value);
  }
  return out;
}
