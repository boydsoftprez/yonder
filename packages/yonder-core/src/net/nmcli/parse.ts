// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Parse `nmcli -t` terse output.
 *
 * Terse mode is a machine interface: one record per line, fields separated by
 * a colon, and any colon or backslash inside a value escaped with a backslash.
 * Splitting naively on ":" corrupts SSIDs and MAC addresses, so this walks the
 * string one character at a time.
 */
export function parseTerse(stdout: string, fieldCount: number): string[][] {
  const records: string[][] = [];

  for (const line of stdout.split("\n")) {
    if (line === "") continue;

    const fields: string[] = [];
    let current = "";
    let escaped = false;

    for (const ch of line) {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === ":") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);

    if (fields.length !== fieldCount) {
      throw new Error(
        `nmcli output: expected ${fieldCount} fields, got ${fields.length} in ${JSON.stringify(line)}`,
      );
    }
    records.push(fields);
  }

  return records;
}
