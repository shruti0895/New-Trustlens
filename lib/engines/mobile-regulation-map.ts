// ============================================================
// KPMG TrustLens — Mobile App Regulation Map
// Maps mobile audit findings (dark-pattern rule IDs, privacy
// categories, WCAG criteria) to India / EU / US references and
// app-store platform policies. References indicate regulatory
// exposure for the engagement team — not a legal opinion.
// ============================================================

import type { DarkPatternCategory } from "../types/darkpattern";
import type { PrivacyFindingCategory } from "../types/privacy";

export interface JurisdictionRefs {
  india: string[];
  eu: string[];
  us: string[];
  platform: string[];
}

const empty = (): JurisdictionRefs => ({ india: [], eu: [], us: [], platform: [] });

// India — Guidelines for Prevention and Regulation of Dark Patterns, 2023 (CCPA, Annexure 1)
const IN_CCPA = "India CCPA Dark Pattern Guidelines 2023";
const EU_DSA = "EU DSA Art. 25 (online interface design)";
const EU_UCPD = "EU Unfair Commercial Practices Directive Art. 6–7 & Annex I";
const US_FTC = "US FTC Act §5 (unfair/deceptive practices)";
const EU_CRD_PRICE = "EU Consumer Rights Directive Art. 6(1)(e) (total price and delivery charges disclosed upfront)";
const US_FTC_DP ="FTC staff report \"Bringing Dark Patterns to Light\" (2022)";

const DP_CATEGORY_REFS: Record<DarkPatternCategory, JurisdictionRefs> = {
  "interface-interference": {
    india: [`${IN_CCPA} — Interface Interference`],
    eu: [EU_DSA, "GDPR Art. 7 & Art. 25 (where consent choices are affected)"],
    us: [US_FTC, US_FTC_DP, "CPRA Regs §7004 (symmetry in choice for privacy consent)"],
    platform: [],
  },
  obstruction: {
    india: [`${IN_CCPA} — Subscription Trap`],
    eu: [EU_DSA, "EU Consumer Rights Directive (cancellation as easy as sign-up)"],
    us: [US_FTC, "Restore Online Shoppers' Confidence Act (ROSCA) — simple cancellation"],
    platform: ["Google Play Subscriptions policy / Apple App Store Guideline 3.1.2 (easy cancellation)"],
  },
  sneaking: {
    india: [`${IN_CCPA} — Basket Sneaking / Drip Pricing`],
    eu: [EU_UCPD, "EU Consumer Rights Directive Art. 22 (no pre-ticked additional payments)"],
    us: [US_FTC, US_FTC_DP],
    platform: [],
  },
  "forced-action": {
    india: [`${IN_CCPA} — Forced Action`, "DPDP Act 2023 §6 (consent must be free and specific)"],
    eu: [EU_DSA, "GDPR Art. 7(4) (consent not conditional on unnecessary data)"],
    us: [US_FTC, US_FTC_DP],
    platform: [],
  },
  nagging: {
    india: [`${IN_CCPA} — Nagging`],
    eu: [EU_DSA],
    us: [US_FTC_DP],
    platform: [],
  },
  "scarcity-urgency": {
    india: [`${IN_CCPA} — False Urgency`],
    eu: [EU_UCPD + " (Annex I no. 7: false limited-time claims)"],
    us: [US_FTC, US_FTC_DP],
    platform: [],
  },
  "social-pressure": {
    india: [`${IN_CCPA} — False Urgency (false popularity claims)`],
    eu: [EU_UCPD],
    us: [US_FTC, "FTC Rule on Consumer Reviews and Testimonials (16 CFR Part 465)"],
    platform: [],
  },
  "privacy-zuckering": {
    india: ["DPDP Act 2023 §5–§6 (notice, free & informed consent)"],
    eu: ["GDPR Art. 5(1)(c) data minimisation, Art. 7 consent, Art. 25 privacy by default"],
    us: [US_FTC, "CPRA (consent obtained through dark patterns is not consent)"],
    platform: ["Google Play User Data policy / Apple App Store Guideline 5.1.1"],
  },
  confirmshaming: {
    india: [`${IN_CCPA} — Confirm Shaming`],
    eu: [EU_DSA],
    us: [US_FTC_DP, "CPRA Regs §7004 (no shaming language in consent choices)"],
    platform: [],
  },
  misdirection: {
    india: [`${IN_CCPA} — Interface Interference / Trick Question`],
    eu: [EU_DSA, EU_UCPD],
    us: [US_FTC, US_FTC_DP],
    platform: [],
  },
};

