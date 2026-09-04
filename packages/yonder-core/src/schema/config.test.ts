// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";
import { withoutRetiredKeys } from "./retired.js";
import { formatIssues } from "../config/errors.js";
// Imported rather than restated: the point of the guard under test is that
// these four numbers have one home, so a test asserting literals would be the
// second copy it exists to prevent.
import {
  RTSP_PORT, SRT_PORT, WEBRTC_LOCAL_UDP_PORT, WEBRTC_PORT,
} from "../media/ports.js";

/** A config.yaml as a build before the pool was removed would have written it. */
function seededByAnEarlierBuild(): unknown {
  const network = DEFAULT_CONFIG.network;
  return {
    ...DEFAULT_CONFIG,
    network: {
      ...network,
      ap: { ...network.ap, dhcp: { start: "192.168.77.2", end: "192.168.77.50", lease: "12h" } },
    },
  };
}

describe("ConfigSchema", () => {
  it("accepts the default config", () => {
    expect(ConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    const bad = { ...DEFAULT_CONFIG, nonsense: true };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a version it does not understand", () => {
    const bad = { ...DEFAULT_CONFIG, version: 99 };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("requires an access point address in CIDR form", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.ap.address = "192.168.77.1";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults the access point fallback to enabled at 90 seconds", () => {
    const parsed = ConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.network.ap.fallback.enabled).toBe(true);
    expect(parsed.network.ap.fallback.timeout).toBe(90);
  });

  it("rejects an egress priority containing an unknown interface", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.priority = ["ethernet", "carrier_pigeon"] as never;
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an address whose octets are not octets", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.ap.address = "999.1.1.1/24";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a prefix length no subnet has", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.ap.address = "192.168.77.1/64";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("does not seed an administrator password reference by default", () => {
    // R-SEC-09: it does not exist until the operator sets one, and a shipped
    // default that names a secret nothing ever creates is a reference the
    // first eager resolver breaks on.
    expect(DEFAULT_CONFIG.ui.editor.password).toBeNull();
  });

  it("still understands a password reference once one is set", () => {
    const set = structuredClone(DEFAULT_CONFIG);
    set.ui.editor.password = { secret: "editor_password" };
    expect(ConfigSchema.safeParse(set).success).toBe(true);
  });

  /**
   * The DHCP pool is gone (K-15), and this schema still rejects it. That is
   * the half that has not changed and must not: strictness is what turns a
   * misspelled key into an error instead of a setting an operator wrongly
   * believes is in force.
   *
   * Tolerance lives one layer up, in `retired.ts`, and only for keys this
   * project can name. The two halves are asserted together here because they
   * are a pair: the schema knows nothing about history, and the loader knows
   * exactly one thing about it — the enumerated list. A device seeded by an
   * earlier build boots (R-CFG-09) without the schema going soft on typos.
   */
  it("rejects an access-point DHCP pool, which no longer decides anything", () => {
    expect(ConfigSchema.safeParse(seededByAnEarlierBuild()).success).toBe(false);
  });

  it("accepts that same configuration once the retired key is dropped", () => {
    const { doc, dropped } = withoutRetiredKeys(seededByAnEarlierBuild());
    expect(dropped.map((k) => k.path)).toEqual(["network.ap.dhcp"]);
    expect(ConfigSchema.safeParse(doc).success).toBe(true);
  });
});

/**
 * The confirmation windows (R-CFG-03). A new section, so nothing retires —
 * `retired.ts` is for keys this project has *removed*, and an addition
 * strands nobody.
 */
describe("apply", () => {
  it("defaults to 120 s for an ordinary apply and 300 s for a radio move", () => {
    expect(DEFAULT_CONFIG.apply).toEqual({ timeout: 120, radioTimeout: 300 });
  });

  it("is optional, so a configuration written before it existed still loads", () => {
    const without = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
    delete without.apply;
    const parsed = ConfigSchema.parse(without);
    expect(parsed.apply).toEqual({ timeout: 120, radioTimeout: 300 });
  });

  /**
   * Bounded at both ends, the same 30–600 seconds the access-point fallback
   * is. Below 30 s no operator can confirm anything; above 600 s an
   * unconfirmed change that broke the device sits there for ten minutes.
   */
  it("refuses a window nobody could confirm in, and one nobody would wait out", () => {
    for (const apply of [{ timeout: 5 }, { timeout: 900 }, { radioTimeout: 10 }, { radioTimeout: 3600 }]) {
      expect(ConfigSchema.safeParse({ ...DEFAULT_CONFIG, apply }).success, JSON.stringify(apply))
        .toBe(false);
    }
  });

  it("is strict, so a misspelled window is a refusal and not a silent default", () => {
    expect(ConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      apply: { timeout: 120, radioTimeoutSeconds: 300 },
    }).success).toBe(false);
  });
});

