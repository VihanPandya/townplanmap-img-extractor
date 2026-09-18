/**
 * POST /api/scan  - start a scan
 * GET  /api/scan  - recent scans (scan history)
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { getScanStore, toSummary } from '@/lib/database/store';
import { createScan } from '@/lib/scan/create';
import type { CreateScanRequest } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreateScanRequest;
    if (!body || typeof body.url !== 'string') {
      return jsonError('bad-request', 'A "url" field is required to start a scan.', 400);
    }
    const result = await createScan({ url: body.url, settings: body.settings });
    return jsonOk(result, 202);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  try {
    const store = getScanStore();
    const scans = await store.list(20);
    void toSummary;
    return jsonOk({ scans });
  } catch (error) {
    return errorResponse(error);
  }
}
