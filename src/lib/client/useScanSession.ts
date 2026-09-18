'use client';

/**
 * Drives one scan from the browser.
 *
 * While a scan is live the hook polls two endpoints on a short interval:
 * the status endpoint for progress, and the images endpoint with a cursor so
 * only newly discovered assets travel over the wire. That is what makes the
 * gallery fill progressively without ever blocking the UI thread.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  controlScan as controlScanRequest,
  fetchScan,
  fetchScanImages,
  startScan as startScanRequest,
} from '@/lib/client/api';
import type { DiscoveredImage, ScanDetail, ScanSettings } from '@/lib/types';

const LIVE_POLL_MS = 700;
const IDLE_POLL_MS = 2500;

export interface ScanSessionState {
  scanId: string | null;
  scan: ScanDetail | null;
  images: DiscoveredImage[];
  /** Set while the POST that creates the scan is in flight. */
  starting: boolean;
  error: { message: string; detail: string | null } | null;
  live: boolean;
}

export interface ScanSessionApi extends ScanSessionState {
  start: (url: string, settings: Partial<ScanSettings>) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  /** Re-open a previous scan from history. */
  open: (scanId: string) => Promise<void>;
  dismissError: () => void;
}

function isLive(scan: ScanDetail | null): boolean {
  if (!scan) return false;
  return scan.status === 'queued' || scan.status === 'running' || scan.status === 'paused' || scan.status === 'stopping';
}

export function useScanSession(): ScanSessionApi {
  const [state, setState] = useState<ScanSessionState>({
    scanId: null,
    scan: null,
    images: [],
    starting: false,
    error: null,
    live: false,
  });

  const cursorRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeScanRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const poll = useCallback(
    async (scanId: string) => {
      if (!mountedRef.current || activeScanRef.current !== scanId) return;

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const [detail, page] = await Promise.all([
          fetchScan(scanId, controller.signal),
          fetchScanImages(scanId, cursorRef.current, controller.signal),
        ]);
        if (!mountedRef.current || activeScanRef.current !== scanId) return;

        if (page.images.length > 0) {
          cursorRef.current = Math.max(cursorRef.current, ...page.images.map((image) => image.seq));
        }

        setState((previous) => {
          // Merge by id: new assets append, already-known assets are replaced
          // in place so verification results (dimensions, status) land without
          // reshuffling the gallery.
          const byId = new Map(previous.images.map((image) => [image.id, image]));
          const changed = page.images.length > 0;
          for (const image of page.images) byId.set(image.id, image);

          // Assets discovered earlier get refreshed metadata on a full refetch,
          // which the server sends when the cursor is reset.
          const merged = changed ? [...byId.values()] : previous.images;

          return {
            ...previous,
            scan: detail,
            images: merged,
            live: isLive(detail),
            starting: false,
          };
        });

        const nextDelay = isLive(detail) ? LIVE_POLL_MS : IDLE_POLL_MS;
        if (isLive(detail)) {
          timerRef.current = setTimeout(() => void poll(scanId), nextDelay);
        } else {
          // One final sweep picks up metadata written during the last tick.
          timerRef.current = setTimeout(() => {
            void finalSweep(scanId);
          }, 250);
        }
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current) return;
        const message =
          error instanceof ApiRequestError ? error.message : 'Lost contact with the scan service.';
        const recoverable = !(error instanceof ApiRequestError && error.status === 404);
        setState((previous) => ({
          ...previous,
          starting: false,
          live: recoverable ? previous.live : false,
          error: { message, detail: error instanceof ApiRequestError ? error.detail : null },
        }));
        if (recoverable && activeScanRef.current === scanId) {
          timerRef.current = setTimeout(() => void poll(scanId), 2000);
        }
      }
    },
    // finalSweep is declared below and is stable for the lifetime of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Refetch every asset once the scan settles, so late metadata is not missed. */
  const finalSweep = useCallback(async (scanId: string) => {
    if (!mountedRef.current || activeScanRef.current !== scanId) return;
    try {
      const [detail, page] = await Promise.all([fetchScan(scanId), fetchScanImages(scanId, 0)]);
      if (!mountedRef.current || activeScanRef.current !== scanId) return;
      cursorRef.current = page.cursor;
      setState((previous) => ({
        ...previous,
        scan: detail,
        images: page.images,
        live: false,
        starting: false,
      }));
    } catch {
      /* the last successful poll already holds usable results */
    }
  }, []);

  const begin = useCallback(
    (scanId: string) => {
      stopPolling();
      cursorRef.current = 0;
      activeScanRef.current = scanId;
      void poll(scanId);
    },
    [poll, stopPolling],
  );

  const start = useCallback(
    async (url: string, settings: Partial<ScanSettings>) => {
      stopPolling();
      activeScanRef.current = null;
      setState({ scanId: null, scan: null, images: [], starting: true, error: null, live: false });
      try {
        const created = await startScanRequest(url, settings);
        if (!mountedRef.current) return;
        setState((previous) => ({ ...previous, scanId: created.scanId, starting: true }));
        begin(created.scanId);
      } catch (error) {
        if (!mountedRef.current) return;
        setState({
          scanId: null,
          scan: null,
          images: [],
          starting: false,
          live: false,
          error: {
            message: error instanceof ApiRequestError ? error.message : 'The scan could not be started.',
            detail: error instanceof ApiRequestError ? error.detail : null,
          },
        });
      }
    },
    [begin, stopPolling],
  );

  const open = useCallback(
    async (scanId: string) => {
      stopPolling();
      setState({ scanId, scan: null, images: [], starting: true, error: null, live: false });
      begin(scanId);
    },
    [begin, stopPolling],
  );

  const sendControl = useCallback(
    async (action: 'pause' | 'resume' | 'stop') => {
      const scanId = activeScanRef.current;
      if (!scanId) return;
      try {
        await controlScanRequest(scanId, action);
        // Reflect the new state immediately rather than waiting for the poll.
        void poll(scanId);
      } catch (error) {
        setState((previous) => ({
          ...previous,
          error: {
            message: error instanceof ApiRequestError ? error.message : 'That action could not be applied.',
            detail: null,
          },
        }));
      }
    },
    [poll],
  );

  const reset = useCallback(() => {
    stopPolling();
    activeScanRef.current = null;
    cursorRef.current = 0;
    setState({ scanId: null, scan: null, images: [], starting: false, error: null, live: false });
  }, [stopPolling]);

  return {
    ...state,
    start,
    open,
    pause: () => sendControl('pause'),
    resume: () => sendControl('resume'),
    stop: () => sendControl('stop'),
    reset,
    dismissError: () => setState((previous) => ({ ...previous, error: null })),
  };
}
