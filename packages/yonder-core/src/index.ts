// SPDX-License-Identifier: GPL-3.0-or-later
export const VERSION = "0.1.0";
export { ConfigSchema, DEFAULT_CONFIG, type Config, type SecretRef } from "./schema/config.js";
export {
  RETIRED_KEYS,
  withoutRetiredKeys,
  retirementNotice,
  type RetiredKey,
} from "./schema/retired.js";
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
export {
  hashPassword,
  verifyPassword,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  SALT_BYTES,
  KEY_BYTES,
} from "./console/password.js";
export {
  AdminCredential,
  ADMIN_PASSWORD_SECRET,
  MIN_PASSWORD_LENGTH,
  type SetResult,
  type SetRefusal,
} from "./console/credential.js";
export {
  AttemptThrottle,
  FAILURE_LIMIT,
  LOCKOUT_MS,
  type ThrottleDecision,
  type ThrottleOptions,
} from "./console/throttle.js";
export {
  SECRET_KEYS,
  REDACTED,
  isSecretKey,
  secretValuesIn,
  redactValues,
} from "./secrets/redact.js";
export {
  DaemonClient,
  unixTransport,
  REQUEST_TIMEOUT_MS,
  type Transport,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonReply,
  type DaemonFailure,
  type DaemonClientOptions,
  type PasswordResult,
} from "./console/client.js";
export { SessionStore, IDLE_TIMEOUT_MS, type SessionStoreOptions } from "./console/session.js";
export {
  setupMiddleware,
  consoleMiddleware,
  readFields,
  cookieValue,
  SESSION_COOKIE,
  type Middleware,
  type Submission,
  type SetupMiddlewareDeps,
  type ConsoleMiddlewareDeps,
} from "./console/middleware.js";
export { renderPage, pageSource, escapeHtml, type PageName } from "./console/assets.js";
export {
  renderSettings,
  consolePaths,
  DEFAULT_CONSOLE_PATHS,
  SETUP_FLOW_FILE,
  CONSOLE_FLOW_FILE,
  EMPTY_FLOWS,
  EDITOR_ROOT,
  EXCLUDED_NODES,
  type ConsolePaths,
  type RenderSettingsOptions,
} from "./console/settings.js";
export { ConsoleRenderer, type ConsoleRendererOptions } from "./console/renderer.js";
export {
  consoleGate,
  editorAuth,
  ADMIN_USERNAME,
  type GateOptions,
  type EditorAuth,
  type EditorUser,
} from "./console/wiring.js";
export {
  boardFacts,
  parseModel,
  parseLoadAverage,
  parseMeminfo,
  parseUptime,
  parseCpuTemperature,
  type BoardFacts,
  type FactSources,
  type LoadAverage,
  type MemoryFacts,
} from "./system/facts.js";
export {
  readBoardFacts,
  readFactSources,
  systemReader,
  DEFAULT_FACT_PATHS,
  type FileReader,
  type FactPaths,
  type ReadFactsOptions,
} from "./system/read.js";
export {
  readVersions,
  parseOsRelease,
  parsePackageVersion,
  DEFAULT_OS_RELEASE,
  DEFAULT_PACKAGE_MANIFEST,
  type Versions,
  type ReadVersionsOptions,
} from "./system/versions.js";
export {
  ping,
  reachable,
  isProbeHost,
  parsePingSummary,
  MAX_COUNT,
  DEFAULT_COUNT,
  PROBE_TIMEOUT_MS,
  DEFAULT_REACHABILITY_HOST,
  type PingResult,
  type PingSummary,
  type ProbeFailure,
  type ProbeOptions,
} from "./diag/probe.js";
