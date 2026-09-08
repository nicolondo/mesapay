"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { currentMonthRange } from "@/lib/monthRange";

/**
 * Rango de fechas del reporte de consumo. El default (mes en curso) lo
 * resuelve el server; acá solo se navega con ?from=&to=, así que el
 * enlace se puede compartir y recargar sin perder el rango.
 */
export function RangePicker({ from, to }: { from: string; to: string }) {
  const t = useTranslations("opCustomers");
  const router = useRouter();
  const pathname = usePathname();
  const [f, setF] = useState(from);
  const [tt, setTt] = useState(to);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    router.push(`${pathname}?from=${f}&to=${tt}`);
  }

  function thisMonth() {
    const r = currentMonthRange();
    setF(r.from);
    setTt(r.to);
    router.push(`${pathname}?from=${r.from}&to=${r.to}`);
  }

  return (
    <form onSubmit={apply} className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {t("rangeFrom")}
        </span>
        <input
          type="date"
          value={f}
          onChange={(e) => setF(e.target.value)}
          className="mt-1 h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
        />
      </label>
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          {t("rangeTo")}
        </span>
        <input
          type="date"
          value={tt}
          onChange={(e) => setTt(e.target.value)}
          className="mt-1 h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
        />
      </label>
      <button
        type="submit"
        className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium"
      >
        {t("rangeApply")}
      </button>
      <button
        type="button"
        onClick={thisMonth}
        className="h-10 px-4 rounded-full border border-hairline text-sm text-ink"
      >
        {t("rangeThisMonth")}
      </button>
    </form>
  );
}
