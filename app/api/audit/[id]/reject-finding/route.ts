import { NextRequest, NextResponse } from 'next/server';
import { getAuditAsync, setAuditAsync } from '@/lib/store/audit-store';
import { getSessionFromCookiesAsync } from '@/lib/auth';
import { recordDarkPatternFeedback } from '@/lib/engines/dark-pattern-learning';

import type { DarkPatternFinding } from '@/lib/types/darkpattern';
import type { AuditResult, AccessibilityIssue } from '@/lib/types/audit';
import type { PrivacyFinding } from '@/lib/types/privacy';
import { calculateScore } from '@/lib/engines/scoring';
import { PRINCIPLE_WEIGHTS } from '@/lib/types/darkpattern';
import type { EthicalPrinciple } from '@/lib/types/darkpattern';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────
// PATCH /api/audit/[id]/reject-finding
// Body: { findingId: string; reason?: string }
//
// Marks a dark-pattern finding as a false positive, recalculates
// ethicsScore excluding rejected findings, and persists the result.
// ─────────────────────────────────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromCookiesAsync(request);
  const userId = session?.user?.id;

  const { id } = await params;

  let body: { findingId?: string; reason?: string; undo?: boolean; action?: 'reject' | 'confirm' };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { findingId, reason, undo = false } = body;
  if (!findingId) {
    return NextResponse.json({ error: 'findingId is required' }, { status: 400 });
  }

  const audit = await getAuditAsync(id);
  if (!audit) {
    return NextResponse.json({ error: 'Audit not found' }, { status: 404 });
  }

  // Ownership check
  if (userId && audit.config.userId && audit.config.userId !== userId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }


  // Mobile app audits: spot-check accessibility / privacy findings and confirmations
  if (audit.config.type === 'mobile-app') {
    const handled = applyMobileReview(audit, findingId, body.action || 'reject', reason, undo);
    if (handled) {
      await setAuditAsync(id, audit);
      return NextResponse.json({ success: true, ...handled });
    }
  }

  // Locate the finding inside pillarResults.darkpatterns.findings
  const dpResult = audit.pillarResults?.darkpatterns;
  if (!dpResult) {
    return NextResponse.json({ error: 'No dark pattern results found for this audit' }, { status: 404 });
  }

  const finding = (dpResult.findings as DarkPatternFinding[]).find(f => f.id === findingId);
  if (!finding) {
    return NextResponse.json({ error: `Finding ${findingId} not found` }, { status: 404 });
  }

  // Apply or reverse rejection
  if (undo) {
    delete finding.rejected;
    delete finding.rejectionReason;
    delete finding.rejectedAt;
  } else {
    finding.rejected = true;
    finding.rejectionReason = reason || 'Marked as false positive';
    finding.rejectedAt = new Date().toISOString();

    // Save rich learning feedback into dark_pattern_learning table in PostgreSQL asynchronously (non-blocking)
    const elementDesc = finding.element || finding.elementSelector || finding.title || 'Interactive UI Component';
    const richPatternType = `${finding.ruleId || 'DP-RULE'}: ${finding.title || finding.category || 'Dark Pattern'}`;
    const richReason = reason
      ? `${reason} (Pattern: ${finding.description || 'Dismissed by auditor'})`
      : `Marked as false positive by auditor: ${finding.description || 'Dismissed finding'}`;

    recordDarkPatternFeedback({
      patternType: richPatternType,
      elementSelector: elementDesc,
      action: 'false_positive',
      reason: richReason,
    }).catch(learnErr => {
      console.warn('[RejectFinding] Failed to save dark pattern learning record:', learnErr);
    });
  }

  // ── Recalculate ethics score excluding rejected findings ──
  const activeFindings = (dpResult.findings as DarkPatternFinding[]).filter(f => !f.rejected);

  const allPrinciples: EthicalPrinciple[] = [
    'informed-consent',
    'symmetry-of-choice',
    'transparency',
    'user-autonomy',
    'accessibility-clarity',
  ];

  // Per-principle score — start at 100, deduct for each active finding
  const severityDeductions: Record<string, number> = { critical: 20, high: 12, medium: 6, low: 3 };
  const principleScores: Record<EthicalPrinciple, number> = {} as Record<EthicalPrinciple, number>;
  for (const p of allPrinciples) principleScores[p] = 100;

  for (const f of activeFindings) {
    const p = f.principle as EthicalPrinciple;
    if (principleScores[p] === undefined) continue;
    const deduction = severityDeductions[f.severity] ?? 6;
    const exemptFactor = f.complianceExemption?.scoreReductionFactor ?? 1;
    principleScores[p] = Math.max(0, principleScores[p] - deduction * exemptFactor);
  }

  let weightedSum = 0, totalWeight = 0;
  for (const p of allPrinciples) {
    const w = PRINCIPLE_WEIGHTS[p];
    weightedSum += principleScores[p] * w;
    totalWeight += w;
  }
  const newEthicsScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 100;

  // Patch the result object
  dpResult.ethicsScore = newEthicsScore;
  dpResult.totalFindings = activeFindings.length;
  dpResult.principleScores = principleScores;

  // Rebuild findingsBySeverity from active findings only
  const findingsBySeverity: Record<string, number> = {};
  for (const f of activeFindings) {
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
  }
  dpResult.findingsBySeverity = findingsBySeverity;

  if (audit.config.type === 'mobile-app') refreshMobileReviewStatus(audit);

  // Save the updated audit back to the store
  await setAuditAsync(id, audit);

  return NextResponse.json({
    success: true,
    finding: { id: finding.id, rejected: finding.rejected ?? false },
    updatedEthicsScore: newEthicsScore,
    activeFindings: activeFindings.length,
  });
}

