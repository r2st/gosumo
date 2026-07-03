'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Pull past this distance (px) to arm a refresh. */
const THRESHOLD = 64;
/** Visible pull is capped here so the indicator never runs away. */
const MAX_PULL = 96;
/** The drag feels heavier than the finger travels. */
const RESISTANCE = 0.5;

function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export interface PullToRefreshState<T extends HTMLElement> {
  /** Attach to the scrollable container you want to pull. Must be `position: relative`. */
  containerRef: React.RefObject<T>;
  /** Current visible pull distance in px (0 when idle). */
  pullDistance: number;
  /** True while the refresh callback is in flight. */
  isRefreshing: boolean;
}

/**
 * Touch-only pull-to-refresh. When the user drags down from the very top of the
 * referenced scroll container past {@link THRESHOLD}, {@link onRefresh} fires and
 * the returned state drives {@link PullToRefreshIndicator}. On non-touch devices
 * the hook is inert — no listeners are attached.
 */
export function usePullToRefresh<T extends HTMLElement = HTMLDivElement>(
  onRefresh: () => void | Promise<unknown>,
): PullToRefreshState<T> {
  const containerRef = useRef<T>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Mirror mutable state into refs so the once-bound listeners read fresh values.
  const pullRef = useRef(0);
  const startYRef = useRef<number | null>(null);
  const pullingRef = useRef(false);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const setPull = (v: number) => {
    pullRef.current = v;
    setPullDistance(v);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isTouchDevice()) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current || el.scrollTop > 0) return;
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pullingRef.current || startYRef.current === null) return;
      if (el.scrollTop > 0) {
        // User scrolled into the list — abandon the pull.
        pullingRef.current = false;
        startYRef.current = null;
        setPull(0);
        return;
      }
      const delta = e.touches[0].clientY - startYRef.current;
      if (delta <= 0) {
        setPull(0);
        return;
      }
      e.preventDefault(); // suppress the browser's native overscroll bounce
      setPull(Math.min(delta * RESISTANCE, MAX_PULL));
    };

    const finish = async () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      startYRef.current = null;
      if (pullRef.current < THRESHOLD) {
        setPull(0);
        return;
      }
      refreshingRef.current = true;
      setIsRefreshing(true);
      setPull(THRESHOLD); // hold the spinner at the threshold while loading
      try {
        await onRefreshRef.current();
      } finally {
        refreshingRef.current = false;
        setIsRefreshing(false);
        setPull(0);
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', finish);
    el.addEventListener('touchcancel', finish);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', finish);
      el.removeEventListener('touchcancel', finish);
    };
    // Bind once; listeners read live state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, pullDistance, isRefreshing };
}

/**
 * Renders the pull spinner at the top of a pull-to-refresh container. Place it as
 * the first child of the same element that holds `containerRef`.
 */
export function PullToRefreshIndicator({
  pullDistance,
  isRefreshing,
}: {
  pullDistance: number;
  isRefreshing: boolean;
}) {
  if (pullDistance <= 0 && !isRefreshing) return null;
  const progress = Math.min(pullDistance / THRESHOLD, 1);
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-end justify-center overflow-hidden"
      style={{ height: pullDistance }}
    >
      <div className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card shadow-sm">
        <RefreshCw
          className={cn('h-4 w-4 text-primary', isRefreshing && 'animate-spin')}
          style={isRefreshing ? undefined : { transform: `rotate(${progress * 270}deg)`, opacity: 0.4 + progress * 0.6 }}
        />
      </div>
    </div>
  );
}