describe("network.modem", () => {
  it("is absent from a device that has not configured one", () => {
    // R-CFG-08: a freshly flashed board is usable with no operator input, and
    // that means no modem connection is attempted on a board with no modem.
    expect(DEFAULT_CONFIG.network.modem.enabled).toBe(false);
    expect(DEFAULT_CONFIG.network.modem.mode).toBe("auto");
    expect(DEFAULT_CONFIG.network.modem.apn).toBeNull();
  });

  it("takes an APN, a user, a password reference and a dial string", () => {
    const config = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: {
          enabled: true,
          apn: "ereseller",
          username: "user",
          password: { secret: "modem_psk" },
          dial: "*99#",
        },
      },
    });
    expect(config.network.modem.apn).toBe("ereseller");
    expect(config.network.modem.password).toEqual({ secret: "modem_psk" });
    expect(config.network.modem.dial).toBe("*99#");
  });

  it("names the adapter when the operator names the modem", () => {
    const config = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { enabled: true, mode: "appliance", interface: "usb0" },
      },
    });
    expect(config.network.modem.mode).toBe("appliance");
    expect(config.network.modem.interface).toBe("usb0");
  });

  /**
   * **An appliance is nothing but its name (R-CEL-11).**
   *
   * A modem that dials for itself is indistinguishable from any other network
   * adapter, so `network.modem.interface` is the whole of how this device
   * finds it. With that null and the modem enabled, `modemDevice` returns
   * null, `desiredProfiles` writes no profile at all, nothing is ever dialled
   * — and `modemState` reported the appliance as connected and said it was
   * "using the named adapter", naming nothing. A configuration that describes
   * a modem this device cannot possibly locate is not a configuration, and
   * the place to say so is the schema (R-CFG-02).
   */
  it("refuses an appliance modem with no adapter named", () => {
    const parsed = ConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { enabled: true, mode: "appliance", interface: null },
      },
    });
    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : formatIssues(parsed.error);
    expect(issues.join("\n")).toContain("network.modem.interface");
  });

  it("refuses an appliance modem that names no adapter at all", () => {
    // The same configuration written by leaving the key out. `interface`
    // defaults to null, so the two are the same document by the time anything
    // reads it, and they have to fail the same way.
    expect(ConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { enabled: true, mode: "appliance" },
      },
    }).success).toBe(false);
  });

  it("says nothing about the adapter while the modem is switched off", () => {
    // `enabled: false` is a board with no modem configured, whatever else the
    // section says. Refusing it would strand a device whose operator turned
    // an appliance off rather than deleting its settings — and the shipped
    // default is exactly that shape.
    expect(ConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { enabled: false, mode: "appliance", interface: null },
      },
    }).success).toBe(true);
  });

  it("says nothing about the adapter for a modem the system finds itself", () => {
    // `auto` is the modem ModemManager claims. It is located by asking, not
    // by being named, and requiring a name here would refuse the commonest
    // working configuration there is.
    expect(ConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { enabled: true, mode: "auto", interface: null, apn: "ereseller" },
      },
    }).success).toBe(true);
  });

  it("refuses a mode it does not have", () => {
    // `hilink` and `stick` were the sketch in configuration.md and are not
    // what shipped. A misspelling silently accepted is a setting an operator
    // believes is in force and is not.
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network, modem: { mode: "hilink" } },
    })).toThrow();
  });
});

describe("remote", () => {
  it("defaults remote.zerotier to disabled with no network", () => {
    const cfg = ConfigSchema.parse({ version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} } });
    expect(cfg.remote.zerotier.enabled).toBe(false);
    expect(cfg.remote.zerotier.network_id).toBeNull();
  });

  it("accepts a 16-hex network id", () => {
    const cfg = ConfigSchema.parse({
      version: 1,
      network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { editor: {} },
      remote: { zerotier: { enabled: true, network_id: "9fef8a3bf9000001" } },
    });
    expect(cfg.remote.zerotier.network_id).toBe("9fef8a3bf9000001");
  });

  // A wrong id draws no complaint from the client at all - it sits in
  // REQUESTING_CONFIGURATION for ever - so this is the last chance to catch one.
  it.each(["9FEF8A3BF9000001", "9fef8a3bf900000", "9fef8a3bf90000012", "9fef8a3bf900000g", ""])(
    "rejects %s as a network id",
    (bad) => {
      expect(() =>
        ConfigSchema.parse({
          version: 1,
          network: { ap: { psk: { secret: "ap_psk" } } },
          ui: { editor: {} },
          remote: { zerotier: { network_id: bad } },
        }),
      ).toThrow();
    },
  );

  it("rejects a key that was never a Yonder setting", () => {
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        network: { ap: { psk: { secret: "ap_psk" } } },
        ui: { editor: {} },
        remote: { zerotier: { netwrok_id: "9fef8a3bf9000001" } },
      }),
    ).toThrow();
  });
});

