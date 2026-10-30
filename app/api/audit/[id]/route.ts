import { NextRequest, NextResponse } from 'next/server';
import { getAuditAsync } from '@/lib/store/audit-store';
import { getSessionFromCookiesAsync } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromCookiesAsync(request);
  const userId = session?.user?.id;

  const { id } = await params;
  const audit = await getAuditAsync(id);

  if (!audit) {
    return NextResponse.json({ error: 'Audit not found' }, { status: 404 });
  }

  // Mobile app audits run as a background job — if the server restarted mid-run,
  // the stored audit never finishes. Report it as interrupted instead of spinning forever.
  if (audit.config.type === 'mobile-app' && audit.status !== 'complete' && audit.status !== 'error') {
    const lastActivity = audit.testLog?.length ? audit.testLog[audit.testLog.length - 1].timestamp : audit.startedAt;
    if (Date.now() - new Date(lastActivity).getTime() > 10 * 60 * 1000) {
      audit.status = 'error';
      audit.error = 'This mobile app audit was interrupted (the server stopped or restarted while it was running). Please run it again.';
    }
  }

  if (userId && audit.config.userId && audit.config.userId !== userId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }



  // Base response — always safe to serialize
  const response: Record<string, unknown> = {
    id: audit.id,
    config: audit.config,
    status: audit.status,
    progress: audit.progress,
    progressMessage: audit.progressMessage,
    pages: audit.pages.map(p => ({ url: p.url, title: p.title, timestamp: p.timestamp })),
    issues: audit.issues,
    score: audit.score,
    crawlCoverage: audit.crawlCoverage,
    testResults: audit.testResults || [],
    testLog: audit.testLog || [],
    inapplicableCriteria: audit.inapplicableCriteria || [],
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
    error: audit.error,
    auditIntegrity: audit.auditIntegrity,
  };

  // Only include heavy report/pillar data when audit is complete
  if (audit.status === 'complete') {
    response.report = audit.report;
    response.trustScore = audit.trustScore || undefined;
    response.pillarResults = audit.pillarResults || undefined;
  } else {
    // During in-progress, include a lightweight report stub if available
    response.report = audit.report ? {
      executiveSummary: audit.report.executiveSummary,
      testedLevel: audit.report.testedLevel,
    } : undefined;
  }

  return NextResponse.json(response);
}
