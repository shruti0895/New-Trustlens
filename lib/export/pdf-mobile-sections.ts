// ============================================================
// KPMG TrustLens — Mobile App Audit sections for the PDF export
// Scope & methodology, screens reviewed, regulatory exposure,
// WCAG 2.2 coverage matrix, advisories, limitations, sign-off.
// Only used when audit.config.type === "mobile-app".
// ============================================================

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { AuditResult } from "../types/audit";

type RGB = [number, number, number];
const NAVY: RGB = [0, 51, 141];
const DARK: RGB = [74, 85, 104];
const NEAR_BLACK: RGB = [26, 38, 56];
const OFF_WHITE: RGB = [245, 247, 250];
const PW = 297;
const PH = 210;

type Toc = { num: string; title: string; page: number }[];

function heading(doc: jsPDF, toc: Toc, num: string, title: string): number {
  toc.push({ num, title, page: doc.getCurrentPageInfo().pageNumber });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...DARK);
  doc.text(`${num}. ${title}`, 20, 18);
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.8);
  doc.line(20, 21, PW - 20, 21);
  return 31;
}

function paragraph(doc: jsPDF, text: string, y: number, size = 9): number {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(size);
  doc.setTextColor(...NEAR_BLACK);
  const lines = doc.splitTextToSize(text, PW - 40) as string[];
  if (y + lines.length * size * 0.42 > PH - 22) {
    doc.addPage("a4", "landscape");
    y = 20;
  }
  doc.text(lines, 20, y);
  return y + lines.length * size * 0.42 + 3;
}

const table = (doc: jsPDF, y: number, head: string[], body: (string | number)[][], widths?: number[]) => {
  autoTable(doc, {
    startY: y,
    head: [head],
    body: body.map((r) => r.map(String)),
    headStyles: { fillColor: NAVY, textColor: 255, fontStyle: "bold", fontSize: 8.5 },
    bodyStyles: { fontSize: 8, textColor: NEAR_BLACK, valign: "top" },
    alternateRowStyles: { fillColor: OFF_WHITE },
    columnStyles: widths ? Object.fromEntries(widths.map((w, i) => [i, { cellWidth: w }])) : undefined,
    margin: { left: 20, right: 20 },
    theme: "grid",
  });
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 8;
};

const screenRefs = (pageUrl: string) => [...pageUrl.matchAll(/Screen (\d+)/g)].map((m) => Number(m[1]));

/** Splits "India: …; … | EU: … | US: … | App stores: …" into its parts */
export function splitLegalSummary(s?: string): Record<"India" | "EU" | "US" | "App stores", string[]> {
  const out = { India: [] as string[], EU: [] as string[], US: [] as string[], "App stores": [] as string[] };
  for (const part of (s || "").split(" | ")) {
    const m = part.match(/^(India|EU|US|App stores): (.*)$/);
    if (m) out[m[1] as keyof typeof out] = m[2].split("; ").filter(Boolean);
  }
  return out;
}

