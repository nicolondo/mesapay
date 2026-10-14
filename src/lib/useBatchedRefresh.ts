"use client";

import { useCallback, useEffect, useRef } from "react";
import { createRefreshBatch } from "./liveRefresh";

/** Batch only view invalidations. Notification/printing listeners still receive every event. */
export function useBatchedRefresh(refresh: () => void, scope: string, enabled = true) {
  const latest = useRef(refresh);
  const batch = useRef<ReturnType<typeof createRefreshBatch> | null>(null);
  useEffect(() => { latest.current = refresh; });

  useEffect(() => {
    if (!enabled) return;
    const current = createRefreshBatch(() => {
      if (document.visibilityState === "visible") latest.current();
    });
    batch.current = current;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") current.cancel();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      current.dispose();
      batch.current = null;
    };
  }, [scope, enabled]);

  return useCallback(() => {
    if (document.visibilityState === "visible") batch.current?.request();
  }, []);
}
