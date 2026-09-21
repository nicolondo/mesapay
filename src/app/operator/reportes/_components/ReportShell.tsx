import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

/**
 * `<ReportShell>` — el cascarón de los reportes contables. Portado de
 * zenith `report-shell.tsx` + `libro-shared.tsx` (`LibroHeader`).
 *
 * Orden fijo de la pantalla:
 *  1. encabezado legal del libro (`print`) — solo al imprimir;
 *  2. volver + título (`no-print`);
 *  3. barra de filtros (`filters`, un `<form method="get">`) + acciones
 *     (`actions`: CSV, imprimir);
 *  4. teselas de indicador (`stats`);
 *  5. el resultado (`children`);
 *  6. nota al pie (`note`): criterio contable o marco normativo.
 *
 * IMPRESIÓN: la raíz lleva `.report-print`; el bloque `@media print` aísla
 * el reporte, fuerza tinta NEGRA (los tokens del tema noche imprimirían
 * casi en blanco), oculta `.no-print` y numera los FOLIOS con contadores
 * de página (`@page` margin boxes; Chrome los imprime, otros navegadores
 * sacan la página sin folio). Las filas plegadas en pantalla se vuelven a
 * mostrar en papel (`.report-row-hidden`): en un libro, imprimir de menos
 * sin que el usuario se entere es peor que imprimir de más.
 */
export type ReportPrintHeader = {
  businessName: string;
  taxId: string | null;
  /** Título legal del libro (el que sale impreso). */
  title: string;
  /** Período y criterio del libro, en una línea. */
  subtitle: string;
};

const STAT_COLS = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
} as const;

function cx(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" ");
}

