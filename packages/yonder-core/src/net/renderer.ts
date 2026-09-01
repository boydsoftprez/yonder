// SPDX-License-Identifier: GPL-3.0-or-later
import type { Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";
import { NmcliClient } from "./nmcli/client.js";
import { writeDnsmasqConf, DNSMASQ_DROPIN } from "./dnsmasq.js";
import {
  desiredProfiles, AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION,
  type Interfaces,
} from "./profiles.js";

/** The only connection names this renderer will ever create or delete. */
const OWNED = new Set([AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION]);

export interface NetworkRendererOptions {
  client: NmcliClient;
  secrets: SecretStore;
  dnsmasqPath?: string;
  log?: (line: string) => void;
}

export class NetworkRenderer implements Renderer {
  readonly name = "network";
  private readonly client: NmcliClient;
  private readonly secrets: SecretStore;
  private readonly dnsmasqPath: string;
  private readonly log: (line: string) => void;

  constructor(opts: NetworkRendererOptions) {
    this.client = opts.client;
    this.secrets = opts.secrets;
    this.dnsmasqPath = opts.dnsmasqPath ?? DNSMASQ_DROPIN;
    this.log = opts.log ?? (() => {});
  }

  async render(config: Config): Promise<void> {
    const devices = await this.client.devices();
    const ifaces: Interfaces = {
      wifi: devices.find((d) => d.type === "wifi")?.device ?? null,
      ethernet: devices.find((d) => d.type === "ethernet")?.device ?? null,
    };
    this.log(`network: wifi=${ifaces.wifi ?? "none"} ethernet=${ifaces.ethernet ?? "none"}`);

    const desired = desiredProfiles(config, this.secrets, ifaces);
    const wanted = new Set(desired.map((p) => p.name));

    // Remove only what we own and no longer want. A connection created by
    // someone else is never touched.
    for (const existing of await this.client.connections()) {
      if (OWNED.has(existing.name) && !wanted.has(existing.name)) {
        this.log(`network: removing ${existing.name}`);
        await this.client.remove(existing.name);
      }
    }

    for (const profile of desired) {
      await this.client.addOrModify(profile.name, profile.settings);
    }

    if (ifaces.wifi !== null) {
      writeDnsmasqConf(this.dnsmasqPath, config);
    }

    // The access point is brought up or taken down deliberately; everything
    // else autoconnects.
    if (ifaces.wifi !== null) {
      const apActive = devices.some((d) => d.connection === AP_CONNECTION);
      if (config.network.ap.enabled && !apActive) {
        this.log("network: bringing the access point up");
        await this.client.up(AP_CONNECTION);
      } else if (!config.network.ap.enabled && apActive) {
        this.log("network: taking the access point down");
        await this.client.down(AP_CONNECTION);
      }
    }
  }
}
