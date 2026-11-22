"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { parseSalesFilters } from "@/lib/salesAnalysis/filters";
import { restoredPeriodHref, serializePeriod } from "@/lib/salesAnalysis/periodMemory";

export function PeriodMemory({ restaurantId }: { restaurantId: string }) {
  const router = useRouter();
  const search = useSearchParams().toString();

  useEffect(() => {
    const key = `mesapay.sales.period.v1.${restaurantId}`;
    try {
      if (search) {
        const filters = parseSalesFilters(new URLSearchParams(search));
        localStorage.setItem(key, serializePeriod(filters, Date.now()));
      } else {
        const href = restoredPeriodHref(search, localStorage.getItem(key), Date.now());
        if (href) router.replace(href, { scroll: false });
      }
    } catch {
      // El informe sigue funcionando cuando el navegador bloquea localStorage.
    }
  }, [restaurantId, router, search]);

  return null;
}
