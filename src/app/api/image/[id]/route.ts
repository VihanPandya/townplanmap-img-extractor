/** GET /api/image/:id - a single discovered asset, with every reference. */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { getScanStore } from '@/lib/database/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const store = getScanStore();
    const scanId = request.nextUrl.searchParams.get('scanId');

    const image = scanId ? await store.image(scanId, id) : null;
    if (image) return jsonOk({ scanId, image });

    const found = await store.findImageAnywhere(id);
    if (!found) {
      return jsonError('image-not-found', 'That image is no longer available in any stored scan.', 404);
    }
    return jsonOk(found);
  } catch (error) {
    return errorResponse(error);
  }
}
