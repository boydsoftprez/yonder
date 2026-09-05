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
const holdkeyNode = (await import("./holdkey.js")).default ?? await import("./holdkey.js");
const pictureNode = (await import("./picture.js")).default ?? await import("./picture.js");
const factsNode = (await import("./facts.js")).default ?? await import("./facts.js");
const budgetNode = (await import("./budget.js")).default ?? await import("./budget.js");
const deckNode = (await import("./deck.js")).default ?? await import("./deck.js");
const aimNode = (await import("./aim.js")).default ?? await import("./aim.js");

/**
 * What is tested here, and what honestly cannot be.
 *
 * These are the **node halves** of the widgets: registration with Node-RED,
 * registration with the Dashboard group, and the reading of an editor form.
 * That is the part that runs in Node-RED and the part a flow depends on.
 *
 * Seven of the nine widgets' Vue halves are not exercised here, and that is
 * still correct: a gauge, a tape, an annunciator, a data bar, an identity, a
 * sparkline and a soft-key rail all draw what they are given and decide
 * nothing, so mounting one against a mocked `$socket`, `$dataTracker` and
 * Vuex store would only assert that our mock behaves like our mock. What
 * they draw is checked where it can be checked honestly: `reading()` is
 * tested in `yonder-core`, and the pages get captured in both palettes by
 * the gate R-UI-12 asks for. Until that gate exists and this has run on a
 * board, the rendering is unverified, and `docs/known-issues.md` says so
 * rather than this file implying otherwise.
 *
 * `YonderHoldKey` and `YonderPicture` are the other two, and neither is
 * exempt. The hold key carries a state machine — four release paths and two
 * duplicate-collapse guards — and the picture carries a larger one: a mode
 * machine, a twelve-second deadline, a reconnect loop with backoff and a
 * degrade that is a function of elapsed time. What either does with an event
 * is a decision, not a drawing. Both are tested directly, in
 * `./ui/holdkey.component.test.ts` and `./ui/picture.component.test.ts`:
 * mounted for real with `@vue/test-utils` against jsdom, with only
 * `$socket.emit`, `$dataTracker` and — for the picture — `fetch` and
 * `RTCPeerConnection` stubbed, which is the whole of the surface either one
 * touches. That is honest for the same reason the exemption above is
 * honest: the assertion is on a call our own code makes, not on a mock
 * echoing what it was told to say. Mutation-testing is why the line moved
 * here: deleting `pointercancel`, and separately deleting `pointerleave`,
 * each once left this package's suite fully green. Neither can happen
 * unnoticed now.
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

  it("passes the gauge a sense, defaulting to higher-is-worse", () => {
    // Everything already drawn by this instrument — temperature, load, memory —
    // is higher-is-worse, so an omitted sense must keep behaving exactly as it
    // did before this property existed.
    expect(build(gaugeNode as (RED: RED) => void, { label: "CPU TEMP", max: 100, caution: 60, limit: 80 }).props!.sense)
      .toBe("higher-is-worse");
    expect(build(gaugeNode as (RED: RED) => void, {
      label: "SIGNAL", min: -120, max: -70, caution: -90, limit: -105, sense: "higher-is-better",
    }).props!.sense).toBe("higher-is-better");
  });

  it("refuses a sense it does not have, rather than drawing an arbitrary one", () => {
    // A typo in a flow must not silently pick a direction. Falling back to
    // the default is the safe answer only because the default is the common
    // case.
    expect(build(gaugeNode as (RED: RED) => void, { label: "X", max: 100, sense: "sideways" }).props!.sense)
      .toBe("higher-is-worse");
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

  /**
   * **A message drawn on the rail must not come back out of it.**
   *
   * The CHANGE PENDING banner's rails are fed by the same poll that draws the
   * countdown, because R-CFG-11 decides in `yonder-core` which keys a state
   * offers. Dashboard's default input handling ends in `send(msg)` unless the
   * widget's configuration carries `passthru: false` — and this rail's output
   * goes to the node that re-reads `/status` and feeds the rail. Without this
   * one poll would become an endless loop of them, at socket speed, on the
   * panel that exists to say a device is about to roll back.
   *
   * `false`, and *present*: Dashboard checks `hasProperty(config, 'passthru')`
   * before reading it, so an absent key means pass it on.
   */
  it("draws what it is sent without forwarding it, or the banner loops", () => {
    const { props } = build(softkeysNode as (RED: RED) => void, { keys: "[]" });
    expect(Object.prototype.hasOwnProperty.call(props!, "passthru")).toBe(true);
    expect(props!.passthru).toBe(false);
  });

  /** A press is a `widget-action` and does not go through that switch at all. */
  it("still sends a press with passthrough off", () => {
    const { events, props } = build(softkeysNode as (RED: RED) => void, { keys: "[]" });
    expect(props!.passthru).toBe(false);
    expect(events).toMatchObject({ onAction: true });
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

describe("the hold key", () => {
  it("registers as a widget that sends", () => {
    // Dashboard drops a widget-action from a widget that did not register
    // onAction — no error, no warning. Every soft key on this console once
    // shipped dead this way.
    const { type, events } = build(holdkeyNode as (RED: RED) => void, { label: "Full rate", action: "fullrate" });
    expect(type).toBe("ui-yonder-holdkey");
    expect(events).toMatchObject({ onAction: true });
  });

  it("carries the cost of holding it, so the page states it before it is asked", () => {
    // R-VID-11: the interface states what asking would cost *before* it is
    // asked. A held key with no cost on it is a key whose consequence is a
    // surprise.
    const { props } = build(holdkeyNode as (RED: RED) => void, { label: "Full rate", action: "fullrate", cost: "2.0 Mb/s" });
    expect(props).toMatchObject({ label: "Full rate", action: "fullrate", cost: "2.0 Mb/s" });
  });

  it("keeps a unit in the case it was given", () => {
    // Mb/s rendered as MB/S says megabytes. The component's stylesheet is
    // where that is enforced; this is the half that can be asserted.
    const { props } = build(holdkeyNode as (RED: RED) => void, { label: "Full rate", action: "fullrate", cost: "2.0 Mb/s" });
    expect(props!.cost).toBe("2.0 Mb/s");
  });

  it("does not draw itself when it has no dashboard group", () => {
    // A widget dragged onto a flow before it has a group is a normal
    // intermediate state in the editor, not a fault. Node-RED must load the
    // rest of the flow either way.
    const { node } = build(holdkeyNode as (RED: RED) => void, { label: "Full rate", action: "fullrate" }, null);
    expect(node.error).toHaveBeenCalled();
  });
});
describe("the picture", () => {
  it("registers as a widget that sends", () => {
    // It sends: the mode changes and 'try live again' are actions.
    const { type, events } = build(pictureNode as (RED: RED) => void, { path: "cam0" });
    expect(type).toBe("ui-yonder-picture");
    expect(events).toMatchObject({ onAction: true });
  });

  it("defaults to the cheap preview path, never the full-rate one", () => {
    // R-VID-13 makes the cheap copy the default. A component that defaulted
    // to the full stream would spend most of a field uplink the moment
    // somebody opened a page, with no reason to suspect it.
    expect(build(pictureNode as (RED: RED) => void, { path: "cam0" }).props)
      .toMatchObject({ path: "cam0-preview" });
  });

  it("does not append -preview twice", () => {
    expect(build(pictureNode as (RED: RED) => void, { path: "cam0-preview" }).props)
      .toMatchObject({ path: "cam0-preview" });
  });

  it("falls back to twelve seconds when the field is blank", () => {
    // Long enough for a slow negotiation to finish, short enough that nobody
    // is left staring at nothing. `num` treats an empty string as absent, not
    // as zero — a zero here would fall back to stills instantly.
    expect(build(pictureNode as (RED: RED) => void, { path: "cam0", stillsAfterMs: "" }).props)
      .toMatchObject({ stillsAfterMs: 12_000 });
  });

  it("carries the stills source, so the fall-back has somewhere to point", () => {
    // R-VID-14's fall-back is only useful if it can draw something. Nothing
    // in this repository serves stills yet, so this is configuration rather
    // than a discovered URL, and an unset one leaves the fall-back drawing
    // its reason and no picture.
    expect(build(pictureNode as (RED: RED) => void, { path: "cam0", stillsUrl: "/stills/cam0.jpg" }).props)
      .toMatchObject({ stillsUrl: "/stills/cam0.jpg" });
    expect(build(pictureNode as (RED: RED) => void, { path: "cam0" }).props)
      .toMatchObject({ stillsUrl: "" });
  });
});

describe("the facts row and the budget", () => {
  it("registers both without onAction, because both are read-only", () => {
    // A facts row that could emit is a facts row that could originate a
    // command. Read-only instruments leave it off, as every other one does.
    expect(build(factsNode as (RED: RED) => void, { facts: "[]" }).events).toEqual({});
    expect(build(budgetNode as (RED: RED) => void, { segments: "[]" }).events).toEqual({});
  });

  it("draws nothing, and says so, when the facts list is malformed", () => {
    // A widget that cannot render its own configuration must not stop the
    // console starting — a console that will not start is a device the
    // operator cannot reach. `list()` already has this behaviour; this is the
    // assertion that these two widgets use it rather than JSON.parse.
    const { node, props } = build(factsNode as (RED: RED) => void, { facts: "{not json" });
    expect(node.error).toHaveBeenCalledTimes(1);
    expect(props).toMatchObject({ facts: [] });
  });

  it("reads a facts list from the editor form", () => {
    const facts = JSON.stringify([
      { label: "aim", state: "not-offered" },
      { label: "zoom", state: "advertised", reason: "accepted, does not reshape the feed" },
    ]);
    const { props } = build(factsNode as (RED: RED) => void, { title: "This camera has no", facts });
    expect(props!.facts).toHaveLength(2);
    expect((props!.facts as { state: string }[])[1].state).toBe("advertised");
  });

  it("takes the uplink capacity as the mark the segments are drawn against", () => {
    const { props } = build(budgetNode as (RED: RED) => void, { label: "Uplink", capacityKbps: "5000", segments: "[]" });
    expect(props).toMatchObject({ capacityKbps: 5000 });
  });

  it("has no capacity rather than a false one when the field is blank", () => {
    // Zero is the honest answer: nothing has measured this path yet, and a
    // made-up ceiling is a mark an operator would trust.
    expect(build(budgetNode as (RED: RED) => void, { segments: "[]" }).props).toMatchObject({ capacityKbps: 0 });
  });
});

describe("the deck", () => {
  /**
   * `emitsActions` is load-bearing (`widget.ts`'s own note): Dashboard drops
   * a `widget-action` from a widget that never registered `onAction` —
   * silently, with no error anywhere. Every image control, Apply, Discard,
   * output toggle and shutter press on this page depends on it, so a
   * mutation to `false` here must turn this test red — confirmed directly
   * as part of task-22's own mutation check (task-22-report.md).
   */
  it("registers as a widget that sends", () => {
    const { type, events } = build(deckNode as (RED: RED) => void, {});
    expect(type).toBe("ui-yonder-deck");
    expect(events).toMatchObject({ onAction: true });
  });

  it("reads the editor's own page — live or setup — never from a message", () => {
    expect(build(deckNode as (RED: RED) => void, { mode: "setup" }).props).toMatchObject({ mode: "setup" });
    expect(build(deckNode as (RED: RED) => void, { mode: "live" }).props).toMatchObject({ mode: "live" });
  });

  it("falls back to Live for anything else, rather than an unrecognised page", () => {
    expect(build(deckNode as (RED: RED) => void, {}).props).toMatchObject({ mode: "live" });
    expect(build(deckNode as (RED: RED) => void, { mode: "nonsense" }).props).toMatchObject({ mode: "live" });
  });
});

describe("the aim panel", () => {
  /**
   * `emitsActions` is load-bearing here exactly as it is for the deck
   * (`widget.ts`'s own note): Dashboard drops a `widget-action` from a
   * widget that never registered `onAction` — silently, with no error
   * anywhere. A press on the pad, the mode control or Recentre all depend
   * on it.
   *
   * **This is the test `aim.component.test.ts` cannot write, by
   * construction** (task-23-brief.md, coordinator resolution 4, confirmed
   * by task-22's own review): a component test mounts `YonderAim.vue`
   * directly against a mocked `$socket` and never touches `aim.ts`'s own
   * registration at all, so a mutation to `emitsActions` there is
   * invisible to it. This one imports the real registration module and
   * asserts what it actually passes to `group.register`.
   *
   * Confirmed directly, not merely asserted here (see task-23-report.md):
   * flipping `emitsActions: true` to `false` in `aim.ts` turns exactly
   * this test red and nothing else in this package's suite.
   */
  it("registers as a widget that sends", () => {
    const { type, events } = build(aimNode as (RED: RED) => void, {});
    expect(type).toBe("ui-yonder-aim");
    expect(events).toMatchObject({ onAction: true });
  });

  it("does not draw itself when it has no dashboard group", () => {
    // A widget dragged onto a flow before it has a group is a normal
    // intermediate state in the editor, not a fault — Node-RED must load
    // the rest of the flow either way.
    const { node } = build(aimNode as (RED: RED) => void, {}, null);
    expect(node.error).toHaveBeenCalledWith(expect.stringContaining("no dashboard group"));
  });
});
