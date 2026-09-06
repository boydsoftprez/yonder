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
export {
  reading,
  type Reading,
  type ReadingBounds,
  type ReadingTone,
} from "./console/reading.js";
export { groupThousands } from "./console/digits.js";
export { ConfigWatch, configFingerprint } from "./console/changed.js";
export { startServer } from "./daemon/server.js";
export {
  systemRunner,
  boundedRunner,
  RUN_TIMEOUT_MS,
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
  radioPlan,
  wifiMode,
  type DesiredProfile,
  type Interfaces,
  type RadioStep,
  type WifiMode,
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
export { FallbackWatchdog, CARRYING_DEADLINE_MS, type FallbackWatchdogOptions } from "./net/watchdog.js";
export {
  MmcliClient,
  MmcliError,
  controlPort,
  type ModemInfo,
  type ModemPorts,
  type BearerInfo,
  type SignalReading,
} from "./net/modem/mmcli/client.js";
export { modemState, type ModemState, type ModemMode } from "./net/modem/state.js";
export { ModemNetPort, MODEM_READ_DEADLINE_MS } from "./net/modem/netport.js";
export { MODEM_CONNECTION, modemProfile, metricFor } from "./net/modem/profiles.js";
export {
  Standing,
  PATH_WORDS,
  FAILURES_TO_STAND_DOWN,
  SUCCESSES_TO_RETURN,
  REACH_TICK_MS,
  REACH_TICK_DEADLINE_MS,
  type PathName,
  type PathStanding,
  type PathEvidence,
  type PathReport,
  type ReachState,
} from "./net/reach/standing.js";
export { commandProbe, type Probe } from "./net/reach/probe.js";
export {
  systemCounters,
  countersFrom,
  SYS_CLASS_NET,
  movement,
  looksDead,
  type Counters,
  type CounterReader,
} from "./net/reach/counters.js";
export {
  ReachMonitor,
  pathDevices,
  activePath,
  pathInUse,
  pathsHolding,
  type ReachMonitorOptions,
} from "./net/reach/monitor.js";
export { ReachWatch, type ReachWatchOptions } from "./net/reach/watch.js";
export { withDeadline } from "./net/deadline.js";
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
  redactNamedValues,
  redactGuarded,
  redactLine,
  guardSecretValue,
  forgetGuardedValues,
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
export { warn, note } from "./log.js";
export {
  ActivityLog,
  activityLog,
  ACTIVITY_CAPACITY,
  ACTIVITY_MESSAGE_LIMIT,
  type ActivityEntry,
  type ActivityLevel,
  type ActivityPage,
  type ActivityLogOptions,
} from "./log/activity.js";
export { scanForNetworks, type ScanResult } from "./net/scan.js";
export type {
  DiagProbes, SystemReport, WayBackIn,
  // What the Telemetry page binds. `MavlinkStateBody` is deliberately two
  // named halves rather than one flat record — see its own docstring.
  MavlinkControl, MavlinkStateBody, MavlinkDetectBody,
} from "./daemon/routes.js";
export { HostnameRenderer, HOSTNAME_FILE, type HostnameRendererOptions } from "./system/hostname.js";
export {
  idle,
  pending,
  confirmed,
  rejected,
  presentation,
  secondsRemaining,
  countdown,
  type CommandState,
  type CommandStatus,
  type CommandPresentation,
  type CommandOptions,
} from "./console/command.js";
export {
  pollIntervalMs,
  socketPathFrom,
  clientFor,
  fetched,
  applyStatus,
  confirmStatus,
  pendingChange,
  revertStatus,
  readFailure,
  wayBackInView,
  PENDING_WHAT,
  PENDING_WHY,
  PENDING_WHAT_RADIO,
  PENDING_WHY_RADIO,
  PENDING_KEYS,
  PENDING_KEYS_RADIO,
  CONFIRM_KEY,
  REVERT_KEY,
  WAY_BACK_IN_NOTE,
  AP_PASSPHRASE_CHANGED,
  AP_PASSPHRASE_UNKNOWN,
  AP_PASSPHRASE_UNKNOWN_NOTE,
  MIN_POLL_MS,
  DEFAULT_POLL_MS,
  DEFAULT_SOCKET_PATH,
  type Fetched,
  type PendingChange,
  type PendingKey,
  type WayBackInView,
} from "./console/node.js";
export {
  displayFacts,
  formatLoad,
  formatMemory,
  formatTemperature,
  formatUptime,
  UNKNOWN,
  type BoardDisplay,
} from "./system/format.js";
export {
  PALETTES,
  DEFAULT_THEME,
  themeCss,
  themeName,
  type Palette,
  type ThemeName,
} from "./console/theme.js";
export {
  joinNetwork,
  CLIENT_PSK_SECRET,
  JOIN_TOPIC,
  type JoinRequest,
  type JoinResult,
  type SecretSink,
} from "./net/join.js";
export {
  configureModem,
  MODEM_PASSWORD_SECRET,
  ModemRequest,
  type ModemConfigureResult,
} from "./net/modem/configure.js";
export { setTheme, THEMES, type ThemeRequest, type ThemeResult } from "./ui/theme.js";
export { ssidOptions, type DropdownOption } from "./net/scan.js";
export { joinSucceeded, type JoinedResult } from "./net/joined.js";
export { STATIC_ROOT, THEME_FILE, THEME_HREF, CONSOLE_HOME } from "./console/settings.js";
export { remoteState, readRemoteState, type RemoteState, type RemotePhase } from "./remote/state.js";
export {
  MavlinkRenderer,
  linkFromConf,
  ROUTER_UNIT,
  ROUTER_CONF_PATH,
  MAVLINK_DEVICES,
  DETECT_RETRY_MS,
  STATS_INTERVAL_MS,
  STATS_LINES,
  type MavlinkRendererOptions,
} from "./mav/renderer.js";
export { LinkTracker, type LinkState } from "./mav/link.js";
export { detect, type DetectOutcome, type OpenPort, type SerialPort } from "./mav/detect.js";
export { HeartbeatScanner, describeVehicle, type Heartbeat } from "./mav/frame.js";
export { readHint, writeHint, forgetHint, type LinkHint } from "./mav/hint.js";
export {
  routerConfig,
  LOOPBACK_PORT,
  RESERVED_ENDPOINT_NAMES,
  AUTOPILOT_ENDPOINT_NAME,
} from "./mav/router/config.js";
export { parseStats, type EndpointStats } from "./mav/router/stats.js";
export { LoopbackListener, LOOPBACK_ADDRESS, type LoopbackListenerOptions } from "./mav/listener.js";
export {
  pathCheck,
  HEARTBEAT_STALE_MS,
  type PathCheck,
  type CheckLink,
  type PathCheckInput,
} from "./mav/check.js";