describe("cameras", () => {
  it("defaults cameras to an empty list", () => {
    const cfg = ConfigSchema.parse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    });
    expect(cfg.cameras).toEqual([]);
  });

  it("fills a camera's defaults from its identity alone", () => {
    const cfg = ConfigSchema.parse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [{ id: "cam0", name: "Nose", source: "usb", device: "usb-0000:01:00.0-1.2" }],
    });
    const cam = cfg.cameras[0];
    expect(cam).toMatchObject({
      enabled: true, autostart: false,
      width: 1280, height: 720, framerate: 30,
      codec: "h264", bitrate_kbps: 2000, outputs: [],
    });
    expect(cam.preview).toEqual({ width: 640, height: 360, framerate: 15, bitrate_kbps: 400 });
    expect(cam.controls).toEqual({ brightness: null, contrast: null, rotation: 0 });
  });

  it("bounds the preview so no setting of it can saturate a link", () => {
    // The preview is exempt from the confirmation window (reachability.ts), and
    // that exemption is only safe because this bound exists. Widening it means
    // moving `preview` out of the exempt list in the same change.
    const base = { version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} } };
    const withPreview = (preview: unknown) =>
      ConfigSchema.safeParse({ ...base, cameras: [
        { id: "cam0", name: "Nose", source: "usb", device: "usb-1", preview },
      ] });
    expect(withPreview({ bitrate_kbps: 2000 }).success).toBe(true);
    expect(withPreview({ bitrate_kbps: 2001 }).success).toBe(false);
    expect(withPreview({ width: 1280 }).success).toBe(true);
    expect(withPreview({ width: 1281 }).success).toBe(false);
  });

  it("refuses two cameras with the same id", () => {
    const r = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [
        { id: "cam0", name: "A", source: "usb", device: "usb-1" },
        { id: "cam0", name: "B", source: "usb", device: "usb-2" },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("cam0");
  });

  it("refuses an output on the console's own port", () => {
    // A bind race after a reboot is a configuration that confirms while it looks
    // fine and bites on the next boot. The confirmation window never catches it,
    // because on the day it is applied nothing collides.
    const r = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { port: 3000, editor: {} },
      cameras: [{
        id: "cam0", name: "Nose", source: "usb", device: "usb-1",
        outputs: [{ kind: "srt", port: 3000 }],
      }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("ui.port");
  });

  it("refuses two cameras that would publish to one media path", () => {
    // Unique ids are not enough: a camera's preview is served at its id plus
    // `-preview`, so `nose` and `nose-preview` both want `nose-preview`.
    // mediamtx takes one publisher per path, so the second pipeline's ANNOUNCE
    // is refused with 400 and that camera dies while the first goes on
    // working — the hardest shape of fault to read off a page.
    const r = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [
        { id: "nose", name: "A", source: "usb", device: "usb-1" },
        { id: "nose-preview", name: "B", source: "usb", device: "usb-2" },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("nose-preview");
  });

  it("refuses an output on a port the media server binds", () => {
    // The same class as ui.port above, and the one that was open: mediamtx
    // does not degrade when two of its servers want one port, it exits — so
    // an SRT output on 8890 takes *every* camera on the device off the air,
    // including the browser's, on a boot with nobody watching a countdown.
    // 8890 was the branch's own fixture value.
    const withPort = (port: number) => ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { port: 1880, editor: {} },
      cameras: [{
        id: "cam0", name: "Nose", source: "usb", device: "usb-1",
        outputs: [{ kind: "srt", port }],
      }],
    });
    for (const port of [RTSP_PORT, WEBRTC_PORT, WEBRTC_LOCAL_UDP_PORT, SRT_PORT]) {
      const r = withPort(port);
      expect(r.success, `port ${port}`).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("media server");
    }
    // And nothing else: a port the device does not bind is an operator's to
    // choose, and a schema refusing one of those refuses a working device.
    expect(withPort(9998).success).toBe(true);
  });

  it("leaves a ground station's own port alone, because nothing here binds it", () => {
    // An `rtp` output names a port on the *other* machine — `udpsink` binds
    // nothing on this device — so 8554 there is not this board's RTSP server
    // and refusing it would refuse a configuration that works.
    const r = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [{
        id: "cam0", name: "Nose", source: "usb", device: "usb-1",
        outputs: [{ kind: "rtp", host: "192.168.1.50", port: RTSP_PORT }],
      }],
    });
    expect(r.success).toBe(true);
  });

  it("holds an RTSP password by reference, never inline", () => {
    const ok = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [{
        id: "cam0", name: "Nose", source: "usb", device: "usb-1",
        outputs: [{ kind: "rtsp", password: { secret: "rtsp_password" } }],
      }],
    });
    expect(ok.success).toBe(true);
    const inline = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [{
        id: "cam0", name: "Nose", source: "usb", device: "usb-1",
        outputs: [{ kind: "rtsp", password: "hunter2" }],
      }],
    });
    expect(inline.success).toBe(false);
  });
});
