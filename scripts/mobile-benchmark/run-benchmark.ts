// ============================================================
// Mobile audit quality benchmark
// Runs the real mobile audit engine on the gold scenarios and
// reports recall (planted issues found), precision (findings that
// are expected or legitimate), and run-to-run stability.
//
//   npm run bench:mobile               (2 runs per scenario)
//   npm run bench:mobile -- --runs 1 --only shopfast
//
// Uses whichever AI provider .env.local configures (respects
// MOBILE_AUDIT_MODE). Every run makes real AI calls.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { runMobileAppAudit } from "../../lib/engines/mobile-app-analyzer";
import { getAudit } from "../../lib/store/audit-store";
import { SCENARIOS, type Scenario } from "./scenarios";

// Acceptance bar for engagement use (see P2 plan)
const BAR = { recall: 0.85, precision: 0.9, stability: 0.9 };

interface Found {
  key: string; // rule ID, WCAG criterion, or privacy:<category>
  element: string;
  screens: number[]; // 1-based
  severity: string;
  title: string;
}

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 2;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

async function renderScreens(s: Scenario) {
  if (s.fromAudit) {
    // Real-app scenario: reuse the screenshots stored with a local audit
    const file = path.join(process.cwd(), ".audit-data", `${s.fromAudit}.json`);
    if (!fs.existsSync(file)) return null;
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    return a.pages.map((p: { title: string; screenshot: string }, i: number) => ({
      base64: p.screenshot,
      mimeType: p.screenshot.startsWith("/9j") ? "image/jpeg" : "image/png",
      label: p.title.replace(/^(Screen \d+ — )+/, ""),
      width: a.config.mobileApp?.screens?.[i]?.width || 1170,
      height: a.config.mobileApp?.screens?.[i]?.height || 2532,
    }));
  }
  return Promise.all(
    s.screens.map(async (sc) => {
      // Same downscale the browser applies before upload (max side 1600, JPEG 85)
      const png = await sharp(Buffer.from(sc.svg)).png().toBuffer();
      const meta = await sharp(png).metadata();
      const jpeg = await sharp(png).resize({ height: 1600, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      return { base64: jpeg.toString("base64"), mimeType: "image/jpeg", label: sc.label, width: meta.width || 1080, height: meta.height || 2340 };
    }),
  );
}

const screensOf = (pageUrl: string) => [...pageUrl.matchAll(/Screen (\d+)/g)].map((m) => Number(m[1]));

function collect(auditId: string): Found[] {
  const a = getAudit(auditId);
  if (!a || a.status !== "complete") throw new Error(a?.error || `Audit ${auditId} did not complete`);
  return [
    ...a.issues.map((i) => ({ key: i.wcagCriterion, element: i.element, screens: screensOf(i.pageUrl), severity: i.severity, title: i.title })),
    ...(a.pillarResults?.darkpatterns?.findings || []).map((f) => ({ key: f.ruleId, element: f.element, screens: screensOf(f.pageUrl), severity: f.severity, title: f.title })),
    ...(a.pillarResults?.privacy?.findings || []).map((f) => ({ key: `privacy:${f.category}`, element: "", screens: screensOf(f.pageUrl), severity: f.severity, title: f.title })),
  ];
}

function score(s: Scenario, found: Found[]) {
  const matchedExpected = s.expected.map((e) => found.some((f) => e.anyOf.includes(f.key) && f.screens.includes(e.screen)));
  const forbiddenHit = (f: Found) =>
    (s.forbidden || []).some((x) => x.ruleId === f.key && x.text.some((t) => f.element.toLowerCase().includes(t.toLowerCase())));
  const legit = found.filter((f) => {
    if (forbiddenHit(f)) return false;
    // Real apps: anything not known to be wrong is not counted against precision
    if (s.openWorld) return true;
    if (s.expected.some((e) => e.anyOf.includes(f.key))) return true;
    if (!s.allowed.includes(f.key)) return false;
    // In a clean control only low/medium extras are tolerated
    return !s.strict || f.severity === "low" || f.severity === "medium";
  });
  return {
    recallHits: matchedExpected.filter(Boolean).length,
    recallTotal: s.expected.length,
    missed: s.expected.filter((_, i) => !matchedExpected[i]).map((e) => `S${e.screen} ${e.note}`),
    precisionHits: legit.length,
    precisionTotal: found.length,
    falsePositives: found.filter((f) => !legit.includes(f)).map((f) => `S${f.screens.join(",")} [${f.severity}] ${f.key} — ${f.title} (${f.element})`),
  };
}

const keySet = (found: Found[]) => new Set(found.map((f) => `${f.key}@${f.screens.join(",")}`));
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
};

(async () => {
  const scenarios = SCENARIOS.filter((s) => !only || s.id === only);
  const totals = { rH: 0, rT: 0, pH: 0, pT: 0, stab: [] as number[] };
  const report: Record<string, unknown>[] = [];

  for (const s of scenarios) {
    const screens = await renderScreens(s);
    if (!screens) {
      console.log(`▷ ${s.id}: skipped (local audit ${s.fromAudit} not found)`);
      continue;
    }
    const runFound: Found[][] = [];
    for (let r = 0; r < runs; r++) {
      const id = `bench-${s.id}-${Date.now()}-${r}`;
      process.stdout.write(`▶ ${s.id} run ${r + 1}/${runs}… `);
      const t0 = Date.now();
      await runMobileAppAudit(id, screens, { appName: s.appName, platform: s.platform || "android" }, ["accessibility", "darkpatterns", "privacy"]);
      const found = collect(id);
      runFound.push(found);
      console.log(`${found.length} finding(s) in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    const scores = runFound.map((f) => score(s, f));
    const stability = runs > 1 ? jaccard(keySet(runFound[0]), keySet(runFound[1])) : 1;
    for (const sc of scores) {
      totals.rH += sc.recallHits;
      totals.rT += sc.recallTotal;
      totals.pH += sc.precisionHits;
      totals.pT += sc.precisionTotal;
    }
    if (runs > 1) totals.stab.push(stability);
    const last = scores[scores.length - 1];
    console.log(`  recall ${last.recallHits}/${last.recallTotal} · precision ${last.precisionHits}/${last.precisionTotal}${runs > 1 ? ` · stability ${(stability * 100).toFixed(0)}%` : ""}`);
    last.missed.forEach((m) => console.log(`    ✗ missed: ${m}`));
    last.falsePositives.forEach((m) => console.log(`    ⚠ unexpected: ${m}`));
    report.push({ scenario: s.id, scores, stability, found: runFound });
  }

  const recall = totals.rT ? totals.rH / totals.rT : 1;
  const precision = totals.pT ? totals.pH / totals.pT : 1;
  const stability = totals.stab.length ? totals.stab.reduce((a, b) => a + b, 0) / totals.stab.length : NaN;
  const pass = (v: number, bar: number) => (isNaN(v) ? "n/a" : v >= bar ? "PASS" : "FAIL");
  console.log("\n══ Overall ══");
  console.log(`Recall (planted issues)  ${(recall * 100).toFixed(0)}%  (bar ${BAR.recall * 100}%)  ${pass(recall, BAR.recall)}`);
  console.log(`Precision                ${(precision * 100).toFixed(0)}%  (bar ${BAR.precision * 100}%)  ${pass(precision, BAR.precision)}`);
  console.log(`Stability (2 runs)       ${isNaN(stability) ? "n/a" : (stability * 100).toFixed(0) + "%"}  (bar ${BAR.stability * 100}%)  ${pass(stability, BAR.stability)}`);

  const outDir = path.join(process.cwd(), "scripts", "mobile-benchmark", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ recall, precision, stability, runs, scenarios: report }, null, 2));
  console.log(`\nDetails: ${outFile}`);
})();
