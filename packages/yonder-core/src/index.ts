// SPDX-License-Identifier: GPL-3.0-or-later
export const VERSION = "0.1.0";
export { ConfigSchema, DEFAULT_CONFIG, type Config, type SecretRef } from "./schema/config.js";
export { loadConfig } from "./config/load.js";
export { saveConfig } from "./config/save.js";
export { renderDefaultConfig, seedConfigIfAbsent } from "./config/defaults.js";
export { ConfigError } from "./config/errors.js";
export { SecretStore } from "./secrets/store.js";
export { generateSecret } from "./secrets/generate.js";
export { ApplyEngine } from "./apply/engine.js";
export {
  systemClock,
  type Renderer,
  type Clock,
  type ApplyStatus,
  type ApplyState,
  type ApplyResult,
  type ApplyOutcome,
} from "./apply/types.js";
export { startServer } from "./daemon/server.js";
export {
  systemRunner,
  redactArgv,
  type CommandRunner,
  type CommandResult,
} from "./net/runner.js";
export {
  NmcliClient,
  NmcliError,
  type DeviceInfo,
  type ConnectionInfo,
  type AccessPointInfo,
} from "./net/nmcli/client.js";
export {
  DEFAULT_AP_PASSPHRASE,
  AP_CONNECTION,
  CLIENT_CONNECTION,
  ETHERNET_CONNECTION,
  apProfile,
  clientProfile,
  ethernetProfile,
  desiredProfiles,
  type DesiredProfile,
  type Interfaces,
} from "./net/profiles.js";
export {
  NetworkRenderer,
  deviceIsUsable,
  RADIO_WAIT_MS,
  RADIO_POLL_MS,
  type NetworkRendererOptions,
} from "./net/renderer.js";
export {
  enableWifiRadio,
  radioWanted,
  RFKILL_UNBLOCK_WIFI,
  NMCLI_RADIO_WIFI_ON,
} from "./net/radio.js";
export { FallbackWatchdog, type FallbackWatchdogOptions } from "./net/watchdog.js";
export { DNSMASQ_DROPIN, renderDnsmasqConf, writeDnsmasqConf } from "./net/dnsmasq.js";
