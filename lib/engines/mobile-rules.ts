// ============================================================
// KPMG TrustLens — Mobile Deterministic Rules
// Measures what can be measured from a screenshot instead of
// asking the AI to guess: text contrast from real pixels, touch
// target size in dp, CTA asymmetry, and price consistency across
// the journey. Also renders annotated evidence crops.
// Input: the per-screen UI inventory extracted by vision AI
// (element boxes in [ymin, xmin, ymax, xmax], 0–1000 scale).
// ============================================================

import {
  ASTERISK_PROMO_PATTERNS,
  AUTO_RENEWAL_PATTERNS,
  CONFIRMSHAMING_PATTERNS,
  CRORE_TRUST_PATTERNS,
  DRIP_PRICING_PATTERNS,
  FAMILY_GUILT_PATTERNS,
  SOCIAL_PRESSURE_PATTERNS,
  SUBSCRIPTION_TRAP_PATTERNS,
  URGENCY_PATTERNS,
} from "./darkpattern-rules";

export type Box = [number, number, number, number];

export type ElementType =
  | "text"
  | "button"
  | "link"
  | "checkbox"
  | "toggle"
  | "input"
  | "icon"
  | "image";

export type ElementRole =
  | "primary-cta"
  | "accept"
  | "decline"
  | "close"
  | "skip"
  | "addon"
  | "consent"
  | "price"
  | "fine-print"
  | "permission-prompt"
  | "permission-rationale"
  | "privacy-link"
  | "logo"
  | "rating-star"
  | "rating-prompt"
  | "promo-banner"
  | "sponsored-label"
  | "fixed-bar"
  | "other";

export interface UIElement {
  id: string;
  type: ElementType;
  role?: ElementRole;
  text?: string;
  /** Tight box around the visible text or icon glyph */
  box: Box;
  /** Whole tappable region (chip, tile, card, row) when interactive */
  tapBox?: Box;
  /** Reusable UI component this element belongs to, e.g. "bottom tab bar" */
  component?: string;
  /** Inactive/disabled controls are exempt from WCAG 1.4.3 */
  disabled?: boolean;
  /** Text that is part of a photo, illustration or logo (exempt from 1.4.3) */
  inImage?: boolean;
  /** Partly covered by a fixed bar, sheet, scrim or overlay */
  occluded?: boolean;
  /** Floats above the content (sticky tab bar, banner, modal) */
  overlay?: boolean;
  checked?: boolean;
  bold?: boolean;
  lines?: number;
}

/** Advisory (non-violation) observations, e.g. AAA / platform guidance */
export interface Advisory {
  ruleId: string;
  title: string;
  component: string;
  screens: number[];
  elements: string[];
  detail: string;
}

export type AmountRole =
  | "line-item"
  | "fee"
  | "addon"
  | "discount"
  | "total"
  | "pay-button"
  | "price"
  | "reference"
  | "renewal";

export interface Amount {
  label: string;
  value: number;
  currency?: string;
  role: AmountRole;
  elementId?: string;
}

export interface ScreenInventory {
  elements: UIElement[];
  amounts: Amount[];
}

export interface DecodedImage {
  data: Buffer; // RGBA
  width: number;
  height: number;
}

export interface MeasuredFinding {
  pillar: "accessibility" | "darkpatterns" | "privacy";
  ruleId: string; // DP-* rule, WCAG criterion, or MOB-PRIV-*
  wcag?: string;
  wcagLevel?: "A" | "AA" | "AAA";
  category?: string;
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  screens: number[]; // 0-based
  elementId?: string;
  box?: Box;
  measurements: Record<string, string | number>;
  /** Component used to group repeated issues into one root cause */
  component?: string;
  elementText?: string;
  recommendation: string;
  developerFix?: string;
  designerFix?: string;
}

// ── Image decoding (sharp ships with Next.js; degrade gracefully if absent) ──
type SharpFn = typeof import("sharp");
let sharpPromise: Promise<SharpFn | null> | null = null;
async function getSharp(): Promise<SharpFn | null> {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((m) => (m.default ?? m) as unknown as SharpFn)
      .catch(() => null);
  }
  return sharpPromise;
}

export async function isMeasurementAvailable(): Promise<boolean> {
  return (await getSharp()) !== null;
}

