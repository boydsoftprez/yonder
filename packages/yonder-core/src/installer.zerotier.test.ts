// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const role = readFileSync(join(root, "installer", "roles", "40-zerotier.sh"), "utf8");

describe("ZeroTier installer lifecycle handoff", () => {
  it("leaves image clients off, then delegates first boot to the durable projector", () => {
    const image = role.indexOf('if [ "$IMAGE_MODE" = "1" ]');
    const stop = role.indexOf("service_stop zerotier-one.service", image);
    const disable = role.indexOf("service_disable zerotier-one.service", image);
    const live = role.indexOf("service_restart yonder-admin.service", disable);
    expect(image).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(image);
    expect(disable).toBeGreaterThan(stop);
    expect(live).toBeGreaterThan(disable);
  });

  it("does not use the retired renderer record as upgrade authority", () => {
    expect(role).not.toContain("/var/lib/yonder/remote.json");
    expect(role).toContain("systemctl is-active --quiet yonder-admin.service");
  });
});
