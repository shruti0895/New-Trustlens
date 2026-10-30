// ============================================================
// KPMG TrustLens — Mobile App Analyzer (Vision AI + measurement)
// Audits native mobile app journeys from uploaded screenshots
// or screen-recording frames. Platform-agnostic (Android/iOS).
//
// Pass 1: per-screen UI inventory (elements, boxes, amounts) +
//         AI judgement findings mapped to TrustLens rule IDs
// Rules : deterministic checks on real pixels and extracted data
//         (contrast, touch targets, CTA asymmetry, prices, permissions)
// Pass 2: cross-screen journey judgement
// Pass 3: verifier confirms or rejects every AI judgement finding
// ============================================================

import OpenAI, { AzureOpenAI } from "openai";
import type {
  AccessibilityIssue,
  AuditConfig,
  AuditResult,
  TestLogEntry,
} from "../types/audit";
import type {
  DarkPatternCategory,
  DarkPatternFinding,
  DarkPatternResult,
  EthicalPrinciple,
} from "../types/darkpattern";
import type {
  PrivacyFinding,
  PrivacyFindingCategory,
  PrivacyRegulation,
  PrivacyResult,
} from "../types/privacy";
import type { AuditPillar } from "../types/trustscore";
import { calculateScore } from "./scoring";
import { generateReport } from "./report-generator";
import type { PillarContext } from "./report-generator";
import { calculateTrustScore } from "./trust-scoring";
import { buildResult as buildDarkPatternResult } from "./pdf-analyzer";
import { DARK_PATTERN_RULES } from "./darkpattern-rules";
import { setAuditSync as storeSetSync } from "../store/audit-store";
import { callClaudeVision, CLAUDE_MOBILE_MODEL } from "./mobile-claude-provider";
import {
  annotatedCrop,
  screenThumbnail,
  decodeImage,
  deviceScale,
  isMeasurementAvailable,
  runPermissionRules,
  runPriceRules,
  runConsumerTextRules,
  runScreenRules,
  canonicalComponent,
  componentOf,
  type Advisory,
  type Amount,
  type Box,
  type MeasuredFinding,
  type ScreenInventory,
  type UIElement,
} from "./mobile-rules";
import {
  accessibilityRefs,
  darkPatternRefs,
  formatRefs,
  privacyRefs,
  type JurisdictionRefs,
} from "./mobile-regulation-map";

export type MobilePlatform = "android" | "ios" | "unknown";
type MobilePillar = "accessibility" | "darkpatterns" | "privacy";

export interface MobileScreen {
  base64: string;
  mimeType: string;
  label: string;
  width: number;
  height: number;
}

export interface MobileAppMeta {
  appName: string;
  platform: MobilePlatform;
  appVersion?: string;
  device?: string;
  captureDate?: string;
  highAssurance?: boolean;
  deviceWidthDp?: number;
}

const PROMPT_VERSION = "mobile-p2.2";

const MOBILE_PILLARS: MobilePillar[] = [
  "accessibility",
  "darkpatterns",
  "privacy",
];

/** Checks that need the app binary or a real device — reported as "not tested" */
export const MOBILE_NOT_TESTED = [
  "Screen reader labels (TalkBack / VoiceOver) and focus order",
  "Dynamic type / font scaling and orientation changes",
  "Network calls, SDKs and third-party trackers inside the app",
  "Runtime performance (startup time, jank, memory, battery)",
  "Declared permissions in AndroidManifest / Info.plist",
];

// ════════════════════════════════════════════════════════════
// AI providers
// Engagement mode (MOBILE_AUDIT_MODE=engagement) only allows
// providers whose API terms exclude training on customer data.
// ════════════════════════════════════════════════════════════
interface ProviderDef {
  id: string;
  label: string;
  clientSafe: boolean;
  available: () => boolean;
  kind: "claude" | "azure" | "openai-compatible";
  envKey?: string;
  baseURL?: string;
  model: () => string;
}

const PROVIDERS: Record<string, ProviderDef> = {
  claude: {
    id: "claude",
    label: "Anthropic Claude",
    clientSafe: true,
    kind: "claude",
    available: () => Boolean(process.env.ANTHROPIC_API_KEY),
    model: () => CLAUDE_MOBILE_MODEL,
  },
  azure: {
    id: "azure",
    label: "Azure OpenAI",
    clientSafe: true,
    kind: "azure",
    available: () =>
      Boolean(
        process.env.AZURE_OPENAI_API_KEY &&
          process.env.AZURE_OPENAI_ENDPOINT &&
          process.env.AZURE_OPENAI_DEPLOYMENT,
      ),
    model: () => process.env.AZURE_OPENAI_DEPLOYMENT || "",
  },
  openai: {
    id: "openai",
    label: "OpenAI API",
    clientSafe: true,
    kind: "openai-compatible",
    envKey: "OPENAI_API_KEY",
    available: () => Boolean(process.env.OPENAI_API_KEY),
    model: () => process.env.MOBILE_AUDIT_OPENAI_MODEL || "gpt-4o",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    clientSafe: false,
    kind: "openai-compatible",
    envKey: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    available: () => Boolean(process.env.OPENROUTER_API_KEY),
    model: () => "openai/gpt-4o",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini (free tier)",
    clientSafe: false,
    kind: "openai-compatible",
    envKey: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    available: () => Boolean(process.env.GEMINI_API_KEY),
    model: () => "gemini-3.5-flash",
  },
  // Lighter Gemini model — used when the main one is rate-limited or overloaded
  geminiLite: {
    id: "gemini-lite",
    label: "Google Gemini Lite (free tier)",
    clientSafe: false,
    kind: "openai-compatible",
    envKey: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    available: () => Boolean(process.env.GEMINI_API_KEY),
    model: () => "gemini-3.5-flash-lite",
  },
};

export const isEngagementMode = () =>
  (process.env.MOBILE_AUDIT_MODE || "").toLowerCase() === "engagement";

function activeProviders(): ProviderDef[] {
  const order = isEngagementMode()
    ? ["azure", "claude", "openai"]
    : ["claude", "azure", "openai", "openrouter", "gemini", "geminiLite"];
  return order
    .map((k) => PROVIDERS[k])
    .filter((p) => p.available() && (!isEngagementMode() || p.clientSafe));
}

export function hasVisionProvider(): boolean {
  return activeProviders().length > 0;
}

/** Human-readable reason when no provider can be used */
export function providerSetupError(): string {
  if (isEngagementMode()) {
    return "Engagement mode requires a client-safe AI provider (no training on your data): set ANTHROPIC_API_KEY, OPENAI_API_KEY, or AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_DEPLOYMENT. Free Gemini / OpenRouter keys are not allowed for client screenshots.";
  }
  return "An AI key is required for mobile app audits (ANTHROPIC_API_KEY, OPENAI_API_KEY, Azure OpenAI, OPENROUTER_API_KEY or GEMINI_API_KEY).";
}

