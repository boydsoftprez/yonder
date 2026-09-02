// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The parts of Node-RED and Dashboard 2.x these widgets touch, and nothing else.
 *
 * Structural types for the same reason the sibling packages use them: the
 * surface is small, and a types package for a runtime this code only adapts to
 * is a version to keep in step for no benefit.
 *
 * The one addition here is `UiGroup`. A Dashboard widget is registered twice —
 * once with Node-RED so the flow editor knows the node, and once with the
 * group so the page knows to render it. Missing the second registration gives
 * a node that wires up correctly and draws nothing, which is a failure that
 * only appears in a browser.
 */

export interface NodeMessage {
  payload?: unknown;
  topic?: string;
  /** The command-state language (ADR-0005, R-UI-05), as everywhere else. */
  yonder?: unknown;
  [key: string]: unknown;
}

export interface RedNode {
  id: string;
  type: string;
  name?: string;
  send(msg: NodeMessage | NodeMessage[]): void;
  error(message: string, msg?: NodeMessage): void;
  on(event: "input", handler: (msg: NodeMessage, send: (m: NodeMessage) => void, done: (err?: Error) => void) => void): void;
  on(event: "close", handler: (done: () => void) => void): void;
}

/**
 * A `ui-group` config node, as far as a widget is concerned.
 *
 * `register` is Dashboard's; `evts` carries the optional server-side hooks.
 * These widgets pass none — every one of them renders what it is given and
 * decides nothing, so the default input handling is exactly right.
 */
export interface UiGroup {
  register(node: RedNode, config: Record<string, unknown>, evts: Record<string, unknown>): void;
}

export interface RED {
  settings: unknown;
  nodes: {
    createNode(node: RedNode, config: Record<string, unknown>): void;
    getNode(id: string): UiGroup | RedNode | null;
    registerType(type: string, constructor: (this: RedNode, config: Record<string, unknown>) => void): void;
  };
}
