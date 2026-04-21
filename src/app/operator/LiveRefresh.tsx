"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

export function LiveRefresh({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const [, startTx] = useTransition();

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    let last = 0;
    const onMsg = () => {
      const now = Date.now();
      if (now - last < 800) return;
      last = now;
      startTx(() => router.refresh());
    };
    es.addEventListener("message", onMsg);
    return () => {
      es.removeEventListener("message", onMsg);
      es.close();
    };
  }, [tenantSlug, router]);

  return null;
}