// ── 1A / 1B: scope, methodology, regulatory exposure, screens ──
export function renderMobileOverview(doc: jsPDF, audit: AuditResult, toc: Toc) {
  const m = audit.config.mobileApp;
  const counts = m?.counts;
  const dp = (audit.pillarResults?.darkpatterns?.findings || []).filter((f) => !f.rejected);
  const priv = audit.pillarResults?.privacy?.findings || [];

  doc.addPage("a4", "landscape");
  let y = heading(doc, toc, "1A", "Scope, Methodology & Regulatory Exposure");

  y = table(doc, y, ["Item", "Detail"], [
    ["Application", `${m?.appName ? (m.appName === m.appName.toLowerCase() ? m.appName.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) : m.appName) : "Unnamed app"} — ${m?.platform === "ios" ? "iOS" : m?.platform === "android" ? "Android" : "platform not specified"}`],
    ["Scope", `${audit.pages.length} screenshot(s) supplied by the engagement team, reviewed in journey order (see 1B).`],
    ["App version / build", m?.appVersion || "Not provided — record the build reviewed before client delivery"],
    ["Device / OS", m?.device || "Not provided"],
    // Not entered by the auditor → assume the screens were captured on the audit date, and say so
    ["Capture date", m?.captureDate
      ? new Date(m.captureDate).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
      : `${new Date(audit.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })} (assumed — audit date; not entered by the auditor)`],
    ["Audit date", new Date(audit.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })],
    ["Standards", "WCAG 2.2 Level AA (mobile application of success criteria); India CCPA Guidelines for Prevention and Regulation of Dark Patterns 2023; DPDP Act 2023; EU DSA / UCPD / Consumer Rights Directive / GDPR; US FTC Act §5 / ROSCA / CPRA; Apple App Store & Google Play policies"],
    // Client-facing: the engine is always "TrustLens AI"; the underlying model is kept in the internal audit log
    ["Analysis engine", `TrustLens AI · engine version ${m?.promptVersion || "n/a"}${m?.highAssurance ? " · high-assurance (two independent runs)" : ""}${m?.engagementMode ? " · client-data mode" : ""}`],
    ["Evidence basis", `${m?.pixelMeasurement ? "Contrast and tap targets measured from screenshot pixels; " : "Pixel measurement unavailable; "}prices and permission sequence checked from extracted values; deceptive-design and privacy judgements made by AI and checked by an independent verifier. Each finding states its basis.`],
    // Neutral disclosure — the lightweight model can miss judgement-based findings
    ...(m?.degradedModel ? [["Analysis capacity", "Part of this analysis used TrustLens AI's lightweight model; judgement-based findings (deceptive design, privacy) may be less complete than a full-capacity run."]] : []),
  ], [45, PW - 85]);

  y = table(doc, y, ["Severity", "Definition used in this report"], [
    ["Critical", "Makes users pay, consent or share data they did not intend, or blocks a core task for users with disabilities; clear breach of a named regulation."],
    ["High", "Materially steers or obstructs a user's choice, or seriously impairs access (e.g. text contrast well below WCAG); likely regulatory exposure."],
    ["Medium", "Noticeable pressure or friction, or an accessibility gap with a workaround; possible regulatory exposure."],
    ["Low", "Best-practice gap with minor user impact."],
  ], [30, PW - 70]);

  y = table(doc, y, ["Area", "Unique issues", "Instances", "Lower confidence", "Notes"], [
    ["Accessibility (WCAG 2.2 AA)", counts?.accessibility ?? "—", audit.issues.length, audit.issues.filter((i) => i.confidence === "low").length, "Repeated issues grouped by component (one fix resolves all instances)"],
    ["Deceptive design", counts?.darkPatterns ?? dp.length, dp.length, dp.filter((f) => f.confidence === "low").length, "Mapped to India CCPA 2023 / EU / US references"],
    ["Privacy UX (visible only)", counts?.privacy ?? priv.length, priv.length, priv.filter((f) => f.evidence.summary.startsWith("AI judgement (lower confidence)")).length, "Trackers, SDKs and data flows not assessed"],
    ["Advisories (not violations)", counts?.advisories ?? (audit.mobileAdvisories || []).length, "—", "—", "Platform guidance / WCAG AAA — see Section 11"],
  ], [70, 30, 25, 30, PW - 195]);

  // Regulatory exposure by jurisdiction — deceptive design + privacy only
  const juris = { India: new Map<string, number>(), EU: new Map<string, number>(), US: new Map<string, number>(), "App stores": new Map<string, number>() };
  const legalOf = [...dp.map((f) => f.legalSummary), ...priv.map((f) => f.evidence.details.find((d) => d.startsWith("Regulatory references — "))?.replace("Regulatory references — ", ""))];
  for (const s of legalOf) {
    const parts = splitLegalSummary(s);
    (Object.keys(juris) as (keyof typeof juris)[]).forEach((k) => parts[k].forEach((ref) => juris[k].set(ref, (juris[k].get(ref) || 0) + 1)));
  }
  const rows = (Object.keys(juris) as (keyof typeof juris)[])
    .filter((k) => juris[k].size)
    .map((k) => [k, [...juris[k].entries()].sort((a, b) => b[1] - a[1]).map(([ref, n]) => `${ref} (${n})`).join("\n")]);
  if (y > PH - 50) {
    doc.addPage("a4", "landscape");
    y = 20;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...DARK);
  doc.text("Regulatory exposure — deceptive design & privacy findings", 20, y);
  y += 4;
  y = rows.length
    ? table(doc, y, ["Jurisdiction", "Relevant instruments (number of findings)"], rows, [35, PW - 75])
    : paragraph(doc, "No deceptive-design or privacy findings — no consumer-protection exposure identified from the screens reviewed.", y + 4);
  paragraph(doc, "References indicate potential regulatory exposure for the engagement team's assessment; they are not a legal opinion. Accessibility findings are assessed against WCAG 2.2 AA, the technical basis for the EU Accessibility Act (EN 301 549), ADA / Section 508 and India's RPwD Act (IS 17802).", y, 8);

  // 1B: screens reviewed (gallery)
  doc.addPage("a4", "landscape");
  y = heading(doc, toc, "1B", "Screens Reviewed");
  const perScreen = (n: number) => ({
    a11y: audit.issues.filter((i) => screenRefs(i.pageUrl).includes(n)).length,
    dp: dp.filter((f) => screenRefs(f.pageUrl).includes(n)).length,
    priv: priv.filter((f) => screenRefs(f.pageUrl).includes(n)).length,
  });
  const cols = 5;
  const cellW = (PW - 40) / cols;
  const imgW = cellW - 12;
  // One row of up to five phone screens per page
  audit.pages.forEach((p, i) => {
    const col = i % cols;
    if (i > 0 && col === 0) {
      doc.addPage("a4", "landscape");
      y = 20;
    }
    const x = 20 + col * cellW + 6;
    const ratio = (m?.screens?.[i]?.height || 2340) / (m?.screens?.[i]?.width || 1080);
    const imgH = Math.min(120, imgW * ratio);
    const w = imgH / ratio;
    try {
      if (p.screenshot) {
        const fmt = p.screenshot.startsWith("/9j") ? "JPEG" : "PNG";
        doc.addImage(p.screenshot, fmt, x + (imgW - w) / 2, y, w, imgH);
        doc.setDrawColor(200, 205, 215);
        doc.setLineWidth(0.3);
        doc.rect(x + (imgW - w) / 2, y, w, imgH);
      }
    } catch {
      /* image could not be embedded */
    }
    const c = perScreen(i + 1);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(...NEAR_BLACK);
    doc.text(doc.splitTextToSize(`${i + 1}. ${p.title.replace(/^Screen \d+ — /, "")}`, imgW) as string[], x, y + imgH + 6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...DARK);
    doc.text(`Accessibility ${c.a11y} · Deceptive ${c.dp} · Privacy ${c.priv}`, x, y + imgH + 11);
  });
}