// Rule-specific overrides where the CCPA Annexure names a more precise pattern
const DP_RULE_REFS: Record<string, Partial<JurisdictionRefs>> = {
  "DP-SN-02": { india: [`${IN_CCPA} — Basket Sneaking`] },
  "DP-SN-06": { india: [`${IN_CCPA} — Basket Sneaking`] },
  // Drip pricing / delivery thresholds: total price incl. delivery charges must be shown upfront
  "DP-SN-03": { india: [`${IN_CCPA} — Drip Pricing`], eu: [EU_UCPD, EU_CRD_PRICE] },
  "DP-SN-07": { india: [`${IN_CCPA} — Drip Pricing`], eu: [EU_UCPD, EU_CRD_PRICE] },
  "DP-HC-01": { india: [`${IN_CCPA} — Drip Pricing`] },
  "DP-PM-04": { india: [`${IN_CCPA} — Drip Pricing`] },
  "DP-SN-09": {
    india: [`${IN_CCPA} — Subscription Trap / SaaS Billing`],
    us: [US_FTC, "ROSCA — clear disclosure of material terms before billing"],
  },
  "DP-FA-04": {
    india: [`${IN_CCPA} — Subscription Trap / SaaS Billing`],
    us: [US_FTC, "ROSCA — negative option / auto-renewal disclosure"],
  },
  "DP-PM-03": { india: [`${IN_CCPA} — SaaS Billing`] },
  "DP-SN-01": {
    india: [`${IN_CCPA} — Basket Sneaking`, "DPDP Act 2023 §6 (consent requires clear affirmative action)"],
    eu: ["GDPR Art. 4(11) & Recital 32 (pre-ticked boxes are not consent)", "EU Consumer Rights Directive Art. 22"],
  },
  "DP-MD-04": { india: [`${IN_CCPA} — Trick Question`] },
  "DP-BS-01": { india: [`${IN_CCPA} — Bait and Switch`] },
  "DP-MD-07": { india: [`${IN_CCPA} — Bait and Switch`] },
  "DP-MD-05": { india: [`${IN_CCPA} — Disguised Advertisement`], us: [US_FTC, "FTC Native Advertising guidance"] },
  "DP-DA-01": { india: [`${IN_CCPA} — Disguised Advertisement`], us: [US_FTC, "FTC Native Advertising guidance"] },
  "DP-NG-02": {
    platform: ["Apple App Store Guideline 5.1.1(iv) (respect the user's permission choice) / Android runtime-permission best practice (request in context)"],
  },
  // Rating prompts: Apple limits in-app review requests and requires the system prompt
  "DP-NG-01": {
    platform: ["Apple App Store Guideline 1.1.7 / SKStoreReviewController (system review prompt, limited frequency)"],
  },
  // Reference / struck-out prices are a misleading-price issue, not interface interference
  "DP-MD-08": {
    india: [
      "CCPA Guidelines for Prevention of Misleading Advertisements 2022 (substantiation of price and discount claims)",
      "Consumer Protection Act 2019 §2(28) (misleading advertisement)",
    ],
    eu: [
      "EU Price Indication Directive 98/6/EC Art. 6a (announced price reduction must reference the lowest price of the prior 30 days)",
      EU_UCPD,
    ],
    us: [US_FTC, "FTC Guides Against Deceptive Pricing (16 CFR Part 233 — former price comparisons)"],
  },
};

