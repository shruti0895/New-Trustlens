import { NextRequest, NextResponse } from 'next/server';
import { runMobileAppAudit, hasVisionProvider, providerSetupError } from '@/lib/engines/mobile-app-analyzer';
import type { MobileScreen, MobilePlatform } from '@/lib/engines/mobile-app-analyzer';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_SCREENS = 20;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function POST(request: NextRequest) {
  try {
    if (!hasVisionProvider()) {
      return NextResponse.json({ error: providerSetupError() }, { status: 400 });
    }

    const body = await request.json() as {
      appName?: string;
      platform?: MobilePlatform;
      screens?: MobileScreen[];
      pillars?: string[];
      highAssurance?: boolean;
      deviceWidthDp?: number;
      appVersion?: string;
      device?: string;
      captureDate?: string;
    };

    const screens = (body.screens || []).filter(s => s && s.base64 && ALLOWED_TYPES.includes(s.mimeType));
    if (screens.length === 0) {
      return NextResponse.json({ error: 'Upload at least one app screenshot (JPEG, PNG or WebP)' }, { status: 400 });
    }
    if (screens.length > MAX_SCREENS) {
      return NextResponse.json({ error: `Maximum ${MAX_SCREENS} screens per mobile app audit` }, { status: 400 });
    }

    const platform: MobilePlatform = body.platform === 'android' || body.platform === 'ios' ? body.platform : 'unknown';
    const deviceWidthDp = Number(body.deviceWidthDp);
    const auditId = crypto.randomUUID();

    // Runs in the background; progress is written to the audit store
    void runMobileAppAudit(
      auditId,
      screens.map((s, i) => ({
        base64: s.base64,
        mimeType: s.mimeType,
        label: (s.label || `Screen ${i + 1}`).slice(0, 80),
        width: Number(s.width) || 0,
        height: Number(s.height) || 0,
      })),
      {
        appName: (body.appName || '').slice(0, 120),
        platform,
        appVersion: (body.appVersion || '').slice(0, 40) || undefined,
        device: (body.device || '').slice(0, 80) || undefined,
        captureDate: /^\d{4}-\d{2}-\d{2}$/.test(body.captureDate || '') ? body.captureDate : undefined,
        highAssurance: body.highAssurance === true,
        deviceWidthDp: deviceWidthDp >= 280 && deviceWidthDp <= 1400 ? deviceWidthDp : undefined,
      },
      body.pillars || ['accessibility', 'darkpatterns', 'privacy'],
    );

    return NextResponse.json({ auditId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to start mobile app audit' }, { status: 500 });
  }
}
