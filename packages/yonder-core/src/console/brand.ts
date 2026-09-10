// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The approved airframe and split-Y identity (R-UI-01, R-UI-08, R-UI-13).
 * Shared by the standalone login, the generated header, and the SVG exports.
 * All lettering is drawn here: no font, image file, or network request.
 */
export interface BrandOptions {
  theme?: "day" | "night";
  treatment?: "solid" | "material" | "outline";
  markOnly?: boolean;
  decorative?: boolean;
  width?: number;
}

const WINGS = "M16 164 188 75 170 162 0 204Z M264 75 436 164 452 204 282 162Z";
const FUSELAGE = "M226 0 251 45 278 175 233 264V117L226 103 219 117V264L174 175 201 45Z";
const Y_ARM = "M0 0H44L93 52 70 78Z";
const Y_BODY = "M155 0H196L121 88V154H81V88Z";

const LETTERS = [
  // o: the same soft, squared counters used throughout the wordmark.
  "M194 48H282Q308 48 308 74V128Q308 154 282 154H194Q168 154 168 128V74Q168 48 194 48Z "
    + "M210 75Q202 75 202 83V119Q202 127 210 127H266Q274 127 274 119V83Q274 75 266 75Z",
  // n
  "M323 154V48H414Q453 48 453 86V154H419V90Q419 76 405 76H357V154Z",
  // d
  "M571 0H605V154H504Q466 154 466 116V86Q466 48 504 48H571Z "
    + "M510 75Q500 75 500 85V117Q500 127 510 127H571V75Z",
  // e
  "M651 48H720Q754 48 754 82V114H650V120Q650 130 661 130H746V154H651Q616 154 616 119V83Q616 48 651 48Z "
    + "M650 90H720V83Q720 73 710 73H660Q650 73 650 83Z",
  // r
  "M767 154V86Q767 48 805 48H853V76H816Q801 76 801 91V154Z",
];

/** A self-contained SVG. Width changes presentation, never the path geometry. */
export function brandSvg(options: BrandOptions = {}): string {
  const { theme = "day", treatment = "solid", markOnly = false, decorative = false } = options;
  const width = options.width ?? (markOnly ? 92 : 312);
  const viewWidth = markOnly ? 468 : 1325;
  const height = Number((width * 280 / viewWidth).toFixed(3));
  const blue = theme === "day" ? "#2c5f8f" : "#6badd4";
  const ink = theme === "day" ? "#1b1811" : "#e8ecf0";
  const material = treatment === "material";
  const prefix = `yonder-brand-${theme}`;
  const blueFill = material ? `url(#${prefix}-blue)` : blue;
  const inkFill = material ? `url(#${prefix}-ink)` : ink;
  const accessible = decorative ? 'aria-hidden="true"' : 'role="img" aria-label="Yonder"';
  const finish = material ? ' stroke="#ffffff" stroke-opacity=".22" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke fill"' : "";
  const definitions = material ? `<defs>
    <filter id="${prefix}-shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="3" stdDeviation="2" flood-color="#000000" flood-opacity=".24"/>
    </filter>
    <linearGradient id="${prefix}-blue" x1="0" y1="0" x2=".2" y2="1">
      <stop stop-color="${theme === "day" ? "#5e9bc3" : "#93c6e3"}"/>
      <stop offset=".5" stop-color="${blue}"/>
      <stop offset="1" stop-color="${theme === "day" ? "#234c70" : "#5086ad"}"/>
    </linearGradient>
    <linearGradient id="${prefix}-ink" x1="0" y1="0" x2=".15" y2="1">
      <stop stop-color="${theme === "day" ? "#555c62" : "#ffffff"}"/>
      <stop offset=".5" stop-color="${theme === "day" ? "#292e33" : "#c7d2dd"}"/>
      <stop offset="1" stop-color="${theme === "day" ? "#3d444a" : "#e8ecf0"}"/>
    </linearGradient>
  </defs>` : "";
  const emblem = treatment === "outline"
    ? `<g fill="none" stroke="${blue}" stroke-width="5" stroke-linejoin="miter"><path d="${WINGS}"/><path d="${FUSELAGE}"/></g>`
    : `<g${finish}><path fill="${blueFill}" d="${WINGS}"/><path fill="${inkFill}" d="${FUSELAGE}"/></g>`;
  const wordmark = markOnly ? "" : `<g transform="translate(456 63)"${finish}>
    <path fill="${blueFill}" d="${Y_ARM}"/>
    <g fill="${inkFill}" fill-rule="evenodd"><path d="${Y_BODY}"/>${LETTERS.map((path) => `<path d="${path}"/>`).join("")}</g>
  </g>`;
  const artwork = material ? `<g filter="url(#${prefix}-shadow)">${emblem}${wordmark}</g>` : `${emblem}${wordmark}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="-8 -8 ${viewWidth} 280" ${accessible} focusable="false">${definitions}${artwork}</svg>`;
}

/** The header carries its SVG inside the stylesheet, with no asset request. */
export function brandDataUri(theme: "day" | "night", width = 150): string {
  return `data:image/svg+xml;base64,${Buffer.from(brandSvg({ theme, treatment: "material", width })).toString("base64")}`;
}
