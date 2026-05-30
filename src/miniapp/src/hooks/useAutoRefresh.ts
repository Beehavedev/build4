import { useEffect, useRef } from 'react'

export interface UseAutoRefreshOptions {
  // How often (ms) to silently re-pull while the page is open.
  intervalMs: number
  // While true, periodic ticks are skipped — wire this to the page's
  // write-action flag(s) (a swap/transfer/order/claim in flight) so a
  // background refresh never races a mutation or its post-action reload.
  paused?: boolean
  // While false, the hook does nothing (no mount load, no interval). Use
  // for pages that can't load until some prerequisite resolves (e.g. a
  // userId). When it flips true the mount load fires immediately.
  enabled?: boolean
  // Run an immediate load when the effect first activates (default true).
  // Set false when the page already does its own first-paint load (e.g.
  // a non-silent mount fetch that drives a full-screen loading state) and
  // only wants the hook for the background interval.
  immediate?: boolean
  // Fire an immediate refresh the moment the tab becomes visible again so
  // the user sees fresh numbers on return instead of waiting a full
  // interval (default true).
  refreshOnVisible?: boolean
}

export interface AutoRefreshHandle {
  // Manually trigger a refresh, sharing the same single-flight guard the
  // interval uses (so a manual tap can't overlap a periodic tick).
  refresh: () => Promise<void>
  // Whether a refresh is currently in flight.
  isRefreshing: () => boolean
}

/**
 * Keep an open page's numbers live without re-opening it. Calls `load` on an
 * interval while the tab is visible, with three guarantees so a left-open tab
 * stays fresh without flicker or duplicate fetches:
 *
 *  - Single-flight: a periodic tick (or visibility refresh, or manual
 *    `refresh()`) can never overlap an in-progress load, so a slow upstream
 *    can't stack overlapping requests.
 *  - Write-safe: ticks are skipped while `paused` is true, so a background
 *    refresh never races a mutation or the post-action reload that owns the
 *    refresh after a write settles.
 *  - Visibility-aware: ticks are skipped while the tab is hidden (no quota
 *    burn for a screen the user can't see), and an immediate refresh fires
 *    when the tab becomes visible again.
 *
 * `load` should leave the last-good values in place on a transient failure
 * (catch + keep state) so there is no flash of empty state between polls.
 */
export function useAutoRefresh(
  load: () => void | Promise<void>,
  options: UseAutoRefreshOptions,
): AutoRefreshHandle {
  const {
    intervalMs,
    paused = false,
    enabled = true,
    immediate = true,
    refreshOnVisible = true,
  } = options

  // Keep the latest `load` / `paused` in refs so the interval effect can stay
  // mounted across renders (it doesn't re-subscribe every time the closure or
  // the paused flag changes) while still seeing current values.
  const loadRef = useRef(load)
  loadRef.current = load
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const loadingRef = useRef(false)

  // Stable single-flight wrapper shared by the interval, the visibility
  // refresh, and the returned manual `refresh()`.
  const runLoad = useRef(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      await loadRef.current()
    } finally {
      loadingRef.current = false
    }
  }).current

  useEffect(() => {
    if (!enabled) return
    if (immediate) void runLoad()

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (pausedRef.current || loadingRef.current) return
      void runLoad()
    }
    const id = window.setInterval(tick, intervalMs)

    let onVisible: (() => void) | undefined
    if (refreshOnVisible && typeof document !== 'undefined') {
      onVisible = () => { if (!document.hidden) tick() }
      document.addEventListener('visibilitychange', onVisible)
    }

    return () => {
      window.clearInterval(id)
      if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, intervalMs, immediate, refreshOnVisible, runLoad])

  return {
    refresh: runLoad,
    isRefreshing: () => loadingRef.current,
  }
}
