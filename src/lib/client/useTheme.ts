'use client';

import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tpm-theme';

/**
 * The `data-theme` attribute on <html> is the single source of truth: it is set
 * by the inline bootstrap in the layout before first paint, and read here
 * through `useSyncExternalStore` so React stays in step with it without an
 * effect that would re-render after mount.
 */
function subscribe(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** The server cannot know the visitor's preference, so it renders the light shell. */
function getServerSnapshot(): Theme {
  return 'light';
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next: Theme = getSnapshot() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage is unavailable in some private modes; the attribute still applies.
    }
  }, []);

  return { theme, toggle };
}
