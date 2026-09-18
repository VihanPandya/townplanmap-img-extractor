/** POST /api/scan/:id/control - pause, resume or stop a running scan. */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { getScanStore, toSummary } from '@/lib/database/store';
import { controlScan } from '@/lib/scan/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = new Set(['pause', 'resume', 'stop']);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { action?: string };
    const action = body?.action ?? '';
    if (!ACTIONS.has(action)) {
      return jsonError('bad-request', 'Action must be one of "pause", "resume" or "stop".', 400);
    }

    const record = await getScanStore().get(id);
    if (!record) return jsonError('scan-not-found', 'That scan is no longer available.', 404);

    const status = controlScan(id, action as 'pause' | 'resume' | 'stop');
    if (status === null) {
      return jsonOk({ scan: toSummary(record), note: 'This scan has already finished.' });
    }
    return jsonOk({ scan: toSummary(record) });
  } catch (error) {
    return errorResponse(error);
  }
}
