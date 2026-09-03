// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { list, num, optionalNum, registerWidget, str } from "./widget.js";
import type { RED, RedNode, UiGroup } from "./red.js";

/**
 * Loaded at module scope, the way the sibling contrib packages do it. These
 * modules use TypeScript's `export =` for Node-RED's loader, and that interop
 * resolves here but not inside a test body.
 */
const gaugeNode = (await import("./gauge.js")).default ?? await import("./gauge.js");
const tapeNode = (await import("./tape.js")).default ?? await import("./tape.js");
const annunciatorNode = (await import("./annunciator.js")).default ?? await import("./annunciator.js");
const databarNode = (await import("./databar.js")).default ?? await import("./databar.js");
const softkeysNode = (await import("./softkeys.js")).default ?? await import("./softkeys.js");
const identityNode = (await import("./identity.js")).default ?? await import("./identity.js");
const sparklineNode = (await import("./sparkline.js")).default ?? await import("./sparkline.js");

/**
 * What is tested here, and what honestly cannot be.
 *
 * These are the **node halves** of the widgets: registration with Node-RED,
 * registration with the Dashboard group, and the reading of an editor form.
 * That is the part that runs in Node-RED and the part a flow depends on.
 *
 * The Vue halves are not exercised. Rendering them needs Dashboard's own
 * runtime — the `$socket` and `$dataTracker` it injects, and its Vuex store —
 * and a mock of those would assert that our mock behaves like our mock. What
 * the components draw is checked where it can be checked honestly: `reading()`
 * is tested in `yonder-core`, and the pages get captured in both palettes by
 * the gate R-UI-12 asks for. Until that gate exists and this has run on a
 * board, the rendering is unverified, and `docs/known-issues.md` says so
 * rather than this file implying otherwise.
 */

interface Registered {
  type: string;
  construct: (this: RedNode, config: Record<string, unknown>) => void;
}

function fakeNode(): RedNode {
  return { id: "n1", type: "test", send: vi.fn(), error: vi.fn(), on: vi.fn() } as unknown as RedNode;
}

/** A Node-RED double that records what a widget registers, and with whom. */
function fakeRED(group: UiGroup | null) {
  const registered: Registered[] = [];
  const RED: RED = {
    settings: {},
    nodes: {
      createNode: vi.fn(),
      getNode: vi.fn(() => group as UiGroup),
      registerType: (type, construct) => { registered.push({ type, construct }); },
    },
  };
  return { RED, registered };
}

function fakeGroup() {
  return { register: vi.fn() } as unknown as UiGroup & { register: ReturnType<typeof vi.fn> };
}

/** Build a widget and hand back what it passed to `group.register`. */
function build(
  module: (RED: RED) => void,
  config: Record<string, unknown>,
  group: (UiGroup & { register: ReturnType<typeof vi.fn> }) | null = fakeGroup(),
) {
  const { RED, registered } = fakeRED(group);
  module(RED);
  const node = fakeNode();
  registered[0]!.construct.call(node, { group: "g1", ...config });
  const call = group?.register.mock.calls[0] as
    [RedNode, Record<string, unknown>, Record<string, unknown>] | undefined;
  return { node, group, type: registered[0]!.type, props: call?.[1], events: call?.[2] };
}