export async function decodeImage(base64: string): Promise<DecodedImage | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(Buffer.from(base64, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

// ── Colour maths (WCAG 2.x relative luminance) ──
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = (r: number, g: number, b: number) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const contrastRatio = (
  a: [number, number, number],
  b: [number, number, number],
) => {
  const l1 = luminance(...a);
  const l2 = luminance(...b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const hex = (c: [number, number, number]) =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function boxToPx(box: Box, img: { width: number; height: number }, pad = 0) {
  const [ymin, xmin, ymax, xmax] = box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  const left = Math.max(0, Math.floor(((xmin - w * pad) / 1000) * img.width));
  const top = Math.max(0, Math.floor(((ymin - h * pad) / 1000) * img.height));
  const right = Math.min(img.width, Math.ceil(((xmax + w * pad) / 1000) * img.width));
  const bottom = Math.min(img.height, Math.ceil(((ymax + h * pad) / 1000) * img.height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export type ContrastMeasurement =
  | { ok: true; ratio: number; fg: string; bg: string; inkShare: number }
  | { ok: false; reason: "too-small" | "busy-background" | "no-text-pixels" };

const px = (img: DecodedImage, x: number, y: number): [number, number, number] => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/**
 * Measures text-vs-background contrast for a text box drawn tightly
 * around the glyphs.
 * - Background: dominant colour of a thin ring just outside the text box
 *   (the surface the text actually sits on — chip, card or page).
 * - Foreground: core glyph colour = median of the strongest-contrast 30%
 *   of "ink" pixels inside the box (ignores anti-aliased edges and
 *   JPEG noise, which made thin dark text read as a faint colour).
 * - Text over photos/gradients (no dominant ring colour) is reported as
 *   unmeasurable rather than guessed.
 */
export function measureContrast(img: DecodedImage, box: Box): ContrastMeasurement {
  const inner = boxToPx(box, img, 0);
  if (inner.width < 4 || inner.height < 4) return { ok: false, reason: "too-small" };
  const ringPad = Math.max(2, Math.round(inner.height * 0.25));
  const outer = {
    left: Math.max(0, inner.left - ringPad),
    top: Math.max(0, inner.top - ringPad),
    right: Math.min(img.width, inner.left + inner.width + ringPad),
    bottom: Math.min(img.height, inner.top + inner.height + ringPad),
  };

  // Background from the ring
  const ringBins = new Map<number, { n: number; c: [number, number, number] }>();
  let ringTotal = 0;
  for (let y = outer.top; y < outer.bottom; y++) {
    for (let x = outer.left; x < outer.right; x++) {
      const inside = x >= inner.left && x < inner.left + inner.width && y >= inner.top && y < inner.top + inner.height;
      if (inside) continue;
      const [r, g, b] = px(img, x, y);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = ringBins.get(key) || { n: 0, c: [0, 0, 0] };
      bin.n++;
      bin.c[0] += r;
      bin.c[1] += g;
      bin.c[2] += b;
      ringBins.set(key, bin);
      ringTotal++;
    }
  }
  if (ringTotal < 20) return { ok: false, reason: "too-small" };
  const top = [...ringBins.values()].sort((a, b) => b.n - a.n)[0];
  if (top.n / ringTotal < 0.45) return { ok: false, reason: "busy-background" };
  const bg: [number, number, number] = [top.c[0] / top.n, top.c[1] / top.n, top.c[2] / top.n];

  // Foreground from ink pixels inside the text box
  const ink: { ratio: number; c: [number, number, number] }[] = [];
  let total = 0;
  for (let y = inner.top; y < inner.top + inner.height; y++) {
    for (let x = inner.left; x < inner.left + inner.width; x++) {
      const c = px(img, x, y);
      total++;
      const ratio = contrastRatio(c, bg);
      if (ratio >= 1.15) ink.push({ ratio, c });
    }
  }
  const inkShare = ink.length / Math.max(1, total);
  if (ink.length < 12 || inkShare < 0.03) return { ok: false, reason: "no-text-pixels" };
  ink.sort((a, b) => b.ratio - a.ratio);
  const core = ink.slice(0, Math.max(6, Math.round(ink.length * 0.3)));
  const mid = core[Math.floor(core.length / 2)];
  return {
    ok: true,
    ratio: Math.round(mid.ratio * 100) / 100,
    fg: hex(mid.c),
    bg: hex(bg),
    inkShare: Math.round(inkShare * 100) / 100,
  };
}

// ── Geometry ──
export interface DeviceScale {
  widthDp: number;
  heightDp: number;
}

export function deviceScale(
  platform: "android" | "ios" | "unknown",
  imgWidth: number,
  imgHeight: number,
  widthDpOverride?: number,
): DeviceScale {
  const widthDp = widthDpOverride || (platform === "ios" ? 390 : platform === "android" ? 411 : 400);
  return { widthDp, heightDp: widthDp * (imgHeight / Math.max(1, imgWidth)) };
}

export function boxSizeDp(box: Box, scale: DeviceScale) {
  const [ymin, xmin, ymax, xmax] = box;
  return {
    w: Math.round(((xmax - xmin) / 1000) * scale.widthDp),
    h: Math.round(((ymax - ymin) / 1000) * scale.heightDp),
  };
}

const INTERACTIVE: ElementType[] = ["button", "link", "checkbox", "toggle", "input"];
// Plain text and images are never targets on their own — in cards they are part of a
// larger tappable card even when a model draws a tap box around the text
const isInteractive = (e: UIElement) =>
  e.type !== "text" &&
  e.type !== "image" &&
  (!!e.tapBox || INTERACTIVE.includes(e.type) || e.role === "close" || e.role === "rating-star" || (e.type === "icon" && !!e.role && e.role !== "other"));

const areaOf = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** Human label for the component an element belongs to (used to group findings) */
export const componentOf = (e: UIElement) => {
  const name = canonicalComponent(e.component || (e.role && e.role !== "other" ? e.role.replace(/-/g, " ") : e.type));
  // Drop the element's own words: "category chip cafe" → "category chip"
  const own = new Set((e.text || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const kept = name.split(" ").filter((w) => !own.has(w));
  return kept.length ? kept.join(" ") : name;
};

/**
 * Normalises AI component names so the same component groups together:
 * "Product card struck-out price" / "product struck-out prices" → "product struck-out price".
 */
export function canonicalComponent(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    // "add-to-cart button" and "add to cart button" are the same component
    .replace(/\badd to cart\b/g, "add-to-cart")
    .split(/\s+/)
    .filter((w) => w && !/^\d+$/.test(w) && !["card", "name", "the", "item", "text", "label", "element", "ui", "field"].includes(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ")
    .trim() || name.toLowerCase().trim();
  // A bare adjective reads badly in findings ("contrast of the sponsored")
  const RENAME: Record<string, string> = { sponsored: "partner label", "sponsored-label": "partner label", "sponsored label": "partner label", term: "terms note", condition: "terms note" };
  return RENAME[out] || out;
}

const centre = (b: Box): [number, number] => [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2];

/** Distance in dp from a point to the nearest edge of a box (0 if inside) */
function distanceToBoxDp(x: number, y: number, b: Box, scale: DeviceScale) {
  const dx = Math.max(b[1] - x, 0, x - b[3]) / 1000 * scale.widthDp;
  const dy = Math.max(b[0] - y, 0, y - b[2]) / 1000 * scale.heightDp;
  return Math.hypot(dx, dy);
}

// ── Per-screen deterministic rules ──
export function runScreenRules(
  screenIdx: number,
  inv: ScreenInventory,
  img: DecodedImage | null,
  platform: "android" | "ios" | "unknown",
  scale: DeviceScale,
  advisories: Advisory[] = [],
): MeasuredFinding[] {
  const out: MeasuredFinding[] = [];
  const platformMin = platform === "ios" ? 44 : 48;
  const platformName = platform === "ios" ? "Apple HIG (44×44pt)" : "Material Design (48×48dp)";
  const unit = platform === "ios" ? "pt" : "dp";
  const contrastOf = new Map<string, number>();
  const advise = (ruleId: string, title: string, comp: string, el: UIElement, detail: string) => {
    // Banners are content, not tap targets worth reporting; one/two-letter fragments are cut-off text
    if (ruleId.startsWith("2.5") && (el.role === "promo-banner" || comp === "promo banner")) return;
    // Placeholder text is not the field's tap area; generic names ("icon button") tell the client nothing
    if (ruleId.startsWith("2.5") && (/placeholder/.test(comp) || (["button", "icon", "icon button"].includes(comp) && !el.text?.trim()))) return;
    // One target-size row per component: a later observation joins the existing row
    const existing = advisories.find((a) => a.component === comp && (a.ruleId === ruleId || (ruleId.startsWith("2.5") && a.ruleId.startsWith("2.5"))) && (a.title === title || ruleId.startsWith("2.5")));
    const raw = el.text?.trim() || "";
    const name = raw.length >= 3 ? raw : comp;
    if (existing) {
      if (!existing.screens.includes(screenIdx)) {
        existing.screens.push(screenIdx);
        existing.screens.sort((a, b) => a - b);
      }
      if (!existing.elements.includes(name)) existing.elements.push(name);
    } else {
      advisories.push({ ruleId, title, component: comp, screens: [screenIdx], elements: [name], detail });
    }
  };

  // Floating layers (sticky tab bars, banners, sheets, modals) fade or hide what is under them
  const overlays = inv.elements.filter((o) => o.overlay || o.role === "fixed-bar" || o.role === "promo-banner");
  const overlap = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const contains = (outer: Box, inner: Box) =>
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
  // Covered = an overlay overlaps the text without containing it (text fully inside
  // an overlay is the overlay's own content, e.g. a tab-bar label)
  const isCovered = (el: UIElement) =>
    !!el.occluded ||
    (!el.overlay &&
      overlays.some((o) => o.id !== el.id && overlap(el.box, o.tapBox || o.box) && !contains(o.tapBox || o.box, el.box)));

  for (const el of inv.elements) {
    const comp = componentOf(el);
    const covered = !!el.text?.trim() && isCovered(el);
    if (covered) {
      advise("content-obscured", "Content partly hidden behind a fixed bar or overlay", comp, el,
        "Text sits under a sticky bar, banner or scrim, so it is faded or cut off while scrolling. Contrast was not measured for it. Add bottom padding equal to the bar height so content can scroll clear.");
    }

    // Contrast (WCAG 1.4.3 text / 1.4.11 non-text icons).
    // Exempt: disabled controls, logos, text inside photos/illustrations.
    if (img && !covered && !el.disabled && !el.inImage && el.role !== "logo" && el.type !== "image") {
      const hasText = !!el.text && el.text.trim().length > 0;
      const isIcon = !hasText && (el.type === "icon" || el.role === "close");
      if (hasText || isIcon) {
        const m = measureContrast(img, el.box);
        if (m.ok) {
          contrastOf.set(el.id, m.ratio);
          const { h } = boxSizeDp(el.box, scale);
          const fontDp = h / Math.max(1, el.lines || 1) / 1.15;
          const large = fontDp >= 24 || (!!el.bold && fontDp >= 18.66);
          const required = hasText ? (large ? 3 : 4.5) : 3;
          const wcag = hasText ? "1.4.3" : "1.4.11";
          // A reading this low on visibly rendered text usually means the box missed the
          // glyphs or a translucent layer sits on top — flag for review, don't assert
          const implausible = m.ratio < 1.5;
          // Brand-partner text ("Powered by X") is often a logotype, which SC 1.4.3 exempts
          const maybeLogotype = hasText && (el.role === "sponsored-label" || /^(powered|presented|brought to you) by\b/i.test(el.text!.trim()));
          if (implausible && m.ratio < required - 0.05) {
            // Unreliable reading — never reported as a violation in a final report
            advise("contrast-verify", "Very faint text — contrast reading unreliable, verify on device", comp, el,
              `Measured ${m.ratio}:1 (${m.fg} on ${m.bg}), which usually means the reading missed the glyphs or a translucent layer covers the text. Check with a contrast analyser on the device.`);
          } else if (m.ratio < required - 0.05) {
            out.push({
              pillar: "accessibility",
              ruleId: wcag,
              wcag,
              wcagLevel: "AA",
              title: hasText ? `Insufficient text contrast — ${comp}` : `Insufficient non-text contrast — ${comp}`,
              description: `${hasText ? `"${el.text!.trim().slice(0, 60)}"` : "Icon control"}: measured ${m.ratio}:1 (${hasText ? "text" : "icon"} ${m.fg} on ${m.bg}); WCAG 2.2 SC ${wcag} requires at least ${required}:1${hasText ? (large ? " for large text" : " for normal text") : " for UI components"}.${maybeLogotype ? " This may be part of a partner logo (logotypes are exempt) — confirm with the client." : ""}`,
              severity: implausible || maybeLogotype ? "medium" : m.ratio < required * 0.67 ? "high" : "medium",
              confidence: implausible || maybeLogotype ? "low" : m.ratio < required * 0.8 ? "high" : "medium",
              screens: [screenIdx],
              elementId: el.id,
              box: el.box,
              component: comp,
              elementText: el.text?.trim(),
              measurements: {
                contrastRatio: `${m.ratio}:1`,
                required: `${required}:1`,
                foreground: m.fg,
                background: m.bg,
                estimatedFontSize: `${Math.round(fontDp)}${unit}`,
              },
              recommendation: `Raise contrast of the ${comp} to at least ${required}:1.`,
              developerFix: `Use a colour token with at least ${required}:1 contrast against ${m.bg}, applied to every ${comp}.`,
              designerFix: `Update the ${comp} colour style in the design system (currently ${m.fg} on ${m.bg}).`,
            });
          }
        }
      }
    }

    // Touch target size (WCAG 2.5.8 AA = 24×24 or spacing exception;
    // 2.5.5 AAA / platform guideline = 44–48 → advisory only)
    // A star-rating row is several small targets, not one wide target — measure stars individually
    const ratingRow = el.role === "rating-prompt" || (/rating|star/.test(comp) && !el.text?.trim() && (() => { const s0 = boxSizeDp(el.tapBox || el.box, scale); return s0.w > s0.h * 3; })());
    if (isInteractive(el) && !ratingRow) {
      let targetBox = el.tapBox || el.box;
      let labelledControl = false;
      // Checkboxes/toggles are normally tappable together with their label
      if (!el.tapBox && (el.type === "checkbox" || el.type === "toggle")) {
        const label = inv.elements.find(
          (o) => o.id !== el.id && !!o.text && o.box[0] < el.box[2] && o.box[2] > el.box[0] && Math.abs(o.box[1] - el.box[3]) < 120,
        );
        if (label) {
          labelledControl = true;
          targetBox = [Math.min(el.box[0], label.box[0]), Math.min(el.box[1], label.box[1]), Math.max(el.box[2], label.box[2]), Math.max(el.box[3], label.box[3])];
        }
      }
      const { w, h } = boxSizeDp(targetBox, scale);
      const min = Math.min(w, h);
      // Visible glyph only — the real tappable area usually has invisible padding
      // Visible glyph only — a tap box no bigger than the glyph tells us nothing about padding
      const glyphOnly =
        (el.type === "icon" || el.role === "close" || el.role === "rating-star" || el.type === "link") &&
        (!el.tapBox || areaOf(el.tapBox) < areaOf(el.box) * 1.3);
      const name = el.text?.trim() ? `"${el.text.trim().slice(0, 30)}"` : comp;

      if (min < 24) {
        // WCAG 2.5.8 spacing exception: a 24-unit circle centred on this target must not
        // intersect another target, nor the 24-unit circle of another undersized target
        const [cx, cy] = centre(targetBox);
        const crowded = inv.elements.some((o) => {
          if (o.id === el.id || !isInteractive(o)) return false;
          const ob = o.tapBox || o.box;
          const os = boxSizeDp(ob, scale);
          if (Math.min(os.w, os.h) < 24) {
            const [ox, oy] = centre(ob);
            const d = Math.hypot(((ox - cx) / 1000) * scale.widthDp, ((oy - cy) / 1000) * scale.heightDp);
            return d < 24;
          }
          return distanceToBoxDp(cx, cy, ob, scale) < 12;
        });
        if (!crowded) {
          advise("2.5.8", "Small target passes via WCAG 2.5.8 spacing exception", comp, el,
            `Visible target about ${w}×${h}${unit}; no other target within the 24${unit} spacing circle, so SC 2.5.8 is met. Below ${platformName} — consider enlarging.`);
        } else if (glyphOnly || labelledControl) {
          out.push({
            pillar: "accessibility",
            ruleId: "2.5.8",
            wcag: "2.5.8",
            wcagLevel: "AA",
            title: `Small, closely spaced control — verify tap area on device — ${comp}`,
            description: `${name}: visible control about ${w}×${h}${unit} with another target inside the 24${unit} spacing circle. The tappable area may include invisible padding; confirm on a device that it is at least 24×24${unit}.`,
            severity: "medium",
            confidence: "low",
            screens: [screenIdx],
            elementId: el.id,
            box: targetBox,
            component: comp,
            elementText: el.text?.trim(),
            measurements: { visibleSize: `${w}×${h}${unit}`, wcagMinimum: "24×24", platformMinimum: `${platformMin}×${platformMin}` },
            recommendation: `Ensure each ${comp} has a tappable area of at least ${platformMin}×${platformMin}${unit}, or spacing of 24${unit} between targets.`,
          });
        } else {
          out.push({
            pillar: "accessibility",
            ruleId: "2.5.8",
            wcag: "2.5.8",
            wcagLevel: "AA",
            title: `Touch target below WCAG minimum — ${comp}`,
            description: `${name}: tappable area about ${w}×${h}${unit}, with another target inside the 24${unit} spacing circle. WCAG 2.2 SC 2.5.8 requires 24×24${unit} (or sufficient spacing); ${platformName} recommends ${platformMin}×${platformMin}${unit}.`,
            // A small shortfall (e.g. 22 vs 24) is friction with a workaround; well below is a barrier
            severity: min < 18 ? "high" : "medium",
            confidence: min < 18 ? "high" : "medium",
            screens: [screenIdx],
            elementId: el.id,
            box: targetBox,
            component: comp,
            elementText: el.text?.trim(),
            measurements: { targetSize: `${w}×${h}${unit}`, wcagMinimum: "24×24", platformMinimum: `${platformMin}×${platformMin}` },
            recommendation: `Increase every ${comp} to at least ${platformMin}×${platformMin}${unit}.`,
            developerFix: `Add padding / minimum touch size (${platform === "ios" ? "frame ≥ 44×44pt" : "minHeight/minWidth 48dp or TouchDelegate"}) on the ${comp} component.`,
            designerFix: `Increase the ${comp} hit area in the design system.`,
          });
        }
      } else if (min < platformMin) {
        advise("2.5.5", `Target below ${platformName} (meets WCAG AA)`, comp, el,
          `About ${w}×${h}${unit}: passes WCAG 2.5.8 (AA) but is below ${platformName} and WCAG 2.5.5 (AAA, 44×44).`);
      }
    }

    // Pre-selected opt-in / add-on
    if (el.type === "checkbox" || el.type === "toggle") {
      if (el.checked && (el.role === "consent" || el.role === "addon")) {
        const priced = inv.amounts.some((a) => a.elementId === el.id && a.value > 0);
        out.push({
          pillar: "darkpatterns",
          ruleId: el.role === "addon" ? "DP-SN-02" : "DP-SN-01",
          category: "sneaking",
          title:
            el.role === "addon"
              ? `Pre-selected paid add-on: "${(el.text || "").slice(0, 50)}"`
              : `Pre-selected consent: "${(el.text || "").slice(0, 50)}"`,
          description:
            el.role === "addon"
              ? `An optional add-on is ticked by default${priced ? " and adds to the amount charged" : ""}. Users must actively opt out to avoid paying for it.`
              : "A consent/marketing option is ticked by default, so consent is not a clear affirmative action.",
          severity: "critical",
          confidence: "high",
          screens: [screenIdx],
          elementId: el.id,
          box: el.box,
          measurements: { defaultState: "checked" },
          recommendation: "Leave optional add-ons and consent options unticked by default.",
          developerFix: "Initialise the checkbox/toggle state to false.",
          designerFix: "Show optional extras as an explicit 'Add' choice, unticked.",
        });
      }
    }
  }

  // CTA asymmetry: accept/primary vs decline/skip on the same screen
  // Only a genuine choice pair: the decline option and the nearest accept/primary
  // option in the same component or within ~35% of the screen height
  const decline = inv.elements.find((e) => e.role === "decline" || e.role === "skip");
  const accept = decline
    ? inv.elements
        .filter((e) => e.role === "accept" || e.role === "primary-cta")
        .filter((e) => (decline.component && e.component === decline.component) || Math.abs(centre(e.box)[1] - centre(decline.box)[1]) < 350)
        .sort((x, y) => Math.abs(centre(x.box)[1] - centre(decline.box)[1]) - Math.abs(centre(y.box)[1] - centre(decline.box)[1]))[0]
    : undefined;
  if (accept && decline) {
    const a = boxSizeDp(accept.tapBox || accept.box, scale);
    const d = boxSizeDp(decline.tapBox || decline.box, scale);
    const areaRatio = (a.w * a.h) / Math.max(1, d.w * d.h);
    const ca = contrastOf.get(accept.id);
    const cd = contrastOf.get(decline.id);
    const contrastWeaponised = ca !== undefined && cd !== undefined && cd < 3 && ca >= 4.5;
    if (areaRatio >= 3 || contrastWeaponised) {
      out.push({
        pillar: "darkpatterns",
        ruleId: contrastWeaponised ? "DP-AX-01" : "DP-MD-09",
        category: "interface-interference",
        title: `Asymmetric choice: "${(accept.text || "Accept").slice(0, 30)}" vs "${(decline.text || "Decline").slice(0, 30)}"`,
        description: `The accept option is ${areaRatio.toFixed(1)}× the size of the decline option${contrastWeaponised ? ` and decline contrast is only ${cd}:1 vs ${ca}:1` : ""}, steering users toward accepting.`,
        severity: areaRatio >= 6 || contrastWeaponised ? "high" : "medium",
        confidence: "high",
        screens: [screenIdx],
        elementId: decline.id,
        box: decline.box,
        measurements: {
          acceptSize: `${a.w}×${a.h}dp`,
          declineSize: `${d.w}×${d.h}dp`,
          areaRatio: `${areaRatio.toFixed(1)}×`,
          ...(ca !== undefined ? { acceptContrast: `${ca}:1` } : {}),
          ...(cd !== undefined ? { declineContrast: `${cd}:1` } : {}),
        },
        recommendation: "Give accept and decline options equal size, contrast and prominence.",
        developerFix: "Render both choices with the same button component and variant.",
        designerFix: "Use equal-weight buttons side by side for binary choices.",
      });
    }
  }

  // Free/₹0 headline with a paid renewal shown only in small or faint text
  const freePrice = inv.amounts.find((a) => a.role === "price" && a.value === 0);
  const renewal = inv.amounts.find((a) => a.role === "renewal" && a.value > 0);
  if (freePrice && renewal) {
    const el = inv.elements.find((e) => e.id === renewal.elementId);
    const c = el ? contrastOf.get(el.id) : undefined;
    const fontDp = el ? boxSizeDp(el.box, scale).h / Math.max(1, el.lines || 1) / 1.25 : undefined;
    const hidden = (c !== undefined && c < 4.5) || (fontDp !== undefined && fontDp < 12) || el?.role === "fine-print";
    if (hidden) {
      out.push({
        pillar: "darkpatterns",
        ruleId: "DP-SN-09",
        category: "sneaking",
        title: "Free trial converts to paid — renewal price de-emphasised",
        description: `A free/${freePrice.currency || ""}0 offer is promoted while the renewal charge (${renewal.currency || ""}${renewal.value}) appears only in ${c !== undefined && c < 4.5 ? `low-contrast (${c}:1) ` : ""}${fontDp !== undefined && fontDp < 12 ? `small (~${Math.round(fontDp)}dp) ` : ""}text.`,
        severity: "critical",
        confidence: "high",
        screens: [screenIdx],
        elementId: el?.id,
        box: el?.box,
        measurements: {
          headlinePrice: `${freePrice.currency || ""}0`,
          renewalPrice: `${renewal.currency || ""}${renewal.value}`,
          ...(c !== undefined ? { renewalTextContrast: `${c}:1` } : {}),
          ...(fontDp !== undefined ? { renewalTextSize: `${Math.round(fontDp)}dp` } : {}),
        },
        recommendation: "Show the renewal price, billing date and cancellation method next to the trial CTA, at the same prominence.",
      });
    }
  }

  return out;
}

// ── Price consistency (per screen and across the journey) ──
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005);

export function runPriceRules(inventories: ScreenInventory[]): MeasuredFinding[] {
  const out: MeasuredFinding[] = [];
  const fmt = (a: Amount) => `${a.currency || ""}${a.value.toLocaleString("en-IN")}`;

  inventories.forEach((inv, i) => {
    const total = inv.amounts.find((a) => a.role === "total");
    const pay = inv.amounts.find((a) => a.role === "pay-button");
    const parts = inv.amounts.filter((a) => a.role === "line-item" || a.role === "fee");
    const discounts = inv.amounts.filter((a) => a.role === "discount");
    const addonsChecked = inv.amounts.filter((a) => {
      if (a.role !== "addon") return false;
      const el = inv.elements.find((e) => e.id === a.elementId);
      return !el || el.checked !== false;
    });

    if (total && parts.length >= 2) {
      const sum = parts.reduce((s, a) => s + a.value, 0) - discounts.reduce((s, a) => s + Math.abs(a.value), 0);
      if (!near(sum, total.value) && !near(sum + addonsChecked.reduce((s, a) => s + a.value, 0), total.value)) {
        out.push({
          pillar: "darkpatterns",
          ruleId: "DP-HC-01",
          category: "sneaking",
          title: "Displayed total does not match its line items",
          description: `Line items and fees add up to ${sum.toLocaleString("en-IN")}, but the total shows ${fmt(total)}.`,
          severity: "high",
          confidence: "medium",
          screens: [i],
          measurements: { sumOfItems: sum, displayedTotal: total.value },
          recommendation: "Make the itemised breakdown add up exactly to the total shown.",
        });
      }
    }

    if (total && pay && !near(total.value, pay.value)) {
      const addonSum = addonsChecked.reduce((s, a) => s + a.value, 0);
      const explainedByAddon = addonSum > 0 && near(total.value + addonSum, pay.value);
      const payEl = inv.elements.find((e) => e.id === pay.elementId);
      out.push({
        pillar: "darkpatterns",
        ruleId: explainedByAddon ? "DP-SN-02" : "DP-HC-01",
        category: "sneaking",
        title: explainedByAddon
          ? "Pre-selected add-on silently added to the amount charged"
          : "Amount charged differs from the displayed total",
        description: explainedByAddon
          ? `The total shows ${fmt(total)} but the pay button charges ${fmt(pay)} — the difference (${addonSum.toLocaleString("en-IN")}) is a pre-selected add-on not included in the total.`
          : `The total shows ${fmt(total)} but the pay button charges ${fmt(pay)}.`,
        severity: "critical",
        confidence: "high",
        screens: [i],
        elementId: payEl?.id,
        box: payEl?.box,
        measurements: { displayedTotal: total.value, amountCharged: pay.value, difference: Math.round((pay.value - total.value) * 100) / 100 },
        recommendation: "The amount on the pay button must equal the itemised total; include any optional extras in the breakdown only if the user chose them.",
        developerFix: "Compute the pay-button amount from the same cart total that the summary renders.",
      });
    }
  });

  // Drip pricing: fees first appear on a later screen than the first price shown
  const firstPrice = inventories.findIndex((inv) => inv.amounts.some((a) => a.role === "price" || a.role === "line-item"));
  const feeScreen = inventories.findIndex((inv) => inv.amounts.some((a) => a.role === "fee" && a.value > 0));
  if (firstPrice >= 0 && feeScreen > firstPrice) {
    const fees = inventories[feeScreen].amounts.filter((a) => a.role === "fee" && a.value > 0);
    out.push({
      pillar: "darkpatterns",
      ruleId: "DP-PM-04",
      category: "sneaking",
      title: "Mandatory fees revealed only later in the journey",
      description: `Prices are first shown on screen ${firstPrice + 1}, but ${fees.map((f) => `${f.label} (${fmt(f)})`).join(", ")} appear only on screen ${feeScreen + 1}.`,
      severity: "high",
      confidence: "medium",
      screens: [firstPrice, feeScreen],
      measurements: { firstPriceScreen: firstPrice + 1, feeScreen: feeScreen + 1, fees: fees.map(fmt).join(", ") },
      recommendation: "Include all mandatory fees in the first price shown to the user.",
    });
  }
  return out;
}

// ── Journey rule: runtime permission without prior rationale ──
export function runPermissionRules(inventories: ScreenInventory[]): MeasuredFinding[] {
  const out: MeasuredFinding[] = [];
  inventories.forEach((inv, i) => {
    const prompt = inv.elements.find((e) => e.role === "permission-prompt");
    if (!prompt) return;
    const explainedEarlier = inventories
      .slice(0, i + 1)
      .some((s) => s.elements.some((e) => e.role === "permission-rationale"));
    if (!explainedEarlier) {
      out.push({
        pillar: "privacy",
        ruleId: "MOB-PRIV-PERMISSION-RATIONALE",
        category: "data-collection",
        title: `Runtime permission requested without prior explanation: "${(prompt.text || "").slice(0, 60)}"`,
        description: `A system permission prompt appears on screen ${i + 1} and no earlier screen explains why the app needs it or how the data will be used.`,
        severity: "high",
        confidence: "medium",
        screens: [i],
        elementId: prompt.id,
        box: prompt.box,
        measurements: { promptScreen: i + 1, rationaleShownBefore: "no" },
        recommendation: "Show an in-context explanation screen (purpose, data use, how to change later) before triggering the OS permission prompt.",
      });
    }
  });
  return out;
}

// ── Evidence crop with the element outlined ──
export async function annotatedCrop(base64: string, box: Box | undefined): Promise<string | undefined> {
  const sharp = await getSharp();
  if (!sharp || !box) return undefined;
  try {
    const input = Buffer.from(base64, "base64");
    const meta = await sharp(input).metadata();
    const img = { width: meta.width || 0, height: meta.height || 0 };
    if (!img.width || !img.height) return undefined;
    const target = boxToPx(box, img, 0);
    // Context window around the element (at least 40% of screen width)
    const ctxW = Math.min(img.width, Math.max(target.width * 2.2, img.width * 0.4));
    const ctxH = Math.min(img.height, Math.max(target.height * 3, img.height * 0.15));
    const left = Math.max(0, Math.min(img.width - ctxW, target.left + target.width / 2 - ctxW / 2));
    const top = Math.max(0, Math.min(img.height - ctxH, target.top + target.height / 2 - ctxH / 2));
    const crop = { left: Math.round(left), top: Math.round(top), width: Math.round(ctxW), height: Math.round(ctxH) };
    const stroke = Math.max(3, Math.round(img.width / 200));
    const svg = Buffer.from(
      `<svg width="${crop.width}" height="${crop.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${target.left - crop.left - stroke}" y="${target.top - crop.top - stroke}" width="${target.width + stroke * 2}" height="${target.height + stroke * 2}" fill="none" stroke="#E8002D" stroke-width="${stroke}" rx="${stroke * 2}"/></svg>`,
    );
    const out = await sharp(input)
      .extract(crop)
      .composite([{ input: svg, top: 0, left: 0 }])
      .resize({ width: 640, withoutEnlargement: true })
      // PNG: the DOCX/PDF exporters embed elementScreenshot as PNG
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return undefined;
  }
}

// ── Consumer-protection rules on extracted on-screen text ──
// Reuses the TrustLens text-pattern library used for web and PDF audits, plus
// structural checks that are reliable from a screenshot inventory.
const TEXT_RULES: { patterns: RegExp[]; ruleId: string; category: string; title: string; severity: MeasuredFinding["severity"]; recommendation: string }[] = [
  { patterns: URGENCY_PATTERNS, ruleId: "DP-SU-03", category: "scarcity-urgency", title: "Urgency or scarcity pressure in copy", severity: "medium", recommendation: "Remove time or stock pressure unless it is genuine, verifiable and shows a clear end date or stock source." },
  { patterns: CONFIRMSHAMING_PATTERNS, ruleId: "DP-CS-01", category: "confirmshaming", title: "Confirmshaming on a decline option", severity: "high", recommendation: "Use neutral wording for declining, e.g. \"No thanks\"." },
  { patterns: FAMILY_GUILT_PATTERNS, ruleId: "DP-CS-05", category: "confirmshaming", title: "Guilt-framed copy", severity: "medium", recommendation: "Remove guilt or fear framing from offers and decline options." },
  { patterns: SOCIAL_PRESSURE_PATTERNS, ruleId: "DP-SP-01", category: "social-pressure", title: "Unverifiable social-proof pressure", severity: "medium", recommendation: "Show social proof only when it is real-time, accurate and verifiable." },
  { patterns: CRORE_TRUST_PATTERNS, ruleId: "DP-SP-05", category: "social-pressure", title: "Unverifiable scale or trust claim", severity: "low", recommendation: "Substantiate scale claims with a source and date, or remove them." },
  { patterns: AUTO_RENEWAL_PATTERNS, ruleId: "DP-FA-04", category: "forced-action", title: "Auto-renewal terms in the flow", severity: "high", recommendation: "State renewal price, date and how to cancel next to the purchase button, with equal prominence." },
  { patterns: SUBSCRIPTION_TRAP_PATTERNS, ruleId: "DP-SN-09", category: "sneaking", title: "Trial or subscription that converts to paid", severity: "high", recommendation: "Disclose the post-trial price and conversion date prominently before sign-up." },
  { patterns: DRIP_PRICING_PATTERNS, ruleId: "DP-PM-04", category: "sneaking", title: "Additional fees introduced in the flow", severity: "medium", recommendation: "Include all mandatory fees in the first price shown." },
  { patterns: ASTERISK_PROMO_PATTERNS, ruleId: "DP-MD-08", category: "misdirection", title: "Promotional claim qualified by fine print", severity: "medium", recommendation: "Put conditions next to the claim at the same prominence, or remove the qualifier." },
];

const RATING_PROMPT = /how was your (app )?experience|rate (us|this app|the app|your experience)|enjoying (the |this |our )?app|leave (us )?a review|love (the|our) app/i;
const SPONSORED_HINT = /powered by|presented by|in partnership with|brought to you by|featured|member'?s pick|top picks?|promoted|brand spotlight/i;
const SPONSORED_LABEL = /^(ad|ads|sponsored|advertisement|promoted)$|\bsponsored\b|\badvertisement\b/i;
const PROMO_TEXT = /cashback|% ?off|coupon|offer|discount|free delivery|save ₹|save rs/i;

export function runConsumerTextRules(inventories: ScreenInventory[]): MeasuredFinding[] {
  const out: MeasuredFinding[] = [];
  const text = (e: UIElement) => (e.text || "").trim();

  inventories.forEach((inv, i) => {
    const seen = new Set<string>();
    for (const el of inv.elements) {
      const t = text(el);
      if (t.length < 4 || el.inImage) continue;
      for (const rule of TEXT_RULES) {
        if (seen.has(rule.ruleId)) continue;
        if (rule.patterns.some((p) => p.test(t))) {
          seen.add(rule.ruleId);
          out.push({
            pillar: "darkpatterns",
            ruleId: rule.ruleId,
            category: rule.category,
            title: rule.title,
            description: `On-screen text "${t.slice(0, 100)}" matches the ${rule.title.toLowerCase()} pattern.`,
            severity: rule.severity,
            confidence: "medium",
            screens: [i],
            elementId: el.id,
            box: el.box,
            component: componentOf(el),
            elementText: t,
            measurements: { matchedText: t.slice(0, 100) },
            recommendation: rule.recommendation,
          });
        }
      }
    }

    // Rating / review prompt shown while browsing
    const rating = inv.elements.find((e) => e.role === "rating-prompt" || RATING_PROMPT.test(text(e)));
    if (rating) {
      out.push({
        pillar: "darkpatterns",
        ruleId: "DP-NG-01",
        category: "nagging",
        title: "Rating prompt interrupts browsing",
        description: `A rating/feedback prompt ("${text(rating).slice(0, 60) || "rating prompt"}") is shown over the browsing screen before any task is completed.`,
        severity: "medium",
        confidence: "high",
        screens: [i],
        elementId: rating.id,
        box: rating.tapBox || rating.box,
        component: "rating prompt",
        elementText: text(rating),
        measurements: { prompt: text(rating).slice(0, 60) },
        recommendation: "Ask for ratings only after a completed task (e.g. after delivery), with an easy dismiss, and respect the user's choice.",
      });
    }

    // Sponsored / partner placement without an Ad / Sponsored label
    // Navigation ("FEATURED" tab, filter chips) names a section, not an ad placement
    const isNav = (e: UIElement) => /\b(tab|chip|filter|category|nav|menu)\b/.test(componentOf(e));
    const hint = inv.elements.find((e) => (SPONSORED_HINT.test(text(e)) && !isNav(e)) || e.role === "sponsored-label");
    const labelled = inv.elements.some((e) => SPONSORED_LABEL.test(text(e)));
    if (hint && !labelled) {
      out.push({
        pillar: "darkpatterns",
        ruleId: "DP-MD-05",
        category: "misdirection",
        title: "Brand or partner placement without an \"Ad\"/\"Sponsored\" label",
        description: `"${text(hint).slice(0, 60)}" suggests a brand-partner or featured placement, but no "Ad" or "Sponsored" label is visible on the screen. Confirm with the client whether the placement is paid.`,
        severity: "medium",
        confidence: "low",
        screens: [i],
        elementId: hint.id,
        box: hint.tapBox || hint.box,
        component: "sponsored placement",
        elementText: text(hint),
        measurements: { cue: text(hint).slice(0, 60), adLabelVisible: "no" },
        recommendation: "Label paid or partner placements clearly as \"Ad\" or \"Sponsored\" at the point of display.",
      });
    }

    // Struck-out reference prices
    // Thresholds and offers ("orders above Rs 699", "save Rs 50") are not struck-out prices
    const nonPrice = /\b(above|over|min|minimum|orders?|delivery|cashback|save|off|upto)\b|up to/i;
    const refs = inv.amounts.filter((a) => {
      if (a.role !== "reference") return false;
      const src = inv.elements.find((e) => e.id === a.elementId);
      return !nonPrice.test(`${a.label} ${src?.text || ""}`);
    });
    if (refs.length) {
      const el = inv.elements.find((e) => e.id === refs[0].elementId);
      out.push({
        pillar: "darkpatterns",
        ruleId: "DP-MD-08",
        category: "misdirection",
        title: "Struck-out reference prices without a stated basis",
        description: `Struck-out reference prices (e.g. ${refs.slice(0, 3).map((r) => `${r.currency || ""}${r.value}`).join(", ")}) are shown next to selling prices with no explanation of what the reference price is.`,
        severity: "medium",
        confidence: "medium",
        screens: [i],
        elementId: el?.id,
        box: el?.box,
        component: "struck-out reference price",
        elementText: refs.map((r) => `${r.currency || ""}${r.value}`).join(", "),
        measurements: { referencePrices: refs.length },
        recommendation: "State the basis of reference prices (e.g. MRP) and, for EU users, use the lowest price of the previous 30 days.",
      });
    }
  });

  // Same promotional banner floating over content on several screens
  const promoByText = new Map<string, { screens: number[]; el: UIElement }>();
  inventories.forEach((inv, i) => {
    for (const e of inv.elements) {
      const t = text(e).toLowerCase();
      if (!t || !(e.role === "promo-banner" || (e.overlay && PROMO_TEXT.test(t)))) continue;
      const key = t.replace(/\s+/g, " ").slice(0, 60);
      const entry = promoByText.get(key) || { screens: [], el: e };
      if (!entry.screens.includes(i)) entry.screens.push(i);
      promoByText.set(key, entry);
    }
  });
  for (const [t, v] of promoByText) {
    if (v.screens.length < 2) continue;
    out.push({
      pillar: "darkpatterns",
      ruleId: "DP-NG-04",
      category: "nagging",
      title: "Promotional banner repeated over content on several screens",
      description: `The banner "${text(v.el) || t}" floats over the content on ${v.screens.length} screens, hiding part of the page while browsing.`,
      severity: "medium",
      confidence: "high",
      screens: v.screens,
      elementId: v.el.id,
      box: v.el.tapBox || v.el.box,
      component: "promo banner",
      elementText: text(v.el),
      measurements: { screens: v.screens.map((s) => s + 1).join(", ") },
      recommendation: "Show promotions inline in the scrollable content or let users dismiss them permanently.",
    });
  }
  return out;
}

// ── Evidence fallback: small screen thumbnail when the element has no box ──
export async function screenThumbnail(base64: string): Promise<string | undefined> {
  const sharp = await getSharp();
  if (!sharp) return undefined;
  try {
    const out = await sharp(Buffer.from(base64, "base64"))
      .resize({ width: 360, withoutEnlargement: true })
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return undefined;
  }
}
