// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { byPathNames, systemByPath, type ByPathEntry } from "./bypath.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

/**
 * The recorded `ls -l /dev/v4l/by-path/`, as the reader would have returned it.
 *
 * The count is asserted below so a helper that silently matched nothing cannot
 * make the tests beneath it vacuous.
 */
function recorded(): ByPathEntry[] {
  return fixture("by-path.txt")
    .split("\n")
    .flatMap((line) => {
      const m = /(\S+) -> (\S+)\s*$/.exec(line);
      return m ? [{ name: m[1], target: m[2] }] : [];
    });
}

describe("the recorded listing", () => {
  it("holds the nine links this board publishes", () => {
    expect(recorded()).toHaveLength(9);
  });
});

describe("byPathNames", () => {
  const names = byPathNames(recorded());

  it("follows the link rather than trusting the index in the name", () => {
    // platform-fe00b840.mailbox-video-index3 points at /dev/video16. The index
    // counts nodes within one interface, so a name cannot be read as a node.
    expect(names.get("/dev/video16")).toBe("platform-fe00b840.mailbox-video-index3");
    expect(names.get("/dev/video19")).toBe("platform-feb00000.codec-video-index0");
  });

  it("gives one name per node, though the kernel published two", () => {
    // Both a usb- and a usbv2- form point at /dev/video0. Either is stable;
    // what matters is that the same one comes back every time.
    expect(names.size).toBe(7);
    expect(names.get("/dev/video0")).toBe(
      "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    );
  });

  it("gives the same answer whatever order the directory was read in", () => {
    // readdir order is the filesystem's business. R-CAM-05 is about the answer
    // not moving, so the same set of links must resolve the same way reversed.
    const forwards = byPathNames(recorded());
    const backwards = byPathNames([...recorded()].reverse());
    expect([...backwards.entries()].sort()).toEqual([...forwards.entries()].sort());
  });

  it("resolves a camera to its capture node, never its metadata node", () => {
    // -video-index1 is the node that answers no formats. It gets its own entry
    // — it is a real node — but /dev/video0's name is an index0 name, so the
    // camera camera.ts accepts is the one whose identity is returned.
    expect(names.get("/dev/video0")).toContain("-video-index0");
    expect(names.get("/dev/video1")).toContain("-video-index1");
  });

  it("returns a name a configuration can hold", () => {
    // The schema stores this bare, `device: z.string().min(1).max(128)`.
    for (const name of names.values()) {
      expect(name.length).toBeLessThanOrEqual(128);
      expect(name).not.toContain("/");
    }
    // The longest this board publishes, so the headroom is on the record.
    expect(Math.max(...[...names.values()].map((n) => n.length))).toBe(66);
  });

  it("returns an empty map rather than throwing on nothing at all", () => {
    expect(byPathNames([]).size).toBe(0);
  });
});

describe("systemByPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "yonder-bypath-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a directory of symlinks, and resolves what they point at", () => {
    // A temporary directory, never /dev: this is the production reader, so
    // leaving it to run only on hardware is how it stays untested until it
    // matters. The names are the ones the board actually publishes.
    const first = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0";
    const second = "platform-fd500000.pcie-pci-0000:01:00.0-usbv2-0:1.3:1.0-video-index0";
    symlinkSync("../../video0", join(dir, first));
    symlinkSync("../../video0", join(dir, second));
    writeFileSync(join(dir, "not-a-link"), "");

    const entries = systemByPath(dir);
    // Two: the plain file is not a link, and one unreadable entry must not
    // cost the others.
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name)).not.toContain("not-a-link");
    expect(entries.find((e) => e.name === first)).toEqual({ name: first, target: "../../video0" });

    // And the two names still collapse to one, chosen the same way.
    expect(byPathNames(entries).get("/dev/video0")).toBe(first);
  });

  it("returns an empty list rather than throwing when there is no such directory", () => {
    // A board that has never had a camera attached has no /dev/v4l at all.
    // That is an ordinary state, not a fault (R-CAM-12).
    expect(systemByPath(join(dir, "absent", "by-path"))).toEqual([]);
  });
});