describe("field readers", () => {
  it("num falls back when a field is empty or unusable", () => {
    expect(num(42, 1)).toBe(42);
    expect(num("42", 1)).toBe(42);
    expect(num("", 1)).toBe(1);
    expect(num(undefined, 1)).toBe(1);
    expect(num("not a number", 1)).toBe(1);
    expect(num(Number.NaN, 1)).toBe(1);
    expect(num("   ", 1)).toBe(1);
  });

  it("num does not turn a blank field into zero", () => {
    // Number("") is 0 and 0 is finite, so the obvious implementation makes a
    // blank Max a scale of zero height: an instrument that draws nothing and
    // says nothing about why.
    expect(num("", 100)).toBe(100);
    expect(num("", 0)).toBe(0);
    expect(num(0, 100)).toBe(0);
  });

  it("optionalNum keeps an unset band unset rather than defaulting it", () => {
    // The distinction R-UI-09 rests on: a band nobody configured is absent,
    // and a reading with no bands is neutral rather than green.
    expect(optionalNum(60)).toBe(60);
    expect(optionalNum("60")).toBe(60);
    expect(optionalNum("")).toBeUndefined();
    expect(optionalNum(undefined)).toBeUndefined();
    expect(optionalNum(null)).toBeUndefined();
    expect(optionalNum("nonsense")).toBeUndefined();
    expect(optionalNum("   ")).toBeUndefined();
  });

  it("optionalNum keeps a legitimate zero", () => {
    expect(optionalNum(0)).toBe(0);
  });

  it("str falls back for a non-string", () => {
    expect(str("CPU")).toBe("CPU");
    expect(str(undefined)).toBe("");
    expect(str(7, "x")).toBe("x");
  });

  describe("list", () => {
    it("accepts an array as it stands", () => {
      const node = fakeNode();
      expect(list([{ a: 1 }], node, "cells")).toEqual([{ a: 1 }]);
      expect(node.error).not.toHaveBeenCalled();
    });

    it("parses JSON from a textarea", () => {
      const node = fakeNode();
      expect(list('[{"key":"host"}]', node, "cells")).toEqual([{ key: "host" }]);
    });

    it("treats an empty field as empty rather than as an error", () => {
      const node = fakeNode();
      expect(list("", node, "cells")).toEqual([]);
      expect(list("   ", node, "cells")).toEqual([]);
      expect(node.error).not.toHaveBeenCalled();
    });

    it("reports malformed JSON as a node error and never throws", () => {
      // A widget that cannot render its own configuration must not stop the
      // console loading: a console that will not start is a device the
      // operator cannot reach (R-SEC-12's spirit).
      const node = fakeNode();
      expect(() => list("{not json", node, "cells")).not.toThrow();
      expect(list("{not json", node, "cells")).toEqual([]);
      expect(node.error).toHaveBeenCalled();
    });

    it("reports valid JSON that is not a list", () => {
      const node = fakeNode();
      expect(list('{"key":"host"}', node, "cells")).toEqual([]);
      expect(node.error).toHaveBeenCalled();
    });
  });
});

describe("registerWidget", () => {
  it("registers with Node-RED and with the dashboard group", () => {
    const module = (RED: RED) =>
      registerWidget(RED, { type: "ui-yonder-test", props: () => ({ label: "L" }) });
    const { group, type } = build(module, {});
    expect(type).toBe("ui-yonder-test");
    expect(group!.register).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved props alongside the raw config", () => {
    const module = (RED: RED) =>
      registerWidget(RED, { type: "ui-yonder-test", props: () => ({ label: "CPU TEMP" }) });
    const { props } = build(module, { order: 3 });
    expect(props).toMatchObject({ order: 3, label: "CPU TEMP" });
  });

  it("errors, and draws nothing, when the widget has no group", () => {
    // Normal while a widget is being wired in the editor, so it is a node
    // error rather than a throw: Node-RED has to load the flow around it.
    const module = (RED: RED) => registerWidget(RED, { type: "ui-yonder-test", props: () => ({}) });
    const { node } = build(module, {}, null);
    expect(node.error).toHaveBeenCalledWith(expect.stringContaining("no dashboard group"));
  });
});

