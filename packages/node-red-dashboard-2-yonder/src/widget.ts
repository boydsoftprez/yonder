// SPDX-License-Identifier: GPL-3.0-or-later
import type { RED, RedNode, UiGroup } from "./red.js";

/**
 * Registering a Yonder widget with Node-RED and with its Dashboard group.
 *
 * Every widget in this package is the same shape: it declares some static
 * configuration in the editor, it renders what arrives on `msg.payload`, and
 * it decides nothing. So the registration is written once here rather than
 * five times, and each widget module contributes only the part that differs —
 * which fields it reads out of its editor form.
 *
 * **Nothing in this package computes what a value means.** The bands a
 * reading falls into come from `reading()` in `yonder-core`, which is tested
 * there and used by the Vue component directly, so there is one rule rather
 * than one per surface (ADR-0009, R-UI-09). A widget that started deciding
 * its own colour here would be the drift ADR-0005 wrote the command-state
 * language to prevent.
 */

/**
 * Reads one editor field, falling back when it is absent or unusable.
 *
 * An empty string is absent, not zero. `Number("")` is `0` and `0` is finite,
 * so the obvious version of this function silently turns a blank Max field
 * into a scale of zero height — an instrument that draws nothing and reports
 * no error.
 */
export function num(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** As `num`, but `undefined` rather than a default: an unset band has none. */
export function optionalNum(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Parses a JSON editor field into a list, and never throws into Node-RED's
 * loader.
 *
 * A malformed field is an empty list and a node error, not a stack trace at
 * flow-load time. R-SEC-12's spirit applied to presentation: a widget that
 * cannot render its own configuration must not stop the console starting,
 * because a console that will not start is a device the operator cannot
 * reach.
 */
export function list<T>(value: unknown, node: RedNode, field: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as T[];
    node.error(`${field} is not a list; nothing will be drawn`);
    return [];
  } catch {
    node.error(`${field} is not valid JSON; nothing will be drawn`);
    return [];
  }
}

/** What a widget module supplies: its type, and how to read its own form. */
export interface WidgetDefinition {
  type: string;
  /** Editor fields this widget renders from, resolved once at construction. */
  props(node: RedNode, config: Record<string, unknown>): Record<string, unknown>;
  /**
   * Whether this widget sends anything back.
   *
   * **Dashboard drops a `widget-action` unless the widget registered
   * `onAction`** — `if (!wNode || !widgetEvents.onAction) return`, in its
   * ui-base. There is no error and no warning: the component emits, the socket
   * carries it, the server looks up the widget and returns. Every soft key on
   * every page shipped dead because this was registered as `{}`, and nothing
   * could see it: the nodes were right, the wiring was right, the pages
   * captured correctly, and pressing a key did nothing at all.
   *
   * Read-only instruments leave it off. A gauge that could emit is a gauge
   * that could originate a command.
   */
  emitsActions?: boolean;
}

/**
 * Register a widget with both halves of the runtime.
 *
 * The group lookup can fail — a widget dragged onto a flow before it has been
 * given a group is a normal intermediate state in the editor, not a fault —
 * so a missing group is a node error and a node that does nothing, never a
 * throw. Node-RED loads the rest of the flow either way, which is what keeps
 * one half-wired widget from taking the console down with it.
 */
export function registerWidget(RED: RED, definition: WidgetDefinition): void {
  RED.nodes.registerType(definition.type, function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const group = RED.nodes.getNode(String(config.group ?? "")) as UiGroup | null;
    if (!group || typeof group.register !== "function") {
      node.error(`${definition.type} has no dashboard group; it will not be drawn`);
      return;
    }

    // Static configuration travels to the component as `props`. The live value
    // arrives separately, on msg.payload, and Dashboard's default input
    // handling stores and forwards it — which is all these widgets need.
    //
    // `onAction` is what makes a press reach the node's output. See the note
    // on `emitsActions`: without it Dashboard silently drops the event.
    const events = definition.emitsActions ? { onAction: true } : {};
    group.register(node, { ...config, ...definition.props(node, config) }, events);
  });
}
