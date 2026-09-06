// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseStats } from "./stats.js";

/** Verbatim from mavlink-router 2362c62 on a Pi 4, ReportStats = true. */
const REAL = `UDP Endpoint [7]gcs0 {
	Received messages {
		CRC error: 0 0% 0KB
		Sequence lost: 0 0%
		Handled: 21 1KB
		Total: 21
	}
	Transmitted messages {
		Total: 954 34KB
	}
}
UDP Endpoint [8]gcs1 {
	Received messages {
		CRC error: 0 0% 0KB
		Sequence lost: 0 0%
		Handled: 0 0KB
		Total: 0
	}
	Transmitted messages {
		Total: 954 34KB
	}
}
UART Endpoint [6]autopilot {
	Received messages {
		CRC error: 0 0% 0KB
		Sequence lost: 0 0%
		Handled: 955 34KB
		Total: 955
	}
	Transmitted messages {
		Total: 0 0KB
	}
}
`;

describe("parseStats", () => {
  // The measurement §6 was reversed by: the answering endpoint's count tracks
  // its replies exactly, and the silent one stays at zero.
  it("attributes received messages to the endpoint that received them", () => {
    expect(parseStats(REAL)).toEqual([
      { name: "gcs0", kind: "udp", received: 21, transmitted: 954, crcErrors: 0, sequenceLost: 0 },
      { name: "gcs1", kind: "udp", received: 0, transmitted: 954, crcErrors: 0, sequenceLost: 0 },
      { name: "autopilot", kind: "uart", received: 955, transmitted: 0, crcErrors: 0, sequenceLost: 0 },
    ]);
  });

  // `Handled` is the count that moved when a ground station answered. `Total`
  // includes messages the router saw and dropped, so a busy endpoint that
  // routes nothing back would read as answering.
  it("reads Handled, not Total", () => {
    const text = REAL.replace("\t\tHandled: 21 1KB\n\t\tTotal: 21", "\t\tHandled: 3 1KB\n\t\tTotal: 99");
    expect(parseStats(text)[0].received).toBe(3);
  });

  it("returns nothing rather than throwing on output that is not statistics", () => {
    expect(parseStats("")).toEqual([]);
    expect(parseStats("mavlink-router version 2362c62\nOpened UART\n")).toEqual([]);
  });

  // The journal interleaves. A block split by an unrelated line is still a block.
  it("skips lines that are not part of a block", () => {
    const noisy = REAL.replace("UART Endpoint [6]autopilot {", "some other log line\nUART Endpoint [6]autopilot {");
    expect(parseStats(noisy).map((e) => e.name)).toEqual(["gcs0", "gcs1", "autopilot"]);
  });

  // A truncated tail is the ordinary case when reading the last N journal
  // lines: the newest block is usually half-written.
  it("drops a block whose counters are not all present rather than guessing at zero", () => {
    const cut = REAL.slice(0, REAL.indexOf("UART Endpoint"));
    expect(parseStats(cut + "UART Endpoint [6]autopilot {\n\tReceived messages {\n").map((e) => e.name))
      .toEqual(["gcs0", "gcs1"]);
  });

  // No bench has attached a TCP client yet (see the note at the end of this
  // file's companion task), so there is no captured fixture for a `TCP
  // Endpoint` block. This is not evidence about the real format — only that
  // the header regex's TCP branch is exercised by something, rather than
  // going untested until a bench session happens to need it.
  it("recognises a TCP endpoint block, lowercasing its kind", () => {
    const synthetic = "TCP Endpoint [9]relay {\n"
      + "\tReceived messages {\n\t\tCRC error: 0 0% 0KB\n\t\tSequence lost: 0 0%\n\t\tHandled: 5 1KB\n\t\tTotal: 5\n\t}\n"
      + "\tTransmitted messages {\n\t\tTotal: 5 1KB\n\t}\n"
      + "}\n";
    expect(parseStats(synthetic)).toEqual([
      { name: "relay", kind: "tcp", received: 5, transmitted: 5, crcErrors: 0, sequenceLost: 0 },
    ]);
  });

  // Depth is tracked by counting braces, not by trusting the literal tab
  // indentation the real output happens to use — this fixture has none, and
  // must parse identically to REAL.
  it("does not depend on indentation, only on brace depth", () => {
    const unindented = REAL.split("\n").map((l) => l.trimStart()).join("\n");
    expect(parseStats(unindented)).toEqual(parseStats(REAL));
  });
});
