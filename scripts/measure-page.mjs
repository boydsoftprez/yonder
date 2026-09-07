// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the capture gate measures **inside** the page (R-UI-12, R-UI-23).
//
// Its own module for one reason: it is the half of the gate that holds rules,
// and `capture-pages.mjs` cannot be imported — it parses argv and exits at
// load time — so nothing could test these rules without a running console and
// a page that happened to have the defect on it. `measure-page.test.mjs`
// drives both functions against a synthetic DOM instead, which is how the
// overlay exemption's false negative was found and is what keeps it found.
//
// Both are serialised into the browser by Playwright's `evaluate`, so neither
// may close over anything: every input arrives in the array argument and the
// only free names are browser globals.

/**
 * Everything measured inside the page.
 *
 * Runs in the browser, so it can only use what is on the page. Returns plain
 * data; every judgement about it is made out here where it can be read.
 */
export function measure([liveSelectors, fixedSelector, specimenValues, maskedKeys, aboveTheFold, deckSelector]) {
  const round = (n) => Math.round(n);
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
  };

  /**
   * A key that survives a reorder of unrelated widgets. The element's own
   * classes plus its position among its siblings — not an index into a flat
   * list, which would renumber everything below an insertion and report five
   * changes where there was one.
   */
  const keyOf = (el) => {
    const cls = [...el.classList]
      .filter((c) => !/^(v-|mdi-)/.test(c) && !c.includes("theme--"))
      .sort()
      .join(".");
    const siblings = [...(el.parentElement?.children ?? [])].filter(
      (s) => s.className === el.className,
    );
    const nth = siblings.indexOf(el);
    return cls + (siblings.length > 1 ? `#${nth}` : "");
  };

  const widgets = [...document.querySelectorAll('[class*="nrdb-ui-widget"], [class*="nrdb-ui-group"]')];

  /**
   * Every reading, rendered at its widest honest value (R-UI-23).
   *
   * **First, before anything is measured**, because every check below this
   * line is about what the page does with what is on it — and what is on it
   * during a capture is whatever the daemon last said, which is never the
   * longest thing the field can hold. Measuring the easy case and committing
   * a picture of it is how a readout row ships truncating.
   *
   * A field is named by the instrument it is drawn in and the caption beside
   * it — `nrdb-ui-yonder-databar · UPLINK` — rather than by a DOM path or a
   * node id, because that is the name a person reviewing
   * `scripts/fixtures/specimens.json` can check against the page. Rename the
   * caption and the specimen goes missing, loudly, which is the right failure:
   * the widest honest value for `UPLINK` is not automatically the widest
   * honest value for whatever it was renamed to.
   *
   * A field with no specimen is *marked* with `data-yonder-mask` rather than
   * returned, because the caller needs a Playwright locator and this needs an
   * ancestor test — "not inside a widget that declared itself fixed" — which
   * CSS has no combinator for and `element.closest` does in one call. One
   * decision about what is hidden, made once, applied by one mechanism.
   */
  const words = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const captionOf = (el) => {
    const cell = el.closest(".y-bar__cell");
    if (cell !== null) return words(cell.querySelector(".y-bar__k"));
    const row = el.closest(".y-ro__row");
    if (row !== null) return words(row.querySelector(".y-ro__l"));
    const gauge = el.closest(".y-gauge");
    if (gauge !== null) return words(gauge.querySelector(".y-gauge__label"));
    // A facts row draws two readings and its label is the *capability*, not
    // the field: `Zoom` and `Aim` take their words from the same two
    // vocabularies, so one specimen is owed per vocabulary and not per row.
    // Keyed by which of the two it is, because a widget that draws two
    // readings with no caption between them would otherwise give both the
    // same name and one specimen would silently serve the other.
    if (el.closest(".y-facts__row") !== null) {
      return el.classList.contains("y-facts__reason") ? "reason" : "state";
    }
    if (el.classList.contains("y-spark__ceiling")) return "ceiling";
    if (el.classList.contains("y-spark__span")) return "span";
    // A table cell's field is its column, not the cell: every row of one
    // column holds the same kind of value, so one specimen is what a column
    // is owed and the widest of them is what the column has to fit.
    const td = el.closest("td");
    if (td !== null) {
      const columns = [...(td.parentElement?.children ?? [])];
      const heads = td.closest("table")?.querySelectorAll("thead th") ?? [];
      return words(heads[columns.indexOf(td)]);
    }
    return words(el.closest('[class*="nrdb-ui-widget"]')?.querySelector(".nrdb-ui-text-label"));
  };
  const kindOf = (el) => {
    const widget = el.closest('[class*="nrdb-ui-widget"]');
    if (widget === null) return [...el.classList].sort().join(".");
    return [...widget.classList]
      .filter((c) => (c.startsWith("nrdb-ui-") && c !== "nrdb-ui-widget") || c.startsWith("yonder-"))
      .sort()
      .join(".");
  };
  const fieldKey = (el) => {
    const caption = captionOf(el);
    return caption === "" ? kindOf(el) : `${kindOf(el)} · ${caption}`;
  };

  /**
   * Writes the specimen without deleting the instrument around it.
   *
   * A gauge draws its unit as an element inside the value — `19` and a `<i>dB`
   * — so `textContent = value` would delete the unit and photograph a reading
   * that no page can produce. Only the element's own text is replaced.
   */
  const write = (el, value) => {
    const texts = [...el.childNodes].filter((n) => n.nodeType === 3);
    if (texts.length === 0) { el.textContent = value; return; }
    texts[0].textContent = value;
    for (const spare of texts.slice(1)) spare.textContent = "";
  };

  const live = new Set();
  const readings = [];
  const done = new Set();
  for (const sel of liveSelectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest(fixedSelector)) continue;
      if (done.has(el)) continue;
      done.add(el);
      const key = fieldKey(el);
      if (Object.prototype.hasOwnProperty.call(specimenValues, key)) {
        write(el, specimenValues[key]);
        readings.push({ key, state: "rendered" });
        continue;
      }
      live.add(el);
      el.setAttribute("data-yonder-mask", "");
      readings.push({
        key,
        state: maskedKeys.includes(key) ? "masked" : "unspecified",
        was: words(el).slice(0, 60),
      });
    }
  }

  /**
   * Content that does not fit its box, either way it fails.
   *
   * A scrollable box hides the excess — that is K-13, 39% of a safety warning
   * behind an inner scrollbar nothing indicated was there. A box that does
   * *not* scroll lets the excess escape instead, and the next widget is
   * painted over the top of it. Same cause, opposite symptom, and this check
   * only looked for the first one until an operator spotted the second: a
   * dropdown 48px tall with 70px of content, its message under the password
   * field that follows it.
   */
  const clipped = [];
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    const scrolls = /auto|scroll|hidden/.test(style.overflowY);
    const isWidget = /nrdb-ui-widget/.test(el.className || "");
    // A scroller hides its overflow; a widget that does not scroll spills it
    // onto whatever is drawn next. Both are content that does not fit.
    if (!scrolls && !isWidget) continue;
    if (el.scrollHeight <= el.clientHeight + 2) continue;
    if (el.clientHeight === 0) continue;
    // The page's own scroller. A console taller than the window is a page you
    // scroll, not content that is hidden — the defect is a box *inside* the
    // page clipping what it holds.
    if (el === document.documentElement || el === document.body) continue;
    if (el.clientHeight >= window.innerHeight - 4) continue;
    // A table body scrolling is a table doing its job. Prose is not.
    if (el.closest(".v-data-table__wrapper, .v-table__wrapper")) continue;
    // A geographic viewport deliberately crops positioned map objects. Its
    // controls are still measured individually; prose has no such exemption.
    if (el.classList.contains("leaflet-container")) continue;
    clipped.push({
      key: keyOf(el),
      how: scrolls ? "hides" : "spills over what follows it",
      visible: el.clientHeight,
      content: el.scrollHeight,
      hidden: Math.round((1 - el.clientHeight / el.scrollHeight) * 100),
      text: (el.textContent ?? "").trim().slice(0, 80),
    });
  }

  /**
   * Text wider than the box it is in (R-UI-23).
   *
   * The check above is the same question asked vertically, and it could not
   * see this one at all: a value that does not fit *sideways* leaves
   * `scrollHeight` exactly equal to `clientHeight` and every rule on this page
   * passing. It is the defect spec §10 lists second — a readout row truncating
   * — and it is invisible in a capture taken with the short value on the page,
   * which is why the specimens above come first.
   *
   * Both outcomes fail. A box with `overflow: hidden` cuts the value off,
   * with or without an ellipsis to admit it; a box without one lets the value
   * escape over whatever is drawn beside it. A number an operator reads half
   * of is worse than either, because half a number still looks like a number.
   */
  const truncated = [];
  for (const el of document.querySelectorAll("*")) {
    if (el instanceof SVGTextContentElement) {
      // SVG labels have no CSS content box. clientWidth/scrollWidth can be
      // in different coordinate spaces after viewBox scaling and rotation.
      // Compare painted bounds against the actual SVG viewport instead.
      // A clipPath is a deliberate graphics viewport (e.g. moving tape ticks).
      const svg = el.ownerSVGElement;
      if (!svg || el.closest("[clip-path]")) continue;
      const text = el.getBoundingClientRect(), viewport = svg.getBoundingClientRect();
      if (text.width <= 0 || text.height <= 0 || !/hidden|clip|auto|scroll/.test(getComputedStyle(svg).overflowX)) continue;
      const visible = Math.max(0, Math.min(text.right, viewport.right) - Math.max(text.left, viewport.left));
      if (text.width > visible + 2) truncated.push({
        key: keyOf(el) || `svg.${el.tagName.toLowerCase()}`,
        how: "cuts off", visible: round(visible), content: round(text.width),
        hidden: Math.round((1 - visible / text.width) * 100), text: words(el).slice(0, 80),
      });
      continue;
    }
    // The page's own sideways scroll is a page-level finding, reported once
    // from `scrollWidth` below rather than once per element on the way down.
    if (el === document.documentElement || el === document.body) continue;
    if (el.clientWidth === 0) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    // A table wider than its own scroller is a table doing its job. **Only
    // the wrapper itself is skipped**, not what is inside it: a cell that
    // cuts off its own text is the defect this check is for, and excluding
    // the whole subtree — which is what the vertical check does — would hide
    // exactly the case a log message or a rejection reason produces.
    if (el.classList.contains("v-table__wrapper")) continue;
    if (el.classList.contains("v-data-table__wrapper")) continue;
    if (el.classList.contains("leaflet-container")) continue;
    // **Text**, which is what the rule is about. A track, a rail or a band is
    // drawn to a width and a pixel of rounding against its border is not a
    // reading anybody is missing: `y-budget__track` reported 420px of nothing
    // in 418px, which is 0% hidden and 100% noise.
    if (words(el) === "") continue;
    // An identity is a value to **copy**, not to read, and `YonderIdentity`
    // gives it a copy control for exactly that reason: a GStreamer receive
    // line is 2169px of text and no box on any console holds it. R-UI-25
    // forbids an ellipsis on a *reading*, where shortening the value loses
    // the answer; here the whole value is one press away and the ellipsis is
    // the component saying so. Nothing else is exempt: this is one class,
    // named, not a rule that any page can opt out of by adding an ellipsis.
    if (el.classList.contains("y-id__v")) continue;
    // The innermost box only. An ancestor of an overflowing box reports the
    // same overflow one level out, and three lines about one defect is a gate
    // people learn to skim.
    if ([...el.children].some((c) => c.clientWidth > 0 && c.scrollWidth > c.clientWidth + 1)) continue;
    // **An overlay is not content that does not fit**, so `scrollWidth` alone
    // is the trigger and not the finding. A Vuetify slider thumb is a 20px
    // circle whose ripple is a 40px absolutely positioned child and whose
    // surface carries an absolutely positioned pseudo-element: `scrollWidth`
    // counts both, and the gate reported 35% of a slider hidden, twice a
    // page. Where a *placed* box sits relative to its parent's edge is the
    // author's arrangement.
    //
    // **Asked positively, of what is in flow.** Two earlier shapes of this
    // test were wrong in opposite directions. "Is every element child that
    // spills a placed one" ignored the element's own text, so a readout with
    // a badge beside it was exempt from this rule entirely — including for
    // text of its own that was cut off. "Does it still overflow with the
    // placed children hidden" cannot see a pseudo-element, which is not a
    // child and cannot be hidden from here; measured against the real slider,
    // it answered 31px of 20px with both children gone.
    //
    // So this measures what a person would call the content: the element's
    // own text, laid out, and the in-flow children beside it. A range over a
    // text node reports its unclipped boxes, which is what makes an ellipsis
    // and a hard clip both visible. `measure-page.test.mjs` holds both
    // directions of it.
    {
      const box = el.getBoundingClientRect();
      const edge = box.left + (parseFloat(getComputedStyle(el).borderLeftWidth) || 0) + el.clientWidth;
      let inFlow = false;
      for (const node of el.childNodes) {
        if (node.nodeType === 3) {
          if (node.textContent.trim() === "") continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.right > edge + 1) { inFlow = true; break; }
          }
        } else if (node.nodeType === 1) {
          if (/absolute|fixed/.test(getComputedStyle(node).position)) continue;
          if (node.getBoundingClientRect().right > edge + 1) inFlow = true;
        }
        if (inFlow) break;
      }
      if (!inFlow) continue;
    }
    const style = getComputedStyle(el);
    truncated.push({
      // `keyOf` drops framework classes, which leaves nothing at all for a
      // Vuetify element — the same hole `unreadable` below had, and the same
      // fix: a finding with an empty key cannot be told from another finding
      // with an empty key, by a reader or by the debt list.
      key: keyOf(el) || `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => /^v-/.test(c)).slice(0, 2).join(".")}`,
      how: /hidden|clip|auto|scroll/.test(style.overflowX) ? "cuts off" : "spills past",
      visible: el.clientWidth,
      content: el.scrollWidth,
      hidden: Math.round((1 - el.clientWidth / el.scrollWidth) * 100),
      text: words(el).slice(0, 80),
    });
  }

  /**
   * The viewport contract, spec §5 (R-UI-23, R-UI-12).
   *
   * Measured on every run and reported only under `--fold`, so the numbers
   * cost nothing and the claim is made exactly where a run was taken at a
   * width the contract is written for.
   *
   * The rail is measured by the caller, at the bottom of the page, because
   * "still reachable while the deck scrolls" is a statement about a scrolled
   * page and this function runs on an unscrolled one.
   */
  const parts = aboveTheFold.map(([name, sel]) => {
    const el = document.querySelector(sel);
    if (el === null) return { name, sel, present: false };
    const r = el.getBoundingClientRect();
    return {
      name,
      sel,
      present: true,
      inside: r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
      box: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
    };
  });

  /**
   * A scrollbar inside the deck.
   *
   * One vertical page scroll is the contract; a deck that scrolls inside a
   * page that also scrolls is two scrollbars for one list of controls, and
   * the inner one is the one nobody finds. This is K-13 again, in the place
   * spec §5 says it must not happen.
   */
  const nested = [];
  const decks = document.querySelectorAll(deckSelector);
  for (const deck of decks) {
    for (const el of [deck, ...deck.querySelectorAll("*")]) {
      const style = getComputedStyle(el);
      const scrollsDown = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
      const scrollsAcross = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2;
      if (!scrollsDown && !scrollsAcross) continue;
      if (el.clientHeight === 0 || el.clientWidth === 0) continue;
      nested.push({
        key: keyOf(el) || `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => /^v-/.test(c)).slice(0, 2).join(".")}`,
        across: scrollsAcross,
      });
    }
  }

  /**
   * An action spanning the surface it sits on. R-UI-10, checked in the DOM
   * rather than over the flows, because a widget width of "auto" that CSS
   * then stretches is exactly the case a JSON check cannot see.
   */
  const spanning = [];
  for (const el of document.querySelectorAll("button, .nrdb-ui-button .v-btn")) {
    const parent = el.parentElement;
    if (!parent) continue;
    const own = el.getBoundingClientRect().width;
    const around = parent.getBoundingClientRect().width;
    if (around < 8 || own / around < 0.9) continue;
    if (own < 240) continue; // a narrow column is allowed to be filled
    spanning.push({
      key: keyOf(el),
      label: (el.textContent ?? "").trim().slice(0, 40),
      width: Math.round(own),
      of: Math.round(around),
    });
  }

  /**
   * Text on a control that cannot be read against what is behind it (R-UI-16).
   *
   * This is the check the picture could not make. An operator reported that
   * in the night palette the text in the entry fields was "not able to be
   * read by human eyes"; every unit test passed, the shape reference was
   * unchanged, and the committed capture showed the words — at 1.05:1 against
   * their own recess, which is a picture of the defect that looks like a
   * picture of an empty field.
   *
   * **Computed colours, not pixels.** Each control's own colour is composited
   * over everything painted behind it, with the alpha and the accumulated
   * `opacity` of its ancestors folded in — because what made those labels
   * unreadable was Vuetify drawing black at 60% opacity, and a rule that read
   * `color` alone would have called that black and passed it in the day
   * palette for the same reason it failed in night.
   *
   * **Controls only.** The threshold is WCAG AA for body text, and the
   * console's own controls clear it in both palettes with room: the tightest
   * measured is 4.63:1 (a day label on a day recess) and most are 5.5–12.8:1.
   * Instrument faces, annunciator lamps and gauge bands are deliberately
   * coloured against their own backgrounds and are a different question; this
   * one is about the text that says what to type and the text that was typed.
   */
  const rgba = (s) => {
    const n = (s.match(/-?[\d.]+/g) ?? []).map(Number);
    return n.length >= 3 ? { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 } : null;
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = (c) => {
    const f = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  // Everything painted behind this element, composited bottom-up. The page
  // itself is the floor: a transparent stack over a transparent body is still
  // read against something, and white is the browser's own answer.
  const behind = (el) => {
    const stack = [];
    for (let a = el; a !== null; a = a.parentElement) {
      const c = rgba(getComputedStyle(a).backgroundColor);
      if (c !== null && c.a > 0) stack.push(c);
    }
    let ground = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) ground = over(stack[i], ground);
    return ground;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let a = el; a !== null; a = a.parentElement) o *= Number(getComputedStyle(a).opacity || 1);
    return o;
  };

  const unreadable = [];
  const CONTROL_TEXT = [
    ".nrdb-ui-widget input", ".nrdb-ui-widget textarea", ".nrdb-ui-widget .v-label",
    ".nrdb-ui-widget label", ".nrdb-ui-widget .v-field__input",
    ".nrdb-ui-widget .v-select__selection-text", ".nrdb-ui-widget .v-messages__message",
    // The table's own search box is not inside a widget wrapper of its own,
    // and it is a field an operator types into. It measured 1.03:1.
    ".nrdb-ui-table-wrapper input", ".nrdb-ui-table-wrapper .v-label",
  ].join(",");
  for (const el of document.querySelectorAll(CONTROL_TEXT)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    const fill = style.webkitTextFillColor;
    const own = rgba(fill && fill !== "currentcolor" ? fill : style.color);
    if (own === null) continue;
    const ground = behind(el);
    const shown = over({ ...own, a: own.a * opacityOf(el) }, ground);
    const ratio = contrast(shown, ground);
    if (ratio >= 4.5) continue;
    unreadable.push({
      // `keyOf` drops framework classes, which is right for a widget and
      // leaves nothing at all for a Vuetify label — every class it has is a
      // `v-` one. So the framework's own two are kept here, because a finding
      // with an empty key cannot be told from another finding with an empty
      // key, either by a reader or by the debt list.
      key: keyOf(el) || `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => /^v-/.test(c)).slice(0, 2).join(".")}`,
      text: (el.tagName === "INPUT" ? (el.value || el.placeholder || "") : (el.textContent ?? "")).trim().slice(0, 40),
      color: style.color,
      opacity: Number(opacityOf(el).toFixed(2)),
      on: `rgb(${Math.round(ground.r)},${Math.round(ground.g)},${Math.round(ground.b)})`,
      ratio: Number(ratio.toFixed(2)),
    });
  }

  /**
   * The words on anything that has declared itself fixed.
   *
   * Geometry alone could not tell four of these states apart. The `Way out`
   * rows differ by a sentence and a lamp caption; an annunciator is
   * `inline-flex` inside a grid-fixed wrapper and the qualifier wraps to one
   * line in every state, so *no box moves* — and the four state references
   * came out byte-identical to their bases, asserting nothing the base did
   * not already assert. Same for `status-psk-changed`, whose whole subject is
   * one cell's text.
   *
   * `yonder-fixed` is the one declaration on this console that a value is the
   * same on every run, which is exactly the licence needed to freeze its
   * text. Nothing else's text is recorded: a load average in a reference
   * would leave it dirty for ever, which is what the masking exists to
   * prevent.
   */
  const fixed = [...document.querySelectorAll(fixedSelector)].map((el) => ({
    key: keyOf(el),
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  })).filter((f) => f.text !== "");

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    widgets: widgets.map((el) => ({ key: keyOf(el), box: boxOf(el) })),
    liveBoxes: [...live].map(boxOf).filter((b) => b.w > 0 && b.h > 0),
    fixed,
    clipped,
    truncated,
    spanning,
    unreadable,
    readings,
    // `decks` travels with `nested` because an empty `nested` means one of two
    // opposite things — no scroller, or no deck — and the caller has to be
    // able to tell them apart. See the `ABOVE_THE_FOLD` comment.
    fold: { parts, nested, decks: decks.length },
  };
}

/**
 * Where the rail is once the page is at the bottom of its scroll.
 *
 * Its own pass, because it is the one measurement in the contract that is
 * about a *scrolled* page: "the rail remains reachable while the deck
 * scrolls" (spec §5) is not a claim any measurement of an unscrolled page can
 * make, and a rail at the foot of a short page satisfies it by accident.
 */
export function railAtBottom([railSelector]) {
  const el = document.querySelector(railSelector);
  if (el === null) return { present: false };
  const r = el.getBoundingClientRect();
  const round = (n) => Math.round(n);
  return {
    present: true,
    inside: r.top >= -1 && r.bottom <= window.innerHeight + 1,
    box: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}
