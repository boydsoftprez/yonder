// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { toJsonSchema } from "./generate.js";

describe("toJsonSchema", () => {
  it("produces a draft-07 schema with a title", () => {
    const s = toJsonSchema() as Record<string, unknown>;
    expect(s.$schema).toContain("json-schema.org");
    expect(s.title).toBe("Yonder configuration");
  });

  it("describes the network section", () => {
    const s = toJsonSchema() as { properties: Record<string, unknown> };
    expect(s.properties).toHaveProperty("network");
    expect(s.properties).toHaveProperty("ui");
  });
});
