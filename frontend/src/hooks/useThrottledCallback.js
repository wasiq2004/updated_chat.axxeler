import { useRef, useEffect, useCallback } from 'react';

// Returns a throttled wrapper around `fn`: it runs immediately on the first call,
// then at most once per `waitMs`, always firing a trailing call so the last event
// in a burst is never dropped. Used to collapse a flurry of real-time SSE events
// (e.g. a broadcast inserting many rows) into a small number of refetches.
//
// The returned function is stable for a fixed `waitMs`, so it is safe to list in
// effect/callback dependency arrays.
export function useThrottledCallback(fn, waitMs = 1000) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastRunRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return useCallback(() => {
    const now = Date.now();
    const since = now - lastRunRef.current;
    if (since >= waitMs) {
      lastRunRef.current = now;
      fnRef.current();
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastRunRef.current = Date.now();
        fnRef.current();
      }, waitMs - since);
    }
  }, [waitMs]);
}
