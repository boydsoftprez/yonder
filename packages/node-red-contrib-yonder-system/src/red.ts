// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The parts of Node-RED's runtime API these nodes touch, and nothing else.
 *
 * Structural types rather than a dependency on `@types/node-red`: the surface
 * used here is six members wide, and a types package for a runtime this code
 * only adapts to is a version to keep in step for no benefit. If a node ever
 * needs more of Node-RED than this, that is the moment to ask whether it has
 * stopped being an adapter.
 */

export interface NodeMessage {
  payload?: unknown;
  /**
   * The command-state language (ADR-0005, R-UI-05). Every node in both Yonder
   * packages puts a `CommandStatus` here, so a control renders the same
   * whether the message came from a stock widget or a hand-written component.
   */
  yonder?: unknown;
  [key: string]: unknown;
}

export interface NodeStatus {
  fill?: "red" | "green" | "yellow" | "blue" | "grey";
  shape?: "ring" | "dot";
  text?: string;
}

export interface RedNode {
  id: string;
  type: string;
  name?: string;
  send(msg: NodeMessage | NodeMessage[]): void;
  status(status: NodeStatus | string): void;
  error(message: string, msg?: NodeMessage): void;
  /**
   * Node-RED's `send` takes one message, or an array with one entry per
   * output. An entry may be `null`, which means "nothing on that output
   * this time" - which is how `yonder-scan` reports a failure on its
   * table output without also emptying the dropdown it feeds.
   */
  on(event: "input", handler: (msg: NodeMessage, send: (m: NodeMessage | (NodeMessage | null)[]) => void, done: (err?: Error) => void) => void): void;
  on(event: "close", handler: (done: () => void) => void): void;
}

export interface RED {
  settings: unknown;
  nodes: {
    createNode(node: RedNode, config: Record<string, unknown>): void;
    registerType(type: string, constructor: (this: RedNode, config: Record<string, unknown>) => void): void;
  };
}