// Free tiers rate-limit (429) or report overload (503) — wait and retry
// Generous waits before falling back to a lighter model
const RETRY_DELAYS_MS = [10000, 30000, 60000];
const isRetryable = (err: unknown) =>
  [429, 500, 503, 529].includes((err as { status?: number })?.status ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quotaCooldownUntil = new Map<string, number>();

interface VisionImage {
  base64: string;
  mimeType: string;
  detail: "low" | "high";
}

async function callProvider(
  p: ProviderDef,
  system: string,
  prompt: string,
  images: VisionImage[],
): Promise<string> {
  if (p.kind === "claude") {
    return callClaudeVision(system, prompt, images);
  }
  const client =
    p.kind === "azure"
      ? new AzureOpenAI({
          apiKey: process.env.AZURE_OPENAI_API_KEY,
          endpoint: process.env.AZURE_OPENAI_ENDPOINT,
          deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
          apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
          maxRetries: 0,
          timeout: 180000,
        })
      : new OpenAI({
          apiKey: process.env[p.envKey || ""],
          baseURL: p.baseURL,
          maxRetries: 0,
          timeout: 180000,
        });
  const response = await client.chat.completions.create({
    model: p.model(),
    // Generous limit: newer models spend tokens on reasoning before the JSON
    max_tokens: 12000,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((img) => ({
            type: "image_url" as const,
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64}`,
              detail: img.detail,
            },
          })),
        ],
      },
    ],
  });
  return response.choices[0]?.message?.content || "{}";
}

async function callVision<T>(
  system: string,
  prompt: string,
  images: VisionImage[],
  usedProviders: Set<string>,
): Promise<T> {
  let lastError: unknown = new Error(providerSetupError());
  for (const p of activeProviders()) {
    // Daily/plan quota exhausted recently — don't spend ~100s retrying it on every call
    if ((quotaCooldownUntil.get(p.id) || 0) > Date.now()) continue;
    let badJson = 0;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const raw = await callProvider(p, system, prompt, images);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : "{}") as T;
        usedProviders.add(`${p.label} (${p.model()})`);
        return parsed;
      } catch (err) {
        lastError = err;
        // Malformed or truncated JSON: ask again once before moving on
        if (err instanceof SyntaxError && badJson++ < 1) {
          attempt--;
          continue;
        }
        const status = (err as { status?: number })?.status;
        if (status === 429 && /quota|billing|credits/i.test(err instanceof Error ? err.message : "")) {
          quotaCooldownUntil.set(p.id, Date.now() + 15 * 60 * 1000);
          break;
        }
        if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No vision AI provider available");
}

// ════════════════════════════════════════════════════════════
// Prompts
// ════════════════════════════════════════════════════════════
const SEVERITY_RUBRIC = `Severity rubric (apply consistently):
- critical: makes users pay, consent or share data they did not intend; or blocks a core task for disabled users; clear breach of a named regulation.
- high: materially steers or obstructs a user's choice, or seriously impairs access; likely regulatory exposure.
- medium: noticeable pressure or friction; possible regulatory exposure.
- low: best-practice gap with minor user impact.`;

const SYSTEM_PROMPT = `You are TrustLens AI, an expert auditor of mobile apps for accessibility (WCAG 2.2 AA), deceptive design (dark patterns) and privacy UX.
Report only what is actually visible in the screenshots. Never invent text, prices or elements. Quote visible text exactly.
${SEVERITY_RUBRIC}
Output a single JSON object only.`;

function platformGuidance(platform: MobilePlatform): string {
  if (platform === "android")
    return "Platform: Android (Material Design).";
  if (platform === "ios")
    return "Platform: iOS (Apple Human Interface Guidelines).";
  return "Platform: unknown — infer from the UI.";
}

// Compact rule catalogue so every AI finding maps to a known rule ID
const DP_RULE_LIST = DARK_PATTERN_RULES.map((r) => `${r.id}: ${r.title}`).join("\n");
const PRIVACY_RULE_LIST = [
  "MOB-PRIV-CONSENT (consent-mechanism): consent screen without an equal Reject/Manage option, bundled or unclear consent",
  "MOB-PRIV-PURPOSE (data-collection): personal data requested without a stated purpose",
  "MOB-PRIV-MINIMISATION (data-minimization): more personal data requested than the task needs",
  "MOB-PRIV-POLICY (privacy-policy): no visible privacy policy link where data is collected",
  "MOB-PRIV-SOCIAL-LOGIN (third-party-tracker): social login without data-sharing disclosure",
].join("\n");
const A11Y_JUDGEMENT_LIST = [
  "1.1.1 Non-text content: icon-only control with no visible label",
  "1.3.1 Info and relationships: form field without a visible label",
  "1.4.1 Use of colour: information conveyed by colour alone",
  "1.4.4 Resize text: text too small to read on a phone",
  "1.4.10 Reflow: truncated or clipped text",
  "2.4.6 Headings and labels: unclear or misleading labels",
  "3.3.1 / 3.3.3 Error identification / suggestion: unclear errors",
  "3.3.2 Labels or instructions: placeholder-only inputs",
].join("\n");

const MEASURED_NOTE_ON =
  "Do NOT report colour contrast, touch-target size or accept-vs-decline size asymmetry — TrustLens measures these from pixels.";
const MEASURED_NOTE_OFF =
  "Also report clear colour-contrast (1.4.3) and touch-target-size (2.5.8) problems.";

function screenPrompt(
  screen: MobileScreen,
  index: number,
  total: number,
  meta: MobileAppMeta,
  measuring: boolean,
  withAccessibility: boolean,
): string {
  return `Screen ${index + 1} of ${total} of the mobile app "${meta.appName || "Unnamed app"}" — label "${screen.label || `Screen ${index + 1}`}". ${platformGuidance(meta.platform)}

STEP 1 — UI inventory. List every visible text block and every control (tabs, chips, buttons, links, icons, checkboxes, inputs, cards that open something), plus all prices.
- box_2d: [ymin, xmin, ymax, xmax] normalised 0–1000, drawn TIGHTLY around the visible TEXT GLYPHS only (or the icon glyph for icon-only controls) — never around the surrounding chip, card or button background.
- tap_box_2d: for anything tappable, the WHOLE tappable region (the full chip, tab, card, row or button shape). Omit for plain text.
- component: short reusable component name, identical for every instance, e.g. "bottom tab bar item", "category chip", "product card title", "product card struck-out price", "add-to-cart button", "promo banner", "search field placeholder".
- role: primary-cta | accept | decline | close | skip | addon | consent | price | fine-print | permission-prompt | permission-rationale | privacy-link | logo | rating-prompt (a "rate us / how was your experience" prompt) | rating-star (list EACH star as its own element) | promo-banner | sponsored-label | fixed-bar (sticky tab bar / header / bottom sheet) | other.
- overlay: true for anything floating above the scrolling content (sticky tab bars, floating banners, modals, sheets).
- occluded: true for text that is partly covered, faded or cut off by an overlay, scrim or gradient.
- disabled: true for visibly inactive controls. in_image: true for text that is part of a product photo, illustration, artwork or brand logo.
- checked: true/false for checkboxes and toggles, otherwise null.
Also list every monetary amount with role: line-item | fee | addon | discount | total | pay-button | price | reference (a struck-out / "MRP" / was-price) | renewal. Numbers only in "value".
Also give "screen_title": a short name for this screen as a user would call it (e.g. "Home", "Cart", "Fruits & Vegetables").
${withAccessibility ? `
STEP 2 — Accessibility judgement findings only (WCAG 2.2), using these criteria:
${A11Y_JUDGEMENT_LIST}
${measuring ? MEASURED_NOTE_ON : MEASURED_NOTE_OFF}` : ""}

Respond with JSON:
{"screen_title":"...","elements":[{"id":"e1","type":"text|button|link|checkbox|toggle|input|icon|image","role":"other","component":"...","text":"exact visible text","box_2d":[0,0,0,0],"tap_box_2d":[0,0,0,0],"checked":null,"disabled":false,"in_image":false,"overlay":false,"occluded":false,"bold":false,"lines":1}],
 "amounts":[{"label":"...","value":0,"currency":"₹","role":"...","elementId":"e1"}],
 "findings":[{"pillar":"accessibility","ruleId":"1.1.1","title":"short title naming the component","description":"what is wrong, quoting visible text","elementId":"e1","component":"...","severity":"critical|high|medium|low","recommendation":"concrete fix","developerFix":"implementation fix","designerFix":"design fix"}]}`;
}

// Consumer-protection review: deceptive design + privacy UX, focused on shopping /
// consumer apps (India CCPA 2023 specified patterns, EU DSA/UCPD/Omnibus, US FTC)
const CONSUMER_CHECKLIST = `Check EVERY item; report each one that is present (as a "signal" with lower confidence when it depends on facts you cannot see, e.g. whether a reference price is genuine):
1. Persistent promotional banners, coupons or cashback bars that overlay or hide content, or reappear on every screen (DP-NG-01, DP-NG-04).
2. Rating/feedback, notification or app-review prompts that interrupt browsing before a task is complete (DP-NG-01, DP-NG-02).
3. Struck-out "original"/reference prices, "% off" or "MRP" claims shown without a basis (DP-MD-08). EU Omnibus: the prior price must be the lowest in the last 30 days.
4. Sponsored, paid, brand-partner or "Featured / Member's pick / Powered by" placements without a clear "Ad"/"Sponsored" label (DP-MD-05, DP-DA-01).
5. Default selections: pre-selected tips, donations, add-ons, insurance, faster delivery, membership trials, or opted-in marketing (DP-SN-01, DP-SN-02, DP-SN-06).
6. Fees: delivery, handling, platform, packaging, small-cart, surge or convenience fees not shown with the first price (DP-SN-07, DP-PM-04, DP-HC-01).
7. Urgency and scarcity: countdowns, "only X left", "selling fast", limited-time offers without an end date (DP-SU-01, DP-SU-02, DP-SU-03, DP-SU-05, DP-FS-01).
8. Unverifiable social proof: "bestseller", "#1", "X bought today", ratings without source (DP-SP-01, DP-SP-03, DP-SP-04).
9. Membership / subscription upsells, free trials that convert, auto-renewal, cancellation friction (DP-SN-09, DP-FA-04, DP-PM-03, DP-OB-06).
10. Confirmshaming or guilt copy on decline options (DP-CS-01, DP-CS-02).
11. Forced login, phone-number or app-install gates before browsing or seeing prices (DP-FA-01, DP-FA-03, DP-FA-07).
12. Interface interference: hidden or tiny close buttons, decoy options, the wanted option visually suppressed (DP-IF-04, DP-MD-09, DP-IF-08, DP-PM-02).
13. Privacy UX: permission requests without a reason, data requested without purpose, consent without an equal reject, missing privacy link where data is collected (MOB-PRIV-*).`;

function consumerPrompt(
  screen: MobileScreen,
  index: number,
  total: number,
  meta: MobileAppMeta,
  pillars: MobilePillar[],
  inventoryText: string,
): string {
  return `Consumer-protection review of screen ${index + 1} of ${total} of the mobile app "${meta.appName || "Unnamed app"}" — label "${screen.label || `Screen ${index + 1}`}". ${platformGuidance(meta.platform)}
Visible text extracted from this screen: ${inventoryText || "(none)"}

${CONSUMER_CHECKLIST}

Report only these pillars: ${pillars.join(", ")}. Use one rule ID from:
${pillars.includes("darkpatterns") ? DP_RULE_LIST : ""}
${pillars.includes("privacy") ? PRIVACY_RULE_LIST : ""}

Answer EVERY checklist item 1–13 explicitly in "checklist" (present true/false with the evidence you looked at) before writing findings — do not skip items. Then add one finding per item that is present.
Group repeated instances: if the same pattern appears on several elements of the same component (e.g. every product card's struck-out price), report it ONCE with "component" set and the examples quoted in the description. Use "component" for the reusable component, never the specific text (e.g. "category chip", not "category chip cafe").
Respond with JSON:
{"checklist":[{"item":1,"present":false,"evidence":"what you checked"}],
 "findings":[{"pillar":"darkpatterns|privacy","ruleId":"DP-MD-08","title":"short title naming the pattern","description":"what is wrong, quoting visible text","component":"product struck-out price","elementId":"e1","severity":"critical|high|medium|low","signal":false,"recommendation":"concrete fix","developerFix":"implementation fix","designerFix":"design fix"}]}
If no item is present, return the checklist with "findings":[].`;
}

interface InventoryForPrompt {
  label: string;
  elements: { id: string; role?: string; text?: string; checked?: boolean | null }[];
  amounts: Amount[];
}

function journeyPrompt(
  inventories: InventoryForPrompt[],
  meta: MobileAppMeta,
  pillars: MobilePillar[],
): string {
  const summary = inventories
    .map(
      (inv, i) =>
        `Screen ${i + 1} "${inv.label}": ${inv.elements
          .filter((e) => e.text)
          .slice(0, 25)
          .map((e) => `[${e.role || "other"}${e.checked ? ",checked" : ""}] ${e.text}`)
          .join(" | ")}${inv.amounts.length ? ` || amounts: ${inv.amounts.map((a) => `${a.role} ${a.label}=${a.currency || ""}${a.value}`).join(", ")}` : ""}`,
    )
    .join("\n");
  return `The images are an ordered user journey through the mobile app "${meta.appName || "Unnamed app"}". ${platformGuidance(meta.platform)}
Extracted text per screen:
${summary}

Report ONLY issues that need MORE THAN ONE screen to see (every finding must list at least 2 screen numbers). Examples: price or terms that change between screens, a "free" offer that becomes paid later, a cancel path longer than the sign-up path, repeated prompts (nagging), forced registration mid-journey, permission or data requested before the purpose is explained.
Use rule IDs from:
${pillars.includes("darkpatterns") ? DP_RULE_LIST : ""}
${pillars.includes("privacy") ? PRIVACY_RULE_LIST : ""}

Also state whether, anywhere in the journey, a consent screen and a privacy policy link are visible.
Respond with JSON: {"hasConsentScreen":false,"hasPrivacyPolicy":false,"findings":[{"pillar":"darkpatterns|privacy","ruleId":"...","title":"...","description":"...","severity":"critical|high|medium|low","recommendation":"...","screens":[1,3]}]}`;
}

function verifyPrompt(
  candidates: { id: string; ruleId: string; title: string; description: string; screens: number[] }[],
): string {
  return `You are a second, independent reviewer. For each candidate finding below, look at the screenshot(s) and decide whether the issue is genuinely present and correctly described. Reject anything that is not visible, is speculative, misquotes text, or does not match the rule.
${candidates.map((c) => `- id ${c.id} | rule ${c.ruleId} | screens ${c.screens.map((s) => s + 1).join(",")} | ${c.title}: ${c.description}`).join("\n")}

Respond with JSON: {"verdicts":[{"id":"...","verdict":"confirm|reject","confidence":"high|medium|low","reason":"one sentence"}]}`;
}

// ════════════════════════════════════════════════════════════
// Mapping helpers
// ════════════════════════════════════════════════════════════
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];
const SEV_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const CONF_RANK = { high: 3, medium: 2, low: 1 } as const;
type Confidence = keyof typeof CONF_RANK;
const toSeverity = (s?: string): Severity =>
  (SEVERITIES as readonly string[]).includes(s || "") ? (s as Severity) : "medium";

const PRINCIPLE_BY_CATEGORY: Record<DarkPatternCategory, EthicalPrinciple> = {
  "interface-interference": "symmetry-of-choice",
  obstruction: "user-autonomy",
  sneaking: "transparency",
  "forced-action": "user-autonomy",
  nagging: "user-autonomy",
  "scarcity-urgency": "user-autonomy",
  "social-pressure": "user-autonomy",
  "privacy-zuckering": "informed-consent",
  confirmshaming: "user-autonomy",
  misdirection: "transparency",
};

const PRIVACY_RULE_CATEGORY: Record<string, PrivacyFindingCategory> = {
  "MOB-PRIV-CONSENT": "consent-mechanism",
  "MOB-PRIV-PURPOSE": "data-collection",
  "MOB-PRIV-MINIMISATION": "data-minimization",
  "MOB-PRIV-POLICY": "privacy-policy",
  "MOB-PRIV-SOCIAL-LOGIN": "third-party-tracker",
  "MOB-PRIV-PERMISSION-RATIONALE": "data-collection",
};

const MEASURED_WCAG = ["1.4.3", "1.4.11", "2.5.8", "2.5.5"];
// Need a device (rotation, zoom, font scaling, focus, gestures) — matches "Requires device" in the WCAG matrix
const DEVICE_ONLY_WCAG = ["1.3.4", "1.4.4", "1.4.10", "1.4.12", "2.2.2", "2.4.3", "2.4.7", "2.4.11", "2.5.1", "4.1.3"];
const WCAG_AAA = ["2.5.5", "1.4.6"];

function wcagCategory(wcag: string): "perceivable" | "operable" | "understandable" | "robust" {
  const principle = wcag.trim().charAt(0);
  if (principle === "2") return "operable";
  if (principle === "3") return "understandable";
  if (principle === "4") return "robust";
  return "perceivable";
}

const screenName = (s: MobileScreen, i: number) => `Screen ${i + 1} — ${s.label || "Untitled"}`;

/** A finding in a provider-neutral shape before conversion to TrustLens types */
interface Candidate extends MeasuredFinding {
  id: string;
  source: "measured" | "ai";
  verification?: string;
  /** Not a violation from a screenshot — listed in advisories (e.g. icon names) */
  advisory?: boolean;
}

interface RawAIFinding {
  pillar?: string;
  ruleId?: string;
  title?: string;
  description?: string;
  elementId?: string;
  severity?: string;
  recommendation?: string;
  developerFix?: string;
  designerFix?: string;
  screens?: number[];
  component?: string;
  signal?: boolean;
}

interface Pass1Response {
  screen_title?: string;
  elements?: (Partial<UIElement> & { box_2d?: number[]; tap_box_2d?: number[]; in_image?: boolean })[];
  amounts?: Partial<Amount>[];
  findings?: RawAIFinding[];
}

function normaliseInventory(raw: Pass1Response): ScreenInventory {
  const elements: UIElement[] = [];
  for (const [i, e] of (raw.elements || []).entries()) {
    const b = Array.isArray(e.box_2d) ? e.box_2d : Array.isArray(e.box) ? e.box : null;
    if (!b || b.length !== 4 || b.some((v) => typeof v !== "number")) continue;
    const box = b.map((v) => Math.max(0, Math.min(1000, v))) as Box;
    if (box[2] <= box[0] || box[3] <= box[1]) continue;
    const tb = e.tap_box_2d;
    const tap =
      Array.isArray(tb) && tb.length === 4 && tb.every((v) => typeof v === "number")
        ? (tb.map((v) => Math.max(0, Math.min(1000, v))) as Box)
        : undefined;
    elements.push({
      id: String(e.id || `e${i + 1}`),
      type: (e.type || "text") as UIElement["type"],
      role: e.role,
      text: e.text,
      box,
      tapBox: tap && tap[2] > tap[0] && tap[3] > tap[1] ? tap : undefined,
      component: typeof e.component === "string" ? e.component.slice(0, 60) : undefined,
      disabled: !!e.disabled,
      inImage: !!e.in_image || !!e.inImage,
      overlay: !!e.overlay,
      occluded: !!e.occluded,
      checked: typeof e.checked === "boolean" ? e.checked : undefined,
      bold: !!e.bold,
      lines: Number(e.lines) || 1,
    });
  }
  const amounts: Amount[] = (raw.amounts || [])
    .filter((a) => typeof a.value === "number" && isFinite(a.value) && a.role)
    .map((a) => ({
      label: String(a.label || ""),
      value: Number(a.value),
      currency: a.currency,
      role: a.role as Amount["role"],
      elementId: a.elementId,
    }));
  return { elements, amounts };
}

// WCAG 2.2 success criterion names — used to give judgement findings a stable, groupable title
const SC_NAME: Record<string, string> = {
  "1.1.1": "Non-text content", "1.3.1": "Info and relationships", "1.4.1": "Use of colour",
  "1.4.4": "Resize text", "1.4.10": "Reflow", "2.4.6": "Headings and labels",
  "3.3.1": "Error identification", "3.3.2": "Labels or instructions", "3.3.3": "Error suggestion", "4.1.2": "Name, role, value",
};

/** Removes the element's own text from a component name ("category chip cafe" → "category chip") */
function stripElementText(component: string | undefined, text: string | undefined): string | undefined {
  if (!component) return component;
  if (!text) return component;
  const words = new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const kept = component.split(" ").filter((w) => !words.has(w));
  return kept.length ? kept.join(" ") : component;
}

/** Removes internal element IDs ("(e16)") and overstated legal wording from AI text shown to clients */
function clientText(s: string): string {
  return s
    .replace(/\s*\((?:e|el|element\s*)\d+\)/gi, "")
    .replace(/\b(element\s+)?e\d+\b/gi, "")
    .replace(/\bany regulatory basis\b/gi, "a stated basis")
    .replace(/\bregulatory basis\b/gi, "stated basis")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

/** "Strikethrough Reference Prices Without Basis" → "Strikethrough reference prices without basis" */
function sentenceCase(s: string): string {
  const words = s.split(" ");
  const capped = words.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  if (words.length < 3 || capped < words.length * 0.6) return s;
  return words.map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(" ");
}

function aiToCandidate(
  raw: RawAIFinding,
  screens: number[],
  inv: ScreenInventory | undefined,
  pillars: MobilePillar[],
  measuring: boolean,
  id: string,
): Candidate | null {
  const pillar = raw.pillar as MobilePillar;
  if (!pillars.includes(pillar)) return null;
  let ruleId = (raw.ruleId || "").trim();
  // DP-NG-02 is a notification-permission prompt; a rating/review prompt is DP-NG-01
  if (ruleId === "DP-NG-02" && /rating|review|feedback|experience/i.test(`${raw.title} ${raw.description}`)) ruleId = "DP-NG-01";
  let wcag = pillar === "accessibility" ? ruleId.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
  // "Placeholder instead of a label" is one issue (SC 3.3.2), however the AI files it — report it once
  if (wcag && ["1.3.1", "2.4.6", "3.3.2"].includes(wcag) && /placeholder/i.test(`${raw.title} ${raw.description} ${raw.component || ""}`)) wcag = "3.3.2";
  if (pillar === "accessibility") {
    if (!wcag) return null;
    if (measuring && MEASURED_WCAG.includes(wcag)) return null; // measured instead
    // Reflow, orientation, resize, text spacing etc. cannot be judged from one screenshot
    if (DEVICE_ONLY_WCAG.includes(wcag)) return null;
  }
  const el = inv?.elements.find((e) => e.id === raw.elementId);
  const component = stripElementText(raw.component ? canonicalComponent(raw.component) : el ? componentOf(el) : undefined, el?.text);
  // A screenshot cannot show whether an icon has a VoiceOver/TalkBack name — never assert it
  const iconName =
    pillar === "accessibility" &&
    (wcag === "1.1.1" || wcag === "4.1.2") &&
    (!el?.text?.trim() || el?.type === "icon" || /icon|accessib(le|ility) (label|name)|screen reader/i.test(`${raw.title} ${raw.description}`));
  // Placeholder-only search fields are commonly accepted with a search icon — judgement call
  const placeholderOnly = wcag === "3.3.2" && /placeholder/i.test(`${raw.title} ${raw.description}`);
  return {
    id,
    source: "ai",
    pillar,
    ruleId: wcag || ruleId,
    wcag,
    title:
      pillar === "accessibility"
        ? iconName
          ? `Icon-only control — verify accessible name on device — ${component || "icon button"}`
          : `${SC_NAME[wcag!] || raw.title || "Accessibility issue"} — ${component || "screen"}`
        : sentenceCase(clientText(raw.title || "Mobile UI issue")),
    description: clientText(raw.description || ""),
    severity: placeholderOnly ? "low" : toSeverity(raw.severity),
    // "signal" = depends on facts not visible in the screenshot → needs auditor review
    confidence: raw.signal || placeholderOnly ? "low" : "medium",
    screens,
    elementId: el?.id,
    box: el?.tapBox || el?.box,
    component,
    elementText: el?.text?.trim(),
    measurements: el?.text ? { element: el.text.slice(0, 120) } : {},
    recommendation: clientText(raw.recommendation || ""),
    // SC 3.3.2 is about visible labels; a screen-reader label alone (4.1.2) does not satisfy it
    developerFix: placeholderOnly
      ? "Keep a visible label or hint (e.g. \"Search\") that stays on screen while the user types, instead of relying on placeholder text."
      : raw.developerFix,
    designerFix: raw.designerFix,
    advisory: iconName || undefined,
  };
}

/**
 * Collapses repeated dark-pattern / privacy findings that share a rule and a
 * component (e.g. struck-out prices on every product card, a banner on every
 * screen) into one root-cause finding listing every screen it appears on.
 */
function groupByRootCause(list: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const rest: Candidate[] = [];
  for (const c of list) {
    if (c.pillar === "accessibility") {
      rest.push(c);
      continue;
    }
    // Same rule = same pattern: struck-out prices or a banner seen on several screens is one root cause
    const key = `${c.pillar}|${c.ruleId}`;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  for (const g of groups.values()) {
    if (g.length === 1) {
      rest.push(g[0]);
      continue;
    }
    // Measured (rule-based) wording leads: it is consistent across runs and states its own basis
    g.sort((a, b) => Number(b.source === "measured") - Number(a.source === "measured") || SEV_RANK[b.severity] - SEV_RANK[a.severity] || CONF_RANK[b.confidence] - CONF_RANK[a.confidence]);
    const lead = g[0];
    const screensAll = [...new Set(g.flatMap((c) => c.screens))].sort((a, b) => a - b);
    // Text that belongs to another rule's finding (e.g. the cashback banner) is not evidence for this one
    const otherTexts = new Set(list.filter((c) => c.ruleId !== lead.ruleId).map((c) => c.elementText).filter(Boolean));
    const examples = [...new Set(g.map((c) => c.elementText).filter((t): t is string => !!t && !otherTexts.has(t)))]
      .flatMap((t) => t.split(", "))
      // A bare number ("95") without currency or label is not readable evidence
      .filter((t, i, arr) => arr.indexOf(t) === i && !/^\d+([.,]\d+)?$/.test(t.trim()))
      .slice(0, 6);
    rest.push({
      ...lead,
      screens: screensAll,
      description: `${lead.description}${examples.length > 1 ? ` Examples: ${examples.map((e) => `"${e}"`).join(", ")}.` : ""} Seen on ${screensAll.length} screen(s): ${screensAll.map((s) => s + 1).join(", ")}.`,
      measurements: { ...lead.measurements, screens: screensAll.map((s) => s + 1).join(", ") },
      // Repeated independent sightings raise confidence one step
      confidence: lead.confidence === "low" && g.length >= 3 ? "medium" : lead.confidence,
    });
  }
  return rest;
}

function dedupeKey(c: Candidate): string {
  const anchor = c.box ? c.box.map((v) => Math.round(v / 60)).join(",") : c.elementId || "";
  return `${c.pillar}|${c.ruleId}|${c.screens.join(",")}|${anchor}`;
}

function mergeCandidates(list: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const c of list) {
    const key = dedupeKey(c);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    // Prefer measured evidence, then higher severity, then higher confidence
    const better =
      (c.source === "measured" && prev.source !== "measured") ||
      (c.source === prev.source &&
        (SEV_RANK[c.severity] > SEV_RANK[prev.severity] ||
          (SEV_RANK[c.severity] === SEV_RANK[prev.severity] &&
            CONF_RANK[c.confidence] > CONF_RANK[prev.confidence])));
    if (better) byKey.set(key, c);
  }
  // Same rule + same screen from AI twice with different anchors → keep one
  const seen = new Set<string>();
  return [...byKey.values()].filter((c) => {
    if (c.source !== "ai") return true;
    const k = `${c.pillar}|${c.ruleId}|${c.screens.join(",")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function refsFor(c: Candidate): JurisdictionRefs {
  if (c.pillar === "accessibility") return accessibilityRefs(c.wcag || c.ruleId);
  if (c.pillar === "darkpatterns") {
    const rule = DARK_PATTERN_RULES.find((r) => r.id === c.ruleId);
    return darkPatternRefs(c.ruleId, (rule?.category || c.category || "interface-interference") as DarkPatternCategory);
  }
  return privacyRefs(PRIVACY_RULE_CATEGORY[c.ruleId] || (c.category as PrivacyFindingCategory) || "data-collection");
}

const confidenceLabel = (c: Candidate) =>
  c.source === "measured"
    ? c.confidence === "high"
      ? "Measured from screenshot pixels"
      : "Measured (estimated element bounds)"
    : c.confidence === "low"
      ? "AI judgement (lower confidence)"
      : `AI judgement confirmed by independent verifier${c.verification ? ` (${c.verification})` : ""}`;

const measurementText = (m: Record<string, string | number>) =>
  Object.entries(m)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");

// ════════════════════════════════════════════════════════════
// Main runner
// ════════════════════════════════════════════════════════════
export async function runMobileAppAudit(
  auditId: string,
  screens: MobileScreen[],
  meta: MobileAppMeta,
  requestedPillars: string[],
): Promise<void> {
  // "first club" → "First Club" when the name was typed all lower-case (used everywhere in the report)
  if (meta.appName && meta.appName === meta.appName.toLowerCase()) {
    meta = { ...meta, appName: meta.appName.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) };
  }
  const pillars = MOBILE_PILLARS.filter((p) => requestedPillars.includes(p));
  const enabledPillars = (pillars.length ? pillars : MOBILE_PILLARS) as MobilePillar[];
  const usedProviders = new Set<string>();

  const config: AuditConfig = {
    type: "mobile-app",
    crawlDepth: 0,
    maxPages: screens.length,
    includeAI: true,
    wcagLevels: ["A", "AA"],
    standard: "WCAG 2.2",
    enabledPillars: enabledPillars as AuditPillar[],
    mobileApp: {
      appName: meta.appName,
      platform: meta.platform,
      screens: screens.map((s) => ({ label: s.label, width: s.width, height: s.height })),
      appVersion: meta.appVersion,
      device: meta.device,
      captureDate: meta.captureDate,
      engagementMode: isEngagementMode(),
      highAssurance: !!meta.highAssurance,
      deviceWidthDp: meta.deviceWidthDp,
      promptVersion: PROMPT_VERSION,
    },
  };

  const audit: AuditResult = {
    id: auditId,
    config,
    status: "analyzing",
    progress: 5,
    progressMessage: `Mobile app audit starting — ${screens.length} screen(s) queued…`,
    pages: screens.map((s, i) => ({
      url: screenName(s, i),
      title: screenName(s, i),
      html: "",
      // Full screenshot stored once; findings carry small annotated crops only
      screenshot: s.base64,
      timestamp: new Date().toISOString(),
    })),
    issues: [],
    score: calculateScore([], 0),
    testResults: [],
    testLog: [],
    inapplicableCriteria: [],
    startedAt: new Date().toISOString(),
  };
  // Save before any await: the results page polls this ID immediately
  storeSetSync(auditId, audit);
  const measuring = await isMeasurementAvailable();
  config.mobileApp!.pixelMeasurement = measuring;

  const log = (
    testId: string,
    message: string,
    pillar: MobilePillar = "accessibility",
    status: TestLogEntry["status"] = "running",
  ) => {
    audit.testLog.push({
      timestamp: new Date().toISOString(),
      testId,
      testName: "Mobile App Audit",
      wcag: "",
      status,
      message,
      pillar,
      methodology: `Mobile App Audit ${PROMPT_VERSION}`,
    });
  };
  const progress = (p: number, msg: string) => {
    audit.progress = p;
    audit.progressMessage = msg;
    storeSetSync(auditId, audit);
  };

  let seq = 0;
  const nextId = () => `mob-${++seq}`;

  try {
    log(
      "MOB-START",
      `━━━ Mobile App Audit "${meta.appName || "Unnamed app"}" · ${meta.platform} · ${screens.length} screen(s) · ${enabledPillars.join(", ")} · ${isEngagementMode() ? "ENGAGEMENT mode" : "standard mode"}${meta.highAssurance ? " · high assurance" : ""} · pixel measurement ${measuring ? "on" : "unavailable"}`,
    );

    // ── Pass 1a: UI inventory + accessibility judgement (3 screens in parallel) ──
    // ── Pass 1b: dedicated consumer-protection review (dark patterns + privacy) ──
    const inventories: ScreenInventory[] = screens.map(() => ({ elements: [], amounts: [] }));
    const aiCandidates: Candidate[] = [];
    let failed = 0;
    let lastFailure = "";
    let done = 0;
    const BATCH = 3;
    const runs = meta.highAssurance ? 2 : 1;
    const consumerPillars = enabledPillars.filter((p) => p !== "accessibility");
    const categoryOf = (ruleId: string) =>
      DARK_PATTERN_RULES.find((r) => r.id === ruleId)?.category || PRIVACY_RULE_CATEGORY[ruleId] || ruleId.slice(0, 5);

    const screenTitles: (string | undefined)[] = [];
    for (let start = 0; start < screens.length; start += BATCH) {
      await Promise.all(
        screens.slice(start, start + BATCH).map(async (screen, j) => {
          const idx = start + j;
          try {
            const inv = await callVision<Pass1Response>(
              SYSTEM_PROMPT,
              screenPrompt(screen, idx, screens.length, meta, measuring, enabledPillars.includes("accessibility")),
              [{ base64: screen.base64, mimeType: screen.mimeType, detail: "high" }],
              usedProviders,
            );
            inventories[idx] = normaliseInventory(inv);
            // Named after all screens finish, in journey order (screens run in parallel)
            screenTitles[idx] = inv.screen_title?.trim().slice(0, 56);
            const a11y = (inv.findings || [])
              .map((f) => aiToCandidate(f, [idx], inventories[idx], ["accessibility"], measuring, nextId()))
              .filter((c): c is Candidate => c !== null);
            aiCandidates.push(...a11y);

            let consumerCount = 0;
            let unstable = 0;
            if (consumerPillars.length) {
              const inventoryText = inventories[idx].elements
                .filter((e) => e.text)
                .slice(0, 60)
                .map((e) => `[${e.id} ${componentOf(e)}${e.checked ? ", checked" : ""}] ${e.text}`)
                .join(" | ");
              const responses: { findings?: RawAIFinding[] }[] = [];
              for (let r = 0; r < runs; r++) {
                responses.push(
                  await callVision<{ findings?: RawAIFinding[] }>(
                    SYSTEM_PROMPT,
                    consumerPrompt(screen, idx, screens.length, meta, consumerPillars, inventoryText),
                    [{ base64: screen.base64, mimeType: screen.mimeType, detail: "high" }],
                    usedProviders,
                  ),
                );
              }
              const first = (responses[0].findings || [])
                .map((f) => aiToCandidate(f, [idx], inventories[idx], consumerPillars, measuring, nextId()))
                .filter((c): c is Candidate => c !== null);
              // High assurance: keep findings whose pattern category appears in both runs
              // High assurance: keep the union of both runs (better recall); patterns found in
              // only one run are marked "Needs review" instead of being dropped
              let kept = first;
              if (runs === 2) {
                const second = (responses[1].findings || [])
                  .map((f) => aiToCandidate(f, [idx], inventories[idx], consumerPillars, measuring, nextId()))
                  .filter((c): c is Candidate => c !== null);
                const inBoth = (c: Candidate, other: Candidate[]) => other.some((o) => categoryOf(o.ruleId) === categoryOf(c.ruleId));
                kept = [
                  ...first.map((c) => (inBoth(c, second) ? c : { ...c, confidence: "low" as const })),
                  ...second.filter((c) => !inBoth(c, first)).map((c) => ({ ...c, confidence: "low" as const })),
                ];
                unstable = kept.filter((c) => c.confidence === "low").length;
              }
              consumerCount = kept.length;
              aiCandidates.push(...kept);
            }
            log(
              `MOB-SCREEN-${idx + 1}`,
              `  ✓ ${screenName(screen, idx)}: ${inventories[idx].elements.length} element(s), ${inventories[idx].amounts.length} amount(s), ${a11y.length} accessibility + ${consumerCount} consumer-protection AI finding(s)${runs === 2 ? ` (${unstable} seen in one run only — needs review)` : ""}`,
              "accessibility",
              "pass",
            );
          } catch (err) {
            failed++;
            lastFailure = err instanceof Error ? err.message : "Unknown error";
            log(`MOB-SCREEN-${idx + 1}`, `  ⚠ ${screenName(screen, idx)} analysis failed: ${lastFailure}`, "accessibility", "fail");
          }
          done++;
          progress(5 + Math.round((done / screens.length) * 45), `Analysed ${done} of ${screens.length} screen(s)…`);
        }),
      );
    }

    // Camera-roll names (IMG_9855, Screenshot 2026-…) say nothing in a report — use the screen's own title.
    // Same title twice is usually the same screen scrolled further: "Home", then "Home (part 2)"
    const titleUses = new Map<string, number>();
    screens.forEach((screen, idx) => {
      const base = screenTitles[idx];
      if (!base || !/^(img|image|screenshot|screen ?shot|pxl|dsc|photo|whatsapp image|recording @)[\s_-]*[\d.@\s-]*/i.test(screen.label)) return;
      const n = (titleUses.get(base) || 0) + 1;
      titleUses.set(base, n);
      screen.label = n > 1 ? `${base} (part ${n})` : base;
      audit.pages[idx].url = audit.pages[idx].title = screenName(screen, idx);
    });

    // Every screen failed (e.g. invalid API key) — don't report a clean result
    if (failed === screens.length) {
      throw new Error(`Vision AI could not analyse any screen. Check the AI API key in .env.local. Last error: ${lastFailure}`);
    }

    // ── Deterministic rules on real pixels and extracted data ──
    progress(55, "Measuring contrast, touch targets and prices…");
    const measured: Candidate[] = [];
    const advisories: Advisory[] = [];
    for (let i = 0; i < screens.length; i++) {
      const img = measuring ? await decodeImage(screens[i].base64) : null;
      const scale = deviceScale(meta.platform, screens[i].width || img?.width || 1080, screens[i].height || img?.height || 2340, meta.deviceWidthDp);
      const found = runScreenRules(i, inventories[i], img, meta.platform, scale, advisories).filter((f) => enabledPillars.includes(f.pillar));
      measured.push(...found.map((f) => ({ ...f, id: nextId(), source: "measured" as const })));
    }
    const journeyRules = [
      ...(enabledPillars.includes("darkpatterns") ? [...runPriceRules(inventories), ...runConsumerTextRules(inventories)] : []),
      ...(enabledPillars.includes("privacy") ? runPermissionRules(inventories) : []),
    ];
    measured.push(...journeyRules.map((f) => ({ ...f, id: nextId(), source: "measured" as const })));
    log("MOB-MEASURE", `  ✓ Deterministic checks: ${measured.length} measured finding(s), ${advisories.length} advisory observation(s)`, "accessibility", "pass");

    // ── Pass 2: cross-screen journey ──
    let hasConsentScreen = false;
    let hasPrivacyPolicy = inventories.some((inv) => inv.elements.some((e) => e.role === "privacy-link"));
    const journeyPillars = enabledPillars.filter((p) => p !== "accessibility");
    if (screens.length > 1 && journeyPillars.length) {
      progress(65, "Analysing the full journey across screens…");
      try {
        const journey = await callVision<{ hasConsentScreen?: boolean; hasPrivacyPolicy?: boolean; findings?: RawAIFinding[] }>(
          SYSTEM_PROMPT,
          journeyPrompt(
            inventories.map((inv, i) => ({ label: screens[i].label, elements: inv.elements, amounts: inv.amounts })),
            meta,
            journeyPillars,
          ),
          screens.map((s) => ({ base64: s.base64, mimeType: s.mimeType, detail: "low" as const })),
          usedProviders,
        );
        hasConsentScreen = Boolean(journey.hasConsentScreen);
        hasPrivacyPolicy = hasPrivacyPolicy || Boolean(journey.hasPrivacyPolicy);
        let crossScreen = 0;
        for (const f of journey.findings || []) {
          const idxs = [...new Set((Array.isArray(f.screens) ? f.screens : []).map((n) => Number(n) - 1).filter((n) => n >= 0 && n < screens.length))];
          // Single-screen issues are already covered by Pass 1 — skip duplicates
          if (idxs.length < 2) continue;
          const c = aiToCandidate(f, idxs, undefined, journeyPillars, measuring, nextId());
          if (c) {
            aiCandidates.push(c);
            crossScreen++;
          }
        }
        log("MOB-JOURNEY", `  ✓ Journey analysis: ${crossScreen} cross-screen finding(s)`, "darkpatterns", "pass");
      } catch (err) {
        log("MOB-JOURNEY", `  ⚠ Journey analysis failed: ${err instanceof Error ? err.message : "Unknown error"}`, "darkpatterns", "fail");
      }
    }

    // ── Pass 3: independent verifier for AI judgement findings ──
    progress(75, "Verifying AI findings with an independent review…");
    const groups = new Map<string, Candidate[]>();
    for (const c of aiCandidates) {
      const key = c.screens.join(",");
      groups.set(key, [...(groups.get(key) || []), c]);
    }
    const verified: Candidate[] = [];
    let rejected = 0;
    for (const [key, list] of groups) {
      const idxs = key.split(",").map(Number);
      try {
        const res = await callVision<{ verdicts?: { id?: string; verdict?: string; confidence?: string; reason?: string }[] }>(
          SYSTEM_PROMPT,
          verifyPrompt(list),
          idxs.map((i) => ({ base64: screens[i].base64, mimeType: screens[i].mimeType, detail: idxs.length > 1 ? ("low" as const) : ("high" as const) })),
          usedProviders,
        );
        for (const c of list) {
          const v = (res.verdicts || []).find((x) => x.id === c.id);
          if (v?.verdict === "reject") {
            rejected++;
            log("MOB-VERIFY", `  ✗ Rejected by verifier: ${c.title} — ${v.reason || ""}`, c.pillar, "fail");
            continue;
          }
          const conf = (["high", "medium", "low"].includes(v?.confidence || "") ? v!.confidence : "low") as Confidence;
          verified.push({ ...c, confidence: v ? conf : "low", verification: v?.reason });
        }
      } catch {
        // Verifier unavailable — keep findings but flag them for human review
        verified.push(...list.map((c) => ({ ...c, confidence: "low" as const })));
      }
    }
    log("MOB-VERIFY", `  ✓ Verifier: ${verified.length} confirmed/kept, ${rejected} rejected`, "darkpatterns", "pass");

    // ── Merge, dedupe, evidence ──
    progress(85, "Building evidence and regulation mapping…");
    // Items a screenshot cannot prove (e.g. icon accessible names) become advisories
    for (const c of verified.filter((v) => v.advisory)) {
      const comp = c.component || "icon button";
      const existing = advisories.find((x) => x.ruleId === "verify-accessible-name" && x.component === comp);
      if (existing) {
        c.screens.forEach((sc) => existing.screens.includes(sc) || existing.screens.push(sc));
      } else {
        advisories.push({
          ruleId: "verify-accessible-name",
          title: "Icon-only control — verify accessible name with VoiceOver / TalkBack",
          component: comp,
          screens: [...c.screens],
          elements: [c.elementText || comp],
          detail: "No visible text label. Whether a screen-reader name (accessibilityLabel / contentDescription) is set cannot be determined from a screenshot — check on a device (WCAG 1.1.1 / 4.1.2).",
        });
      }
    }
    const findings = groupByRootCause(mergeCandidates([...measured, ...verified.filter((v) => !v.advisory)])).sort(
      (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || CONF_RANK[a.confidence] - CONF_RANK[b.confidence],
    );
    // One text colour failing on several components is one design-token fix: report it as one
    // issue ("grey #bfbfbf text — product brand, struck-out price") instead of one per component
    // Colours a few shades apart (#bebebe vs #bfbfbf) are the same token measured with anti-aliasing noise
    const rgb = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    const byColour = new Map<string, Candidate[]>();
    for (const f of findings) {
      if (f.source !== "measured" || f.wcag !== "1.4.3" || !f.measurements.foreground) continue;
      const hex = String(f.measurements.foreground).toLowerCase();
      const near = [...byColour.keys()].find((k) => rgb(k).every((v, n) => Math.abs(v - rgb(hex)[n]) <= 6));
      const key = near || hex;
      byColour.set(key, [...(byColour.get(key) || []), f]);
    }
    for (const [fg, list] of byColour) {
      const comps = [...new Set(list.map((f) => f.component).filter(Boolean))];
      if (comps.length < 2) continue;
      const title = `Insufficient text contrast — ${fg} text (${comps.slice(0, 3).join(", ")}${comps.length > 3 ? ", …" : ""})`;
      const worst = list.reduce((s, f) => (SEV_RANK[f.severity] > SEV_RANK[s] ? f.severity : s), list[0].severity);
      for (const f of list) {
        f.title = title;
        f.severity = worst;
        f.recommendation = `Raise the contrast of the ${fg} text colour token to at least ${f.measurements.required || "4.5:1"}; it is used by ${comps.join(", ")}.`;
        f.developerFix = `Use a text colour token with at least ${f.measurements.required || "4.5:1"} contrast against ${f.measurements.background}, applied to every ${comps.join(" and ")}.`;
        f.designerFix = `Replace the ${fg} text colour token in the design system — one change fixes every ${comps.join(" / ")} instance.`;
      }
    }
    const crops = new Map<string, string | undefined>();
    for (const f of findings) {
      // Every finding carries evidence: the marked element, or the whole screen when no box exists
      const screenB64 = screens[f.screens[0]].base64;
      crops.set(f.id, (await annotatedCrop(screenB64, f.box)) || (await screenThumbnail(screenB64)));
    }

    const a11yIssues: AccessibilityIssue[] = [];
    const dpFindings: DarkPatternFinding[] = [];
    const privacyFindings: PrivacyFinding[] = [];
    const jurisdictionCount = { india: 0, eu: 0, us: 0, platform: 0 };

    for (const f of findings) {
      const pageUrl =
        f.screens.length > 1
          ? `Screens ${f.screens.map((i) => `Screen ${i + 1}`).join(", ")}`
          : screenName(screens[f.screens[0]], f.screens[0]);
      const refs = refsFor(f);
      // Exposure counts consumer-protection / privacy findings only — accessibility
      // maps to WCAG 2.2 AA everywhere and is stated once in the summary
      if (f.pillar !== "accessibility") {
        (Object.keys(jurisdictionCount) as (keyof typeof jurisdictionCount)[]).forEach((k) => {
          if (refs[k].length) jurisdictionCount[k]++;
        });
      }
      const refsLine = formatRefs(refs);
      const crop = crops.get(f.id);
      const measuredLine = Object.keys(f.measurements).length ? measurementText(f.measurements) : "";
      const element = f.elementText || (f.measurements.element ? String(f.measurements.element) : f.component || f.title);

      if (f.pillar === "accessibility") {
        const wcag = f.wcag || f.ruleId;
        a11yIssues.push({
          id: f.id,
          testId: `MOB-${wcag}`,
          title: f.title,
          description: f.description,
          element,
          checkData: { ...f.measurements, evidenceBasis: confidenceLabel(f) },
          elementScreenshot: crop,
          pageUrl,
          wcagCriterion: wcag,
          wcagName: f.title,
          wcagLevel: f.wcagLevel || (WCAG_AAA.includes(wcag) ? "AAA" : "AA"),
          severity: f.severity,
          impact: `${f.description}${refsLine ? `\nRegulatory references — ${refsLine}` : ""}`,
          recommendation: [f.recommendation, f.designerFix ? `Design: ${f.designerFix}` : ""].filter(Boolean).join(" "),
          codeFix: f.developerFix,
          category: wcagCategory(wcag),
          source: f.source === "measured" ? "custom-rule" : "ai-analysis",
          confidence: f.confidence,
          affectedPages: f.screens.map((i) => screenName(screens[i], i)),
        });
      } else if (f.pillar === "darkpatterns") {
        const rule = DARK_PATTERN_RULES.find((r) => r.id === f.ruleId);
        // Unknown rule ID: infer the category from its family prefix (e.g. DP-NG-* → nagging)
        const family = DARK_PATTERN_RULES.find((r) => r.id.slice(0, 5) === f.ruleId.slice(0, 5));
        const category = (rule?.category || family?.category || f.category || "misdirection") as DarkPatternCategory;
        dpFindings.push({
          id: f.id,
          ruleId: rule ? rule.id : `DP-MOB-${category.toUpperCase()}`,
          category,
          principle: rule?.principle || PRINCIPLE_BY_CATEGORY[category],
          title: f.title,
          description: f.description,
          element,
          pageUrl,
          severity: f.severity,
          regulation: rule?.regulation || ["US-CCPA"],
          confidence: f.confidence,
          recommendation: f.recommendation,
          userImpact: f.description,
          evidence: {
            summary: `${confidenceLabel(f)} — ${pageUrl}`,
            details: [f.description, ...(measuredLine ? [`Measured: ${measuredLine}`] : []), ...(refsLine ? [`Regulatory references — ${refsLine}`] : [])],
            measurements: f.measurements,
            screenshotDataUrl: crop ? `data:image/png;base64,${crop}` : undefined,
          },
          source: f.source === "measured" ? "rule" : "ai-vision",
          detectionBasis: f.source === "measured" ? "visual" : "visual-ai",
          findingVerdict: f.source === "measured" && f.confidence === "high" ? "verdict" : "signal",
          verifiabilityNote: confidenceLabel(f),
          legalSummary: refsLine,
          developerFix: f.developerFix,
          designerFix: f.designerFix,
          fixPriority: f.severity === "critical" ? "P0" : f.severity === "high" ? "P1" : f.severity === "medium" ? "P2" : "P3",
        });
      } else {
        const category = PRIVACY_RULE_CATEGORY[f.ruleId] || (f.category as PrivacyFindingCategory) || "data-collection";
        const regulation: PrivacyRegulation[] = [];
        if (refs.india.length) regulation.push("IN-DPDPA");
        if (refs.eu.length) regulation.push("GDPR");
        if (refs.us.length) regulation.push("CCPA");
        privacyFindings.push({
          id: f.id,
          category,
          title: f.title,
          description: f.description,
          pageUrl,
          severity: f.severity,
          regulation: regulation.length ? regulation : ["GDPR"],
          recommendation: f.recommendation,
          evidence: {
            summary: `${confidenceLabel(f)} — ${pageUrl}`,
            details: [f.description, ...(measuredLine ? [`Measured: ${measuredLine}`] : []), ...(refsLine ? [`Regulatory references — ${refsLine}`] : [])],
          },
        });
      }
    }

    // ── Build results using the standard TrustLens pipeline ──
    audit.status = "scoring";
    progress(92, "Scoring and generating report…");
    const pillarCtx: PillarContext = { enabledPillars: enabledPillars as AuditPillar[] };
    let darkPatternResult: DarkPatternResult | null = null;
    let privacyResult: PrivacyResult | null = null;

    if (enabledPillars.includes("darkpatterns")) {
      darkPatternResult = buildDarkPatternResult(dpFindings, screens.length);
      pillarCtx.darkpatterns = darkPatternResult;
    }
    if (enabledPillars.includes("privacy")) {
      const sevW = { critical: 20, high: 10, medium: 4, low: 1 };
      const findingsBySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      const regs = new Set<PrivacyRegulation>();
      let deduction = 0;
      for (const f of privacyFindings) {
        findingsBySeverity[f.severity]++;
        deduction += sevW[f.severity];
        f.regulation.forEach((r) => regs.add(r));
      }
      privacyResult = {
        findings: privacyFindings,
        overallScore: Math.max(0, 100 - deduction),
        cookies: [],
        cookiesByPurpose: { necessary: 0, analytics: 0, marketing: 0, functional: 0, unknown: 0 },
        trackers: [],
        totalTrackers: 0,
        hasConsentBanner: hasConsentScreen,
        hasPrivacyPolicy,
        hasMixedContent: false,
        regulatoryRisks: [...regs],
        findingsBySeverity,
        pagesScanned: screens.length,
      };
      pillarCtx.privacy = privacyResult;
    }

    audit.issues = a11yIssues;
    audit.score = calculateScore(a11yIssues, screens.length);
    audit.pillarResults = {
      ...(darkPatternResult ? { darkpatterns: darkPatternResult } : {}),
      ...(privacyResult ? { privacy: privacyResult } : {}),
    };
    audit.trustScore = calculateTrustScore(
      enabledPillars.includes("accessibility")
        ? { overall: audit.score.overall, totalIssues: audit.score.totalIssues, uniqueIssues: audit.score.uniqueIssues, issueBySeverity: audit.score.issueBySeverity }
        : null,
      darkPatternResult,
      null,
      privacyResult,
      enabledPillars as AuditPillar[],
    );
    pillarCtx.trustScore = audit.trustScore;
    audit.report = generateReport(
      auditId,
      a11yIssues,
      audit.score,
      audit.pages.map((p) => ({ url: p.url, title: p.title })),
      undefined,
      undefined,
      [],
      "AA",
      pillarCtx,
    );

    // ── Methodology, review status and limitations (shown in UI and exports) ──
    config.mobileApp!.aiProviders = [...usedProviders];
    // Degraded: any analysis ran on the lightweight fallback model
    const degraded = [...usedProviders].some((p) => /lite/i.test(p));
    config.mobileApp!.degradedModel = degraded;
    audit.mobileAdvisories = advisories.map((a) => ({ ...a, screens: a.screens.map((s) => s + 1) }));

    // One source of truth for counts: unique issues = root causes, instances = occurrences
    const a11yGroups = new Map<string, number>();
    for (const i of a11yIssues) a11yGroups.set(`${i.wcagCriterion}::${i.title}`, (a11yGroups.get(`${i.wcagCriterion}::${i.title}`) || 0) + 1);
    const uniqueIssues = a11yGroups.size + dpFindings.length + privacyFindings.length;
    const instances = a11yIssues.length + dpFindings.length + privacyFindings.length;
    const measuredCount = findings.filter((f) => f.source === "measured").length;
    const needsReview = findings.filter((f) => f.confidence === "low").length;
    // Count unique root causes (grouped accessibility issues + each consumer finding), not instances
    const criticalHigh =
      new Set(a11yIssues.filter((i) => i.severity === "critical" || i.severity === "high").map((i) => `${i.wcagCriterion}::${i.title}`)).size +
      findings.filter((f) => f.pillar !== "accessibility" && (f.severity === "critical" || f.severity === "high")).length;
    config.mobileApp!.counts = { uniqueIssues, instances, accessibility: a11yGroups.size, darkPatterns: dpFindings.length, privacy: privacyFindings.length, advisories: advisories.length, needsReview };

    config.mobileApp!.screens = screens.map((s) => ({ label: s.label, width: s.width, height: s.height }));
    // Reports go to the client as final — there is no separate auditor review step
    config.mobileApp!.reportStatus = "final";

    // Executive conclusion: verdict, top risks and what to fix first (client-facing; engine = "TrustLens AI")
    // One entry per root cause — grouped instances share a title
    const top = [...findings]
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (a.pillar === "darkpatterns" ? -1 : 1))
      .filter((f, i, arr) => arr.findIndex((o) => o.pillar === f.pillar && o.ruleId === f.ruleId && o.title === f.title) === i)
      .slice(0, 3);
    const riskLine = (f: Candidate) => {
      const sc = [...new Set(findings.filter((o) => o.title === f.title).flatMap((o) => o.screens))].sort((a, b) => a - b);
      return `${f.title}${sc.length > 1 ? ` (screens ${sc.map((s) => s + 1).join(", ")})` : ` (screen ${sc[0] + 1})`}`;
    };
    const verdict =
      findings.some((f) => f.severity === "critical")
        ? "Critical issues were found that expose users to harm and the business to regulatory risk; they should be fixed before the next release."
        : criticalHigh > 0
          ? `No critical issues, but ${criticalHigh} high-severity issue(s) affect accessibility or fair choice and should be scheduled in the next sprint.`
          : "No critical or high-severity issues were found on the screens reviewed; the remaining items are moderate improvements.";
    const methodology = [
      `CONCLUSION: ${verdict} ${top.length ? `Top risks: ${top.map((f, i) => `(${i + 1}) ${riskLine(f)}`).join("; ")}.` : ""}${findings.some((f) => f.ruleId === "1.4.3") ? " Fix design-system colour tokens first — one change resolves every grouped contrast instance." : ""}`,
      `REPORT STATUS: Final.${needsReview ? ` ${needsReview} finding(s) are AI judgements with lower confidence and are labelled as such.` : ""} Address the ${criticalHigh} critical/high finding(s) first.`,
      `SCOPE: ${meta.appName || "Unnamed app"} (${meta.platform === "ios" ? "iOS" : meta.platform === "android" ? "Android" : "mobile"})${meta.appVersion ? ` version ${meta.appVersion}` : ""}${meta.device ? ` on ${meta.device}` : ""}${meta.captureDate ? `, screens captured ${meta.captureDate}` : ""} — ${screens.length} screen(s): ${screens.map((s, i) => `${i + 1}. ${s.label}`).join(", ")}.`,
      `RESULT: ${uniqueIssues} unique issue(s) (${instances} instance(s)) — accessibility ${a11yGroups.size}, deceptive design ${dpFindings.length}, privacy UX ${privacyFindings.length}. ${advisories.length} advisory observation(s) (platform guidance, items to verify on a device) are listed separately and are not counted as violations.`,
      `METHOD: TrustLens AI (engine ${PROMPT_VERSION}). ${measuredCount} finding(s) are measured from screenshot pixels, extracted prices and on-screen text rules; the rest are AI judgements from a dedicated consumer-protection review, each checked by an independent verifier pass${rejected ? ` (${rejected} candidate finding(s) rejected)` : ""}${meta.highAssurance ? "; high-assurance mode (two independent runs)" : ""}.`,
      `REGULATORY EXPOSURE (deceptive design and privacy findings): India ${jurisdictionCount.india}, EU ${jurisdictionCount.eu}, US ${jurisdictionCount.us}, app-store policy ${jurisdictionCount.platform}. Accessibility findings are assessed against WCAG 2.2 AA, the technical basis for the EU Accessibility Act (EN 301 549), ADA / Section 508 and India's RPwD Act (IS 17802). References indicate exposure, not a legal opinion.`,
      `LIMITATIONS (not tested from screenshots — requires a device audit): ${MOBILE_NOT_TESTED.join("; ")}. Privacy is assessed for visible UX only (permission prompts, consent, data requests); trackers and SDKs were not tested.`,
    ].join("\n\n");
    audit.report.executiveSummary = `${methodology}\n\n${audit.report.executiveSummary}`;

    audit.auditIntegrity = {
      status: degraded ? "partial" : "warning",
      message: `${degraded ? "Reduced capacity — TrustLens AI ran in reduced-capacity mode for part of this audit; a full-capacity run may find more. " : ""}Screenshot-based mobile app audit: ${uniqueIssues} unique issue(s), ${measuredCount} measured${needsReview ? `, ${needsReview} lower confidence` : ""}. Not tested — needs a device audit: ${MOBILE_NOT_TESTED.join("; ")}.`,
    };
    audit.status = "complete";
    audit.progress = 100;
    audit.progressMessage = `Mobile app audit complete — ${uniqueIssues} unique issue(s) across ${screens.length} screen(s)`;
    audit.completedAt = new Date().toISOString();
    log("MOB-DONE", `  ✓ ${audit.progressMessage}`, "accessibility", "pass");
    storeSetSync(auditId, audit);
  } catch (err) {
    audit.status = "error";
    audit.error = err instanceof Error ? err.message : "Mobile app analysis failed";
    storeSetSync(auditId, audit);
  }
}
