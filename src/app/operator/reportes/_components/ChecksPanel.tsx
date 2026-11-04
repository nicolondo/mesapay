"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { AuxiliariesPanel } from "./AuxiliariesPanel";
import { Chevron } from "./DrillRow";
import { cx } from "./ReportCards";
import { STATUS_TEXT, StatusBadge, StatusIcon, type StatusTone } from "./StatusBadge";
import { useDrillOpen } from "./useDrillOpen";

/**
 * Panel «Revisar antes de …» (reutilizable): una tarjeta por revisión CON
 * hallazgos —severidad con ícono y texto, qué pasa, qué hacer, la plata
 * involucrada— y un botón que despliega ahí mismo las filas exactas
 * (auxiliares `alerta-<clave>` de la API). Las revisiones que pasaron van
 * plegadas al final con ✓: saber qué se revisó también da confianza.
 *
 * Los textos llegan TRADUCIDOS desde la página (cada reporte sabe qué
 * significan sus revisiones); el panel sólo pinta. El estado abierto vive en
 * la URL como el resto del despliegue (`?abrir=alerta-sinFactura`), así un
 * enlace a «la revisión X» se puede compartir.
 */
export type CheckItem = {
  /** Clave de la revisión: el renglón es `${idPrefix}${key}`. */
  key: string;
  tone: Exclude<StatusTone, "ok" | "empty">;
  severityLabel: string;
  title: string;
  /** Qué significa, en lenguaje claro. */
  body: string;
  /** Qué hacer. */
  action: string;
  /** Cifra involucrada, ya formateada (null = no aplica). */
  amount: string | null;
  /** Filas disponibles para desplegar (0 = sin auxiliares). */
  rows: number;
  /** Suma esperada de las filas (para la comprobación del panel). */
  expectedCents?: number | null;
  amountLabel?: string;
  /** Enlace a donde se corrige (configuración, diario…). */
  link?: { href: string; label: string } | null;
};

export function ChecksPanel({
  title,
  intro,
  items,
  passed,
  endpoint,
  query,
  currency,
  idPrefix = "alerta-",
  id,
}: {
  title: string;
  intro?: string;
  items: CheckItem[];
  /** Títulos de las revisiones sin hallazgos. */
  passed: { key: string; title: string }[];
  endpoint: string;
  query: Record<string, string>;
  currency: string;
  idPrefix?: string;
  /** Ancla de la sección (para enlazar «¿por qué no cuadra?»). */
  id?: string;
}) {
  const t = useTranslations("opReportDrill");
  const drill = useDrillOpen();
  const worst: StatusTone = items.some((i) => i.tone === "critical")
    ? "critical"
    : items.some((i) => i.tone === "warning")
      ? "warning"
      : items.length
        ? "info"
        : "ok";
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="scroll-mt-4 min-w-0 overflow-hidden rounded-2xl border border-op-border bg-op-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-op-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="text-sm font-semibold">
            {title}
          </h2>
          {intro && <p className="mt-0.5 text-xs text-op-muted">{intro}</p>}
        </div>
        <StatusBadge tone={worst}>
          {items.length ? t("findings", { count: items.length }) : t("allClear", { count: passed.length })}
        </StatusBadge>
      </div>

      {items.length > 0 && (
        <ul className="divide-y divide-op-border/60">
          {items.map((it) => {
            const nodeId = `${idPrefix}${it.key}`;
            const open = drill.isOpen(nodeId);
            return (
              <li key={it.key} className="min-w-0">
                <div className="flex min-w-0 gap-3 px-4 py-3">
                  <span className={cx("mt-0.5", STATUS_TEXT[it.tone])}>
                    <StatusIcon tone={it.tone} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <h3 className="min-w-0 text-sm font-semibold break-words">
                        <span className={cx("mr-2 font-mono text-[10px] uppercase tracking-wider", STATUS_TEXT[it.tone])}>
                          {it.severityLabel}
                        </span>
                        {it.title}
                      </h3>
                      {it.amount && <span className="font-mono tabular text-sm font-semibold">{it.amount}</span>}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-op-muted">{it.body}</p>
                    <p className="mt-1 text-sm leading-relaxed">
                      <span className="font-semibold">{t("whatToDo")} </span>
                      {it.action}
                    </p>
                    {(it.rows > 0 || it.link) && (
                      <div className="no-print mt-2 flex flex-wrap gap-2">
                        {it.rows > 0 && (
                          <button
                            type="button"
                            onClick={() => drill.toggle(nodeId)}
                            aria-expanded={open}
                            aria-controls={`drill-panel-${nodeId}`}
                            className="mp-btn mp-btn--secondary mp-btn--sm inline-flex min-h-11 items-center gap-1.5"
                          >
                            <Chevron open={open} />
                            {open ? t("hideRows") : t("seeRows", { count: it.rows })}
                          </button>
                        )}
                        {it.link && (
                          <Link href={it.link.href} prefetch={false} className="mp-btn mp-btn--ghost mp-btn--sm inline-flex min-h-11 items-center">
                            {it.link.label}
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {open && it.rows > 0 && (
                  <div id={`drill-panel-${nodeId}`} className="drill-panel">
                    <AuxiliariesPanel
                      endpoint={endpoint}
                      query={query}
                      nodeId={nodeId}
                      currency={currency}
                      expectedCents={it.expectedCents}
                      amountLabel={it.amountLabel}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {passed.length > 0 && (
        <details className="group border-t border-op-border/60 px-4 py-2 text-sm">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-op-muted [&::-webkit-details-marker]:hidden">
            <span className="transition-transform group-open:rotate-90 motion-reduce:transition-none">
              <Chevron open={false} />
            </span>
            {t("passedSummary", { count: passed.length })}
          </summary>
          <ul className="grid gap-1 pb-2 pl-5 sm:grid-cols-2">
            {passed.map((p) => (
              <li key={p.key} className="flex items-start gap-2 text-op-muted">
                <span className={cx("mt-0.5", STATUS_TEXT.ok)}>
                  <StatusIcon tone="ok" />
                </span>
                <span className="min-w-0 break-words">{p.title}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
