// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_OS_RELEASE,
  DEFAULT_PACKAGE_MANIFEST,
  parseOsRelease,
  parsePackageVersion,
  readVersions,
} from "./versions.js";
import { VERSION } from "../index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

describe("parseOsRelease", () => {
  it("prefers PRETTY_NAME, which is the line written to be read", () => {
    expect(parseOsRelease(fixture("os-release-trixie.txt")))
      .toBe("Debian GNU/Linux 13 (trixie)");
  });

  it("falls back to NAME and VERSION when there is no PRETTY_NAME", () => {
    expect(parseOsRelease('NAME="Alpine Linux"\nVERSION_ID=3.20\nVERSION="3.20.0"\n'))
      .toBe("Alpine Linux 3.20.0");
    expect(parseOsRelease('NAME="Something"\n')).toBe("Something");
  });

  it("accepts bare values as well as quoted ones, both being legal here", () => {
    expect(parseOsRelease("PRETTY_NAME=Debian\n")).toBe("Debian");
    expect(parseOsRelease("PRETTY_NAME='Debian'\n")).toBe("Debian");
  });

  it("reports an absent or unreadable file as unknown", () => {
    expect(parseOsRelease(null)).toBeNull();
    expect(parseOsRelease("")).toBeNull();
    expect(parseOsRelease("# a comment and nothing else\n")).toBeNull();
    expect(parseOsRelease('PRETTY_NAME=""\n')).toBeNull();
  });
});

describe("parsePackageVersion", () => {
  it("reads the version out of a manifest", () => {
    expect(parsePackageVersion('{"name":"yonder-core","version":"0.1.0"}')).toBe("0.1.0");
  });

  /**
   * Never throws. A manifest that will not parse means a damaged install, and
   * the right thing for a status page to do about a damaged install is render
   * — saying what it does not know — so somebody can read the rest of it.
   */
  it("reports unknown rather than throwing on anything else", () => {
    expect(parsePackageVersion(null)).toBeNull();
    expect(parsePackageVersion("")).toBeNull();
    expect(parsePackageVersion("{ not json")).toBeNull();
    expect(parsePackageVersion('{"name":"yonder-core"}')).toBeNull();
    expect(parsePackageVersion('{"version":1}')).toBeNull();
    expect(parsePackageVersion('{"version":""}')).toBeNull();
  });
});

describe("readVersions", () => {
  it("reads both from the paths a device keeps them at", () => {
    const versions = readVersions({
      read: (path) => {
        if (path === DEFAULT_OS_RELEASE) return fixture("os-release-trixie.txt");
        if (path === DEFAULT_PACKAGE_MANIFEST) return '{"version":"9.9.9"}';
        return null;
      },
    });
    expect(versions).toEqual({ yonder: "9.9.9", os: "Debian GNU/Linux 13 (trixie)" });
  });

  it("degrades both to null when neither is there", () => {
    expect(readVersions({ read: () => null })).toEqual({ yonder: null, os: null });
  });

  /**
   * The default manifest path is derived from this module's own location so
   * that a tree installed under any prefix still finds itself. If that
   * derivation is wrong, the version silently becomes null on every device —
   * a nothing on a page rather than a failure anyone would notice. So it is
   * asserted against the real file, and against the constant the package
   * already exports, which must agree.
   */
  it("finds this package's own manifest from where this module sits", () => {
    expect(readVersions({ osReleasePath: "/definitely/not/here" }).yonder).toBe(VERSION);
  });
});