describe("the widgets", () => {
  it("gauge carries its label, unit and bands", () => {
    const { props } = build(gaugeNode as (RED: RED) => void, { label: "CPU TEMP", unit: "C", max: 85, caution: 60, limit: 80 });
    expect(props).toMatchObject({ label: "CPU TEMP", unit: "C", min: 0, max: 85, caution: 60, limit: 80 });
  });

  it("gauge defaults its track to a fixed width, never a stretched one", () => {
    // ADR-0009's one layout rule for this object: a bar that fills its column
    // is the slab this language replaced.
    expect(build(gaugeNode as (RED: RED) => void, {}).props!.track).toBe(118);
  });

  it("gauge leaves caution and limit unset when the form is blank", () => {
    const { props } = build(gaugeNode as (RED: RED) => void, { max: 100 });
    expect(props!.caution).toBeUndefined();
    expect(props!.limit).toBeUndefined();
  });

  it("tape carries its scale and divisions", () => {
    const { props } = build(tapeNode as (RED: RED) => void, { max: 85, caution: 60, limit: 80, divisions: 6, height2: 200 });
    expect(props).toMatchObject({ max: 85, caution: 60, limit: 80, divisions: 6, height: 200 });
  });

  it("sparkline carries its label and chart height", () => {
    const { props, type } = build(sparklineNode as (RED: RED) => void, { label: "THROUGHPUT", height2: 64 });
    expect(type).toBe("ui-yonder-sparkline");
    expect(props).toMatchObject({ label: "THROUGHPUT", chartHeight: 64 });
  });

  it("sparkline defaults its chart height rather than collapsing to zero", () => {
    // The same trap `num` exists to avoid: an unset height2 must not become
    // a chart with no height at all.
    expect(build(sparklineNode as (RED: RED) => void, {}).props!.chartHeight).toBe(48);
  });

  /**
   * Dashboard reads `widgetConfig.height` off this exact merged object as the
   * widget's *grid row count* (`nodes/config/ui_base.js`: `props:
   * widgetConfig` and `layout.height: widgetConfig.height || 1` are the same
   * object). A computed prop named `height` does not sit beside that field,
   * it replaces it — this widget's own default would ask Dashboard for 48
   * grid rows, not a 48px chart, and the console found that shape change in
   * a real capture before this test existed to say why.
   */
  it("never names a prop 'height' - that key is Dashboard's grid row count", () => {
    // `height: 1` here stands in for the grid-row field every real node
    // instance carries. The assertion is that the computed props object
    // leaves it alone rather than overwriting it with the chart's own pixel
    // height, the way `ui-yonder-tape` still does.
    const { props } = build(sparklineNode as (RED: RED) => void, { height: 1, height2: 64 });
    expect(props!.height).toBe(1);
    expect(props!.chartHeight).toBe(64);
  });

  it("annunciator reads the shared command channel by default", () => {
    expect(build(annunciatorNode as (RED: RED) => void, {}).props!.source).toBe("yonder");
    expect(build(annunciatorNode as (RED: RED) => void, { source: "payload" }).props!.source).toBe("payload");
    // Anything else falls back to the shared channel rather than to nothing.
    expect(build(annunciatorNode as (RED: RED) => void, { source: "nonsense" }).props!.source).toBe("yonder");
  });

  it("data bar carries its cells", () => {
    const { props } = build(databarNode as (RED: RED) => void, { cells: '[{"key":"host","label":"HOST","kind":"id"}]' });
    expect(props!.cells).toEqual([{ key: "host", label: "HOST", kind: "id" }]);
  });

  it("identity names the payload property it shows", () => {
    const { props, type } = build(identityNode as (RED: RED) => void, { label: "THIS DEVICE", key: "deviceId" });
    expect(type).toBe("ui-yonder-identity");
    expect(props).toMatchObject({ label: "THIS DEVICE", key: "deviceId" });
  });

  it("identity falls back to a key rather than to no key at all", () => {
    // An unset field must not become `undefined`, which would read
    // `payload[undefined]` and draw an em dash for ever with no clue why.
    expect(build(identityNode as (RED: RED) => void, {}).props!.key).toBe("value");
    expect(build(identityNode as (RED: RED) => void, { key: 7 }).props!.key).toBe("value");
  });

  it("soft keys carry their keys", () => {
    const { props } = build(softkeysNode as (RED: RED) => void, { keys: '[{"label":"REFRESH","action":"refresh","tone":"act"}]' });
    expect(props!.keys).toEqual([{ label: "REFRESH", action: "refresh", tone: "act" }]);
  });

  /**
   * The press has to reach the node.
   *
   * Dashboard drops a `widget-action` unless the widget registered `onAction`
   * — silently, with no error anywhere. Every soft key shipped dead because
   * this was `{}`: the nodes registered, the groups resolved, the pages
   * captured correctly, and pressing a key did nothing. No layout check can
   * see that, so it is asserted here.
   */
  it("registers onAction for the soft keys, or every press is dropped", () => {
    const { events } = build(softkeysNode as (RED: RED) => void, { keys: "[]" });
    expect(events, "soft keys must register onAction").toMatchObject({ onAction: true });
  });

  it("leaves onAction off the read-only instruments", () => {
    // A gauge that could emit is a gauge that could originate a command.
    for (const mod of [gaugeNode, tapeNode, annunciatorNode, databarNode, identityNode, sparklineNode]) {
      const { events } = build(mod as (RED: RED) => void, {});
      expect(events?.onAction, "an instrument must not send").toBeUndefined();
    }
  });

  it("a malformed list field leaves the widget drawing nothing, not throwing", () => {
    const { node, props } = build(databarNode as (RED: RED) => void, { cells: "[[[" });
    expect(props!.cells).toEqual([]);
    expect(node.error).toHaveBeenCalled();
  });
});
