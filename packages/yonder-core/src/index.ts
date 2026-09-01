// SPDX-License-Identifier: GPL-3.0-or-later
export const VERSION = "0.1.0";
export { ConfigSchema, DEFAULT_CONFIG, type Config, type SecretRef } from "./schema/config.js";
export { loadConfig } from "./config/load.js";
export { saveConfig } from "./config/save.js";
export { ConfigError } from "./config/errors.js";
export { SecretStore } from "./secrets/store.js";
export { generateSecret } from "./secrets/generate.js";
export { ApplyEngine } from "./apply/engine.js";
export { systemClock, type Renderer, type Clock, type ApplyStatus } from "./apply/types.js";
export { startServer } from "./daemon/server.js";