export async function ReportShell({
  title,
  description,
  print,
  filters,
  actions,
  stats,
  statCols = 3,
  children,
  note,
  backHref = "/operator/reportes",
}: {
  title: string;
  description?: string;
  print?: ReportPrintHeader;
  filters?: ReactNode;
  actions?: ReactNode;
  stats?: ReactNode;
  statCols?: keyof typeof STAT_COLS;
  children?: ReactNode;
  note?: ReactNode;
  backHref?: string;
}) {
  const t = await getTranslations("opReportes");
  const footer = print
    ? `${print.businessName}${print.taxId ? ` — ${t("taxIdLabel", { taxId: print.taxId })}` : ""}`
        .replaceAll('"', "'")
    : "";
  const folio = `"${t("folio").replaceAll('"', "'")} " counter(page) " ${t("folioOf").replaceAll('"', "'")} " counter(pages)`;
  const css = `
@media print {
  body * { visibility: hidden; }
  .report-print, .report-print * { visibility: visible; }
  .report-print { position: absolute; left: 0; top: 0; width: 100%; max-width: none; padding: 0; margin: 0; }
  .report-print, .report-print * {
    color: #000 !important;
    background: transparent !important;
    border-color: #999 !important;
    box-shadow: none !important;
  }
  .no-print { display: none !important; }
  .report-print-header { display: block !important; }
  .report-print tr.report-row-hidden { display: table-row !important; }
  .report-print table { font-size: 10pt; }
  .report-print thead { display: table-header-group; }
  .report-print tr { break-inside: avoid; }
}
@page {
  margin: 16mm 12mm;
  @bottom-left { content: "${footer}"; font-size: 8pt; color: #555; }
  @bottom-right { content: ${folio}; font-size: 8pt; color: #555; }
}`;

  return (
    <div className="report-print p-4 sm:p-6 max-w-6xl mx-auto w-full space-y-4">
      <style dangerouslySetInnerHTML={{ __html: css }} />

      {print && (
        <div className="report-print-header hidden border-b border-op-border pb-3">
          <div className="text-base font-semibold">{print.businessName}</div>
          {print.taxId && (
            <div className="text-sm text-op-muted">{t("taxIdLabel", { taxId: print.taxId })}</div>
          )}
          <div className="mt-1 text-sm font-semibold uppercase tracking-wide">{print.title}</div>
          <div className="text-xs text-op-muted">{print.subtitle}</div>
        </div>
      )}

      <div className="no-print">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-op-muted hover:text-op-text mb-2"
        >
          ← {t("backToReports")}
        </Link>
        <div className="font-display text-3xl">{title}</div>
        {description && <p className="text-sm text-op-muted mt-1">{description}</p>}
      </div>

      {(filters || actions) && (
        <div className="no-print flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 w-full lg:w-auto lg:flex-1">{filters}</div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}

      {stats && <div className={cx("grid gap-2 sm:gap-3", STAT_COLS[statCols])}>{stats}</div>}

      {children}

      {note && <p className="text-xs text-op-muted">{note}</p>}
    </div>
  );
}

/** Tesela de indicador (comprobantes, total débitos…). */
export function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-xl border border-op-border bg-op-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-op-muted">{label}</div>
      <div
        className={cx(
          "mt-1 text-lg font-semibold tabular",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Tarjeta de VERIFICACIÓN: la comprobación de cuadre del reporte
 * («Cuadrado ✓» / «Descuadre de X»).
 */
export async function ReportCheck({
  title,
  description,
  ok,
  okLabel,
  failLabel,
}: {
  title?: string;
  /** Las dos cifras que se comparan, en prosa. */
  description: ReactNode;
  ok: boolean;
  okLabel?: string;
  /** Qué decir cuando NO cuadra (incluye la diferencia). */
  failLabel: ReactNode;
}) {
  const t = await getTranslations("opReportes");
  return (
    <div className="rounded-xl border border-op-border bg-op-surface px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-op-muted">
          {title ?? t("checkTitle")}
        </div>
        <p className="text-sm text-op-muted mt-1">{description}</p>
      </div>
      <span
        className={cx(
          "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold",
          ok ? "bg-op-accent/10 text-op-accent" : "bg-danger/10 text-danger",
        )}
      >
        {ok ? (okLabel ?? t("balancedOk")) : failLabel}
      </span>
    </div>
  );
}

/**
 * Barra de filtros por GET: sin JavaScript, los valores viven en la URL y
 * el reporte se comparte con su filtro puesto. `keep` mete como campos
 * ocultos los parámetros que el formulario no edita (p. ej. `abrir`) para
 * que «Aplicar» no los pierda.
 */
export async function ReportFilterForm({
  children,
  keep = {},
  note,
}: {
  children: ReactNode;
  keep?: Record<string, string | undefined | null>;
  note?: ReactNode;
}) {
  const t = await getTranslations("opReportes");
  return (
    <form
      method="get"
      className="rounded-2xl border border-op-border bg-op-surface p-3 sm:p-4"
    >
      {Object.entries(keep).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      <div className="flex flex-wrap items-end gap-3">
        {children}
        <button type="submit" className="mp-btn mp-btn--secondary mp-btn--sm">
          {t("apply")}
        </button>
      </div>
      {note && <p className="mt-2 text-xs text-op-muted">{note}</p>}
    </form>
  );
}

/** Etiqueta pequeña sobre un control del formulario de filtros. */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0">
      <span className="block text-[11px] uppercase tracking-wider text-op-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

/**
 * Pestañas de un reporte (modo detallado/resumido…) como enlaces reales:
 * el estado vive en la URL, se puede abrir en otra pestaña y compartir.
 */
export function ReportTabs<T extends string>({
  options,
  active,
  href,
  label,
}: {
  options: readonly { key: T; label: string }[];
  active: T;
  href: (key: T) => string;
  /** Nombre accesible del grupo. */
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="mp-seg no-print">
      {options.map((o) => (
        <Link
          key={o.key}
          href={href(o.key)}
          aria-current={o.key === active ? "page" : undefined}
          data-active={o.key === active ? "true" : undefined}
          className="mp-seg__i"
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

/** Descarga del CSV: un enlace a la API con los MISMOS filtros de la pantalla. */
export async function CsvButton({ href }: { href: string }) {
  const t = await getTranslations("opReportes");
  return (
    <a href={href} className="mp-btn mp-btn--ghost mp-btn--sm no-print" download>
      {t("exportCsv")}
    </a>
  );
}

/** Arma la URL de la API con los filtros vigentes + `format=csv`. */
export function csvHref(apiPath: string, params: Record<string, string | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  sp.set("format", "csv");
  return `${apiPath}?${sp.toString()}`;
}

/** Aviso vacío («sin movimientos en el período»). */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
      {children}
    </div>
  );
}
