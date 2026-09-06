// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What `mavlink-router` already knows about its own endpoints, read from the
 * per-endpoint statistics block it prints to stdout once a second once its
 * generated configuration carries `ReportStats = true` (`router/config.ts`).
 *
 * §6 and §10.3 of the telemetry-plumbing design, and
 * `docs/hardware/an-autopilot-on-the-uart.md`, are the reason this file
 * exists at all: `LinkState.groundStations`, `.traffic` and `.tcpClients`
 * are measurements only the router holds, and this is the only place they
 * can be read from.
 *
 * **This is a parser, not a protocol.** The statistics are text on stdout,
 * and nothing upstream promises that format is stable — that coupling is
 * recorded deliberately, as the better trade against reporting less than
 * the router knows. Keeping the parse in one pure function, with the real
 * captured output as its fixture, means a format change is one failing test
 * naming one file, rather than a page that quietly goes blank.
 */

export interface EndpointStats {
  /** The endpoint's configured name, as it appears in the block header. */
  name: string;
  kind: "uart" | "udp" | "tcp";
  /** Cumulative since the router started. `Handled`, not `Total`. */
  received: number;
  transmitted: number;
  crcErrors: number;
  sequenceLost: number;
}

/** `UDP Endpoint [7]gcs0 {` → kind `UDP`, name `gcs0`. */
const BLOCK_HEADER = /^(UART|UDP|TCP) Endpoint \[\d+\](\S+) \{$/;

const RECEIVED_HEADER = "Received messages {";
const TRANSMITTED_HEADER = "Transmitted messages {";

/** The block being built. Not yet an `EndpointStats`: any of the four
 * counters may still be missing, and a block that ends without all four is
 * dropped rather than defaulted (see `parseStats`). */
interface PartialEndpoint {
  name: string;
  kind: EndpointStats["kind"];
  received?: number;
  transmitted?: number;
  crcErrors?: number;
  sequenceLost?: number;
}

export function parseStats(text: string): EndpointStats[] {
  const results: EndpointStats[] = [];

  // An explicit depth, rather than trusting the literal tab indentation the
  // real output happens to use: incremented on any line that opens a brace,
  // decremented on any line that is exactly a closing one. A block starts at
  // depth 0 and closes when a `}` brings the count back to 0, so an
  // unrelated journal line spliced in between two blocks — or between an
  // endpoint header and its own counters — changes nothing, because it
  // matches neither rule and simply falls through.
  let depth = 0;
  let current: PartialEndpoint | null = null;
  let section: "received" | "transmitted" | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (depth === 0) {
      // Nothing but a block's own header line means anything at depth 0 —
      // not a stray "}" (there is nothing open to close), not a version
      // banner, not an unrelated log line. This is what lets `parseStats`
      // return `[]` instead of throwing on text that is not statistics at
      // all.
      const header = BLOCK_HEADER.exec(line);
      if (header !== null) {
        current = { name: header[2], kind: header[1].toLowerCase() as EndpointStats["kind"] };
        section = null;
        depth = 1;
      }
      continue;
    }

    // depth >= 1: inside a block. `current` is set whenever depth > 0.
    if (line === "}") {
      depth -= 1;
      if (depth === 1) {
        // Closed "Received messages {" or "Transmitted messages {".
        section = null;
      } else if (depth === 0) {
        // Closed the endpoint block itself. A block missing any of the four
        // counters — most often the newest block in a journal tail, cut off
        // mid-write — is dropped rather than defaulted to zero: reporting a
        // truncated read as a ground station gone quiet would be a lamp
        // changing colour because the read was cut, not because anything
        // about the link changed.
        if (
          current !== null
          && current.received !== undefined
          && current.transmitted !== undefined
          && current.crcErrors !== undefined
          && current.sequenceLost !== undefined
        ) {
          results.push({
            name: current.name,
            kind: current.kind,
            received: current.received,
            transmitted: current.transmitted,
            crcErrors: current.crcErrors,
            sequenceLost: current.sequenceLost,
          });
        }
        current = null;
      }
      continue;
    }

    if (line.endsWith("{")) {
      depth += 1;
      if (line === RECEIVED_HEADER) section = "received";
      else if (line === TRANSMITTED_HEADER) section = "transmitted";
      // Any other nested brace (none exist in the observed format) is still
      // depth-tracked so its matching "}" cannot be mistaken for the
      // endpoint's own closing brace, even though this parser has no
      // counters to read out of it.
      continue;
    }

    // An ordinary content line. Only the two named subsections carry
    // counters this parser reads.
    if (current === null || depth !== 2 || section === null) continue;

    if (section === "received") {
      // `Handled` is the count that moves when a ground station answers.
      // `Total` includes messages the router saw and dropped, so a busy
      // endpoint that routes nothing back would read as answering — which is
      // exactly the distinction §6's bench measurement turned on. `Total` is
      // therefore never read here, only in the transmitted section below.
      const handled = /^Handled:\s*(\d+)/.exec(line);
      if (handled !== null) { current.received = Number(handled[1]); continue; }
      const crc = /^CRC error:\s*(\d+)/.exec(line);
      if (crc !== null) { current.crcErrors = Number(crc[1]); continue; }
      const lost = /^Sequence lost:\s*(\d+)/.exec(line);
      if (lost !== null) { current.sequenceLost = Number(lost[1]); continue; }
    } else {
      const total = /^Total:\s*(\d+)/.exec(line);
      if (total !== null) { current.transmitted = Number(total[1]); continue; }
    }
  }

  return results;
}
