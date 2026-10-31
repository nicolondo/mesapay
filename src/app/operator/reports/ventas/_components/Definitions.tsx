// «¿Cómo se calcula?»: cada cifra explicada en lenguaje simple, con las
// mismas definiciones de `@/lib/salesAnalysis/metrics`.
import type { Tr } from "@/lib/salesAnalysis/dimLabels";

const TERMS = [
  "sale",
  "net",
  "gross",
  "tax",
  "discounts",
  "comps",
  "returns",
  "tips",
  "orders",
  "ticket",
  "units",
  "tableTime",
  "waiter",
  "products",
  "methods",
  "businessDay",
] as const;

export function Definitions({ t, cutoffHour }: { t: Tr; cutoffHour: number }) {
  return (
    <details className="mp-panel mp-sales-definitions">
      <summary>{t("def.title")}</summary>
      <dl>
        {TERMS.map((term) => (
          <div key={term}>
            <dt>{t(`def.${term}.term`)}</dt>
            <dd>{t(`def.${term}.body`, { hour: String(cutoffHour).padStart(2, "0") })}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