// ── Appendix sections 10–13 ──
// "partial" = visible half checked, the rest needs a device; "states" = only judged when the state was captured
const MATRIX: { sc: string; name: string; method: "measured" | "visual" | "device" | "partial" | "states" }[] = [
  { sc: "1.1.1", name: "Non-text Content", method: "partial" },
  { sc: "1.3.1", name: "Info and Relationships", method: "visual" },
  { sc: "1.3.4", name: "Orientation", method: "device" },
  { sc: "1.4.1", name: "Use of Color", method: "visual" },
  { sc: "1.4.3", name: "Contrast (Minimum)", method: "measured" },
  { sc: "1.4.4", name: "Resize Text", method: "device" },
  { sc: "1.4.10", name: "Reflow", method: "device" },
  { sc: "1.4.11", name: "Non-text Contrast", method: "measured" },
  { sc: "1.4.12", name: "Text Spacing", method: "device" },
  { sc: "2.2.2", name: "Pause, Stop, Hide", method: "device" },
  { sc: "2.4.3", name: "Focus Order", method: "device" },
  { sc: "2.4.6", name: "Headings and Labels", method: "visual" },
  { sc: "2.4.7", name: "Focus Visible", method: "device" },
  { sc: "2.4.11", name: "Focus Not Obscured (Minimum)", method: "device" },
  { sc: "2.5.1", name: "Pointer Gestures", method: "device" },
  { sc: "2.5.8", name: "Target Size (Minimum)", method: "measured" },
  { sc: "3.3.1", name: "Error Identification", method: "states" },
  { sc: "3.3.2", name: "Labels or Instructions", method: "visual" },
  { sc: "4.1.2", name: "Name, Role, Value", method: "device" },
  { sc: "4.1.3", name: "Status Messages", method: "device" },
];