// ─────────────────────────────────────────────────────────────────
// Mobile app audit spot-check
// action "confirm": auditor accepts a finding (clears "Needs review")
// action "reject":  removes an accessibility / privacy finding as a
//                   false positive (dark-pattern findings use the flow above)
// ─────────────────────────────────────────────────────────────────
function applyMobileReview(
  audit: AuditResult,
  findingId: string,
  action: 'reject' | 'confirm',
  reason: string | undefined,
  undo: boolean,
): Record<string, unknown> | null {
  const review = (audit.mobileReview ||= { confirmed: [], rejected: [] });

  if (action === 'confirm') {
    review.confirmed = undo
      ? review.confirmed.filter(x => x !== findingId)
      : [...new Set([...review.confirmed, findingId])];
    refreshMobileReviewStatus(audit);
    return { finding: { id: findingId, confirmed: !undo } };
  }

  if (undo) {
    const entry = review.rejected.find(r => r.id === findingId);
    if (!entry) return null;
    review.rejected = review.rejected.filter(r => r.id !== findingId);
    if (entry.pillar === 'accessibility') audit.issues.push(entry.item as AccessibilityIssue);
    else audit.pillarResults?.privacy?.findings.push(entry.item as PrivacyFinding);
  } else {
    const issue = audit.issues.find(i => i.id === findingId);
    const privacy = audit.pillarResults?.privacy?.findings.find(f => f.id === findingId);
    if (!issue && !privacy) return null; // not an accessibility/privacy finding
    review.rejected.push({
      id: findingId,
      pillar: issue ? 'accessibility' : 'privacy',
      reason: reason || 'Marked as false positive',
      at: new Date().toISOString(),
      item: (issue || privacy)!,
    });
    if (issue) audit.issues = audit.issues.filter(i => i.id !== findingId);
    if (privacy && audit.pillarResults?.privacy) {
      audit.pillarResults.privacy.findings = audit.pillarResults.privacy.findings.filter(f => f.id !== findingId);
    }
  }

  // Recalculate accessibility and privacy scores from the remaining findings
  audit.score = calculateScore(audit.issues, audit.pages.length);
  const priv = audit.pillarResults?.privacy;
  if (priv) {
    const sevW: Record<string, number> = { critical: 20, high: 10, medium: 4, low: 1 };
    const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of priv.findings) bySev[f.severity]++;
    priv.findingsBySeverity = bySev;
    priv.overallScore = Math.max(0, 100 - priv.findings.reduce((s, f) => s + (sevW[f.severity] || 1), 0));
  }
  refreshMobileReviewStatus(audit);
  return { finding: { id: findingId, rejected: !undo }, accessibilityScore: audit.score.overall, privacyScore: priv?.overallScore };
}

/** Rewrites the REVIEW STATUS paragraph of the report summary from the current findings */
function refreshMobileReviewStatus(audit: AuditResult) {
  const confirmed = new Set(audit.mobileReview?.confirmed || []);
  const dp = (audit.pillarResults?.darkpatterns?.findings || []).filter(f => !f.rejected);
  const priv = audit.pillarResults?.privacy?.findings || [];
  const pending = [
    ...audit.issues.filter(i => i.confidence === 'low').map(i => i.id),
    ...dp.filter(f => f.confidence === 'low').map(f => f.id),
    ...priv.filter(f => f.evidence.summary.startsWith('Needs review')).map(f => f.id),
  ].filter(x => !confirmed.has(x));
  const all = [...audit.issues, ...dp, ...priv];
  const critHigh = all.filter(f => f.severity === 'critical' || f.severity === 'high');
  const critHighOpen = critHigh.filter(f => !confirmed.has(f.id)).length;
  const rejectedCount = (audit.mobileReview?.rejected.length || 0) + (audit.pillarResults?.darkpatterns?.findings || []).filter(f => f.rejected).length;

  const status = pending.length
    ? `REVIEW STATUS: DRAFT — ${pending.length} finding(s) marked "Needs review" must be confirmed by an auditor before client delivery. ${critHighOpen} of ${critHigh.length} critical/high finding(s) not yet confirmed.`
    : `REVIEW STATUS: ${confirmed.size} finding(s) confirmed and ${rejectedCount} rejected by an auditor. ${critHighOpen} of ${critHigh.length} critical/high finding(s) not yet confirmed.`;
  if (audit.report?.executiveSummary) {
    audit.report.executiveSummary = audit.report.executiveSummary.replace(/REVIEW STATUS:[^\n]*/, status);
  }
}
