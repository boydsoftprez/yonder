// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { hashLinuxPassword } from "./password.js";

describe("native owner password hashing", () => {
  it("selects the fixed native algorithm and sends the exact password on stdin", async () => {
    const expected = `$y$j9T$${"a".repeat(22)}$${"b".repeat(43)}`;
    let retained: Buffer | undefined;
    const stdout = Buffer.from(expected + "\n");
    const actual = await hashLinuxPassword(" pass:word é ", async input => {
      expect(input.command).toBe("/usr/bin/mkpasswd");
      expect(input.args).toEqual(["--method=yescrypt", "--stdin"]);
      retained = input.stdin as Buffer;
      expect(retained.toString()).toBe(" pass:word é \n");
      return { stdout };
    });
    expect(actual).toBe(expected);
    expect(retained?.every(byte => byte === 0)).toBe(true);
    expect(stdout.every(byte => byte === 0)).toBe(true);
  });
  it("refuses malformed native output instead of storing a diagnostic as a hash", async () => {
    await expect(hashLinuxPassword("long password", async () => ({ stdout: Buffer.from("native error with input\n") })))
      .rejects.toMatchObject({ code: "PASSWORD_HASH" });
  });
  it("rejects control characters before running a native tool", async () => {
    let called = false;
    await expect(hashLinuxPassword("long\tpassword", async () => { called = true; return { stdout: Buffer.alloc(0) }; }))
      .rejects.toMatchObject({ code: "PASSWORD" });
    expect(called).toBe(false);
  });
});