export function renderMobileAppendix(doc: jsPDF, audit: AuditResult, toc: Toc) {
  // 10. WCAG coverage matrix
  doc.addPage("a4", "landscape");
  let y = heading(doc, toc, "10", "WCAG 2.2 Coverage Matrix (Mobile)");
  y = paragraph(doc, "Status per success criterion for the screens reviewed. \"No issues found\" means the check ran and nothing failed; \"Not tested\" criteria need a device audit with TalkBack/VoiceOver, font scaling and interaction.", y);
  const rows = MATRIX.map((r) => {
    const hits = audit.issues.filter((i) => i.wcagCriterion === r.sc);
    const obscured = (audit.mobileAdvisories || []).some((a) => a.ruleId === "content-obscured");
    const status = hits.length
      ? `FAIL (${hits.length} instance${hits.length > 1 ? "s" : ""})`
      : r.sc === "2.4.11" && obscured
        ? "Not tested — content under fixed bars seen (Section 11); verify focus on device"
        : r.method === "device"
          ? "Not tested — device audit"
          : r.method === "partial"
            ? "No visible issues — accessible names to verify on device"
            : r.method === "states"
              ? "Not applicable — no error states in the screens supplied"
              : "No issues found";
    const basis = r.method === "measured" ? "Measured from pixels" : r.method === "visual" || r.method === "partial" ? "AI visual review + verifier" : r.method === "states" ? "AI visual review (if captured)" : "Requires device";
    return [r.sc, r.name, basis, status];
  });
  autoTable(doc, {
    startY: y,
    head: [["SC", "Criterion", "Method", "Status"]],
    body: rows,
    headStyles: { fillColor: NAVY, textColor: 255, fontStyle: "bold", fontSize: 8.5 },
    bodyStyles: { fontSize: 8, textColor: NEAR_BLACK },
    margin: { left: 20, right: 20 },
    theme: "grid",
    didParseCell: (d) => {
      if (d.section === "body" && d.column.index === 3) {
        const v = String(d.cell.raw);
        d.cell.styles.textColor = v.startsWith("FAIL") ? [200, 35, 35] : v.startsWith("No issues") ? [0, 140, 100] : [120, 120, 130];
        d.cell.styles.fontStyle = "bold";
      }
    },
  });

  // 11. Advisories
  doc.addPage("a4", "landscape");
  y = heading(doc, toc, "11", "Advisory Observations & Items to Verify");
  const adv = audit.mobileAdvisories || [];
  y = paragraph(doc, "These observations are not counted as violations. They are (a) items that cannot be proven from a screenshot and must be verified on a device (e.g. screen-reader names of icon-only controls), (b) content partly hidden behind fixed bars or overlays, and (c) targets that pass WCAG 2.2 AA but fall short of platform guidance (Apple HIG 44×44pt / Material 48×48dp, WCAG 2.5.5 AAA) or pass SC 2.5.8 only through the spacing exception.", y);
  if (adv.length) {
    table(doc, y, ["Observation", "Component", "Screens", "Examples"], adv.map((a) => [a.title, a.component, a.screens.join(", "), a.elements.slice(0, 6).join(", ")]), [90, 55, 25, PW - 210]);
  } else {
    paragraph(doc, "No advisory observations.", y);
  }

  // 12. Limitations
  doc.addPage("a4", "landscape");
  y = heading(doc, toc, "12", "Limitations & Areas Not Tested");
  for (const t of [
    "Screenshot-based review: findings reflect only the screens supplied. Flows, states and screens not captured were not assessed.",
    "Not tested (requires a device audit): screen reader labels and focus order (TalkBack / VoiceOver), dynamic type / font scaling, orientation, gestures and motion, status messages.",
    "Privacy: only visible privacy UX was assessed (permission prompts, consent screens, data requests, privacy links). Network traffic, SDKs, trackers, data storage and declared permissions (AndroidManifest / Info.plist) were not tested.",
    "Pricing claims: reference (struck-out) prices and discounts are flagged where unsubstantiated on screen; whether they are genuine prior prices requires the client's pricing records.",
    "Tap targets: sizes are estimated from visible bounds; invisible padding may enlarge the real target. Findings marked \"verify on device\" need confirmation.",
    "AI judgement: deceptive-design and privacy findings are AI-assisted and verified by a second AI pass; findings labelled \"lower confidence\" depend on context not visible in a screenshot. References indicate exposure and are not a legal opinion.",
  ]) {
    y = paragraph(doc, `•  ${t}`, y);
  }

  // 13. Report status (final — no separate auditor review step)
  doc.addPage("a4", "landscape");
  y = heading(doc, toc, "13", "Report Status");
  const c = audit.config.mobileApp?.counts;
  table(doc, y, ["Item", "Detail"], [
    ["Report status", "Final"],
    ["Issues reported", c ? `${c.uniqueIssues} unique issue(s), ${c.instances} instance(s)` : String(audit.issues.length)],
    ["Lower-confidence findings (labelled)", c?.needsReview ?? 0],
    ["Prepared by", "KPMG TrustLens (automated analysis)"],
    ["Report date", new Date(audit.completedAt || audit.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })],
  ], [90, PW - 130]);
}