const PRIVACY_REFS: Partial<Record<PrivacyFindingCategory, JurisdictionRefs>> = {
  "consent-mechanism": {
    india: ["DPDP Act 2023 §6 (free, specific, informed, unambiguous consent)"],
    eu: ["GDPR Art. 7 (conditions for consent)", "ePrivacy Directive Art. 5(3)"],
    us: ["CPRA (opt-out / consent symmetry)", US_FTC],
    platform: ["Apple App Tracking Transparency (Guideline 5.1.2)", "Google Play User Data policy"],
  },
  "data-collection": {
    india: ["DPDP Act 2023 §5 (notice before collection)"],
    eu: ["GDPR Art. 13 (information at collection)", "GDPR Art. 5(1)(b) purpose limitation"],
    us: ["CCPA/CPRA notice at collection", US_FTC],
    platform: [
      "Google Play Permissions & Location policy (prominent disclosure before runtime permission)",
      "Apple App Store Guideline 5.1.1(ii) (purpose strings / request in context)",
    ],
  },
  "data-minimization": {
    india: ["DPDP Act 2023 §6(1) (only data necessary for the purpose)"],
    eu: ["GDPR Art. 5(1)(c) data minimisation"],
    us: ["CPRA data minimisation (Cal. Civ. Code §1798.100(c))"],
    platform: ["Google Play User Data policy"],
  },
  "privacy-policy": {
    india: ["DPDP Act 2023 §5 (notice)"],
    eu: ["GDPR Art. 12–13 (transparent information)"],
    us: ["CalOPPA (conspicuous privacy policy)", "CCPA/CPRA notice"],
    platform: ["Google Play & Apple App Store require an accessible in-app privacy policy"],
  },
  "third-party-tracker": {
    india: ["DPDP Act 2023 §6 & §8 (processor obligations)"],
    eu: ["ePrivacy Directive Art. 5(3)", "GDPR Art. 6"],
    us: ["CCPA/CPRA (sale/sharing opt-out)", US_FTC],
    platform: ["Apple App Tracking Transparency", "Google Play Data safety section"],
  },
};

// Accessibility — WCAG 2.2 AA is the technical baseline in every jurisdiction
export function accessibilityRefs(wcag: string): JurisdictionRefs {
  return {
    india: ["RPwD Act 2016 §40–46", "IS 17802 (Accessibility for ICT products, aligned to WCAG)"],
    eu: [`European Accessibility Act (Directive 2019/882) via EN 301 549 cl. 11 (software) — WCAG ${wcag}`],
    us: ["ADA Title III (courts apply WCAG 2.x AA)", `Section 508 (federal) — WCAG ${wcag}`],
    platform: [],
  };
}

export function darkPatternRefs(ruleId: string, category: DarkPatternCategory): JurisdictionRefs {
  const base = DP_CATEGORY_REFS[category] || empty();
  const override = DP_RULE_REFS[ruleId] || {};
  return {
    india: override.india || base.india,
    eu: override.eu || base.eu,
    us: override.us || base.us,
    platform: [...base.platform, ...(override.platform || [])],
  };
}

export function privacyRefs(category: PrivacyFindingCategory): JurisdictionRefs {
  return PRIVACY_REFS[category] || PRIVACY_REFS["data-collection"]!;
}

/** One-line summary for reports, e.g. "India: …; EU: …; US: …; App stores: …" */
export function formatRefs(refs: JurisdictionRefs): string {
  const parts: string[] = [];
  if (refs.india.length) parts.push(`India: ${refs.india.join("; ")}`);
  if (refs.eu.length) parts.push(`EU: ${refs.eu.join("; ")}`);
  if (refs.us.length) parts.push(`US: ${refs.us.join("; ")}`);
  if (refs.platform.length) parts.push(`App stores: ${refs.platform.join("; ")}`);
  return parts.join(" | ");
}
