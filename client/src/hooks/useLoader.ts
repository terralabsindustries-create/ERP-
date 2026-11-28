import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data for a screen and keeps the states a list needs apart:
 *
 * - isLoading   nothing loaded yet and a request is running (show skeletons)
 * - isRefreshing data on screen, a newer copy is being fetched
 * - error       the last attempt failed; `data` still holds the last good copy
 * - hasLoaded   at least one load succeeded — only then is an empty result
 *               really "no records"
 *
 * A newer load supersedes an older one (its answer is ignored), the request is
 * cancelled when the screen closes, and polling never overlaps a load still in
 * flight or retries in a tight loop after a failure.
 */
export function useLoader<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  { enabled = true, pollMs }: { enabled?: boolean; pollMs?: number } = {}
) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined);
  const seq = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const id = ++seq.current;
    setRunning(true);
    try {
      const result = await loadRef.current(controller.signal);
      if (id !== seq.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e: any) {
      if (id !== seq.current || e?.kind === "cancelled" || controller.signal.aborted) return;
      setError(e);
    } finally {
      if (id === seq.current) {
        setRunning(false);
        inFlight.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    reload();
    return () => {
      seq.current++;
      inFlight.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reload, ...deps]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const timer = setInterval(() => {
      if (!inFlight.current && document.visibilityState !== "hidden") reload();
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, reload]);

  const hasLoaded = updatedAt !== undefined;
  return {
    data,
    setData,
    error,
    isLoading: running && !hasLoaded,
    isRefreshing: running && hasLoaded,
    hasLoaded,
    updatedAt,
    reload,
  };
}
