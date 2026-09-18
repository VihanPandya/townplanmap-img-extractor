import { NextResponse } from 'next/server';
import { HttpFetchError } from '@/lib/security/http';
import { UrlSecurityError } from '@/lib/security/url-guard';
import type { ApiError } from '@/lib/types';

export function jsonError(
  code: string,
  message: string,
  status: number,
  detail?: string,
): NextResponse<ApiError> {
  return NextResponse.json<ApiError>(
    { error: { code, message, ...(detail ? { detail } : {}), httpStatus: status } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/** Map a thrown error onto a user-readable API response. */
export function errorResponse(error: unknown): NextResponse<ApiError> {
  if (error instanceof UrlSecurityError) {
    return jsonError(error.code, error.message, 400);
  }
  if (error instanceof HttpFetchError) {
    const status = error.code === 'timeout' ? 504 : 502;
    return jsonError(error.code, error.message, status);
  }
  if (error instanceof SyntaxError) {
    return jsonError('bad-request', 'The request body could not be read as JSON.', 400);
  }
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return jsonError('internal', message, 500);
}

export function jsonOk<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });
}
