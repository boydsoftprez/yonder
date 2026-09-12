// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { assertManagedStateMount, loadConventionalState } from "./recover.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "yonder-recover-"));
  roots.push(root);
  return root;
}

describe("managed state storage", () => {
  it("fails closed when the managed marker exists without the state mount", () => {
    const base = temporary();
    const root = join(base, "missing-state-mount");
    const marker = join(base, "immutable-managed-image-marker");
    writeFileSync(marker, "ok\n");
    expect(() => assertManagedStateMount({
      stateRoot: root,
      markerPath: marker,
      mountInfoText: "31 22 0:28 / / rw,relatime - apfs /dev/disk3 rw\n",
    })).toThrowError(expect.objectContaining({ code: "STATE_UNAVAILABLE" }));
  });

  it("accepts an exact escaped mountinfo mountpoint and ignores prefix matches", () => {
    const base = temporary();
    const root = join(base, "state with space");
    mkdirSync(root);
    const marker = join(base, "immutable-managed-image-marker");
    writeFileSync(marker, "ok\n");
    expect(() => assertManagedStateMount({
      stateRoot: root,
      markerPath: marker,
      mountInfoText: `31 22 0:28 / ${root.replaceAll(" ", "\\040")}-other rw - ext4 /dev/x rw\n`,
    })).toThrow();
    expect(() => assertManagedStateMount({
      stateRoot: root,
      markerPath: marker,
      mountInfoText: `31 22 0:28 / ${root.replaceAll(" ", "\\040")} rw - ext4 /dev/x rw\n`,
    })).not.toThrow();
  });

  it.each([
    "31 22 0:28 / %ROOT% ro,relatime - ext4 /dev/x ro",
    "31 22 0:28 / %ROOT% rw,relatime - tmpfs tmpfs rw",
  ])("rejects a managed state mount that is not writable ext4", (entry) => {
    const base = temporary();
    const root = join(base, "state");
    const marker = join(base, "immutable-managed-image-marker");
    writeFileSync(marker, "managed\n");
    expect(() => assertManagedStateMount({
      stateRoot: root,
      markerPath: marker,
      mountInfoText: `${entry.replace("%ROOT%", root)}\n`,
    })).toThrowError(expect.objectContaining({ code: "STATE_UNAVAILABLE" }));
  });

  it("allows a conventional installation when no managed marker exists", () => {
    const root = temporary();
    expect(() => assertManagedStateMount({
      stateRoot: root,
      markerPath: join(root, "seed-complete"),
      mountInfoText: "",
    })).not.toThrow();
  });
});

describe("conventional state import", () => {
  it("loads a complete config and flat secret map without owner or mesh data", () => {
    const root = temporary();
    const configPath = join(root, "config.yaml");
    const secretsPath = join(root, "secrets.yaml");
    writeFileSync(configPath, stringify(DEFAULT_CONFIG));
    writeFileSync(secretsPath, stringify({ ap_psk: "private-passphrase" }));
    expect(loadConventionalState({ configPath, secretsPath })).toEqual({
      config: DEFAULT_CONFIG,
      secrets: { ap_psk: "private-passphrase" },
      linuxOwner: null,
      zeroTier: null,
    });
  });

  it("never repeats malformed secret content in its error", () => {
    const root = temporary();
    const secret = "do-not-repeat-this";
    const configPath = join(root, "config.yaml");
    const secretsPath = join(root, "secrets.yaml");
    writeFileSync(configPath, stringify(DEFAULT_CONFIG));
    writeFileSync(secretsPath, `ap_psk: ${secret}\n\tbad: value\n`);
    try {
      loadConventionalState({ configPath, secretsPath });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect(error).toMatchObject({ code: "STATE_UNAVAILABLE" });
    }
  });

  it("imports a legacy pending apply's known-old config with the current secret map", () => {
    const root = temporary();
    const configPath = join(root, "config.yaml");
    const secretsPath = join(root, "secrets.yaml");
    const current = structuredClone(DEFAULT_CONFIG);
    current.network.client.ssid = "unconfirmed-network";
    const previous = structuredClone(DEFAULT_CONFIG);
    writeFileSync(configPath, stringify(current));
    writeFileSync(secretsPath, stringify({
      ap_psk: "private-passphrase",
      wifi_psk: "legacy-current-value",
    }));
    const imported = loadConventionalState({ configPath, secretsPath, rollbackConfig: previous });
    expect(imported.config).toEqual(previous);
    expect(imported.secrets).toEqual({
      ap_psk: "private-passphrase",
      wifi_psk: "legacy-current-value",
    });
  });
});
