import type { CSSProperties, ReactNode } from "react";

/**
 * Piezas de la vista MÓVIL de los reportes (pantallas de menos de 768px).
 * Sin «use client» ni imports de servidor: las usan tanto las páginas
 * (server components) como `StatementTree` y `GeneralLedgerView` (client).
 * El CSS vive en `workspace.css` («Reportes contables») y el bloque
 * `@media print` de `ReportShell.tsx` lo refuerza.
 *
 *  · <ReportTable>  envuelve la tabla OFICIAL: desplazamiento horizontal
 *    sólo dentro de la tarjeta; en el celular se oculta porque al lado va
 *    una <ReportCards>; al imprimir sale SIEMPRE, con todas las filas.
 *  · <ReportCards>  la vista apilada del celular: una tarjeta por fila con
 *    los 3-4 datos clave. Lleva `no-print`: el papel es de la tabla.
 *  · <CardFacts>    mini-grilla rótulo → valor en 2 columnas, con los
 *    MISMOS rótulos que los encabezados de la tabla.
 *  · <CardTotal>    la fila de totales de la vista apilada.
 *  · <ReportScroll> para tablas sin vista apilada: sólo el scroll interno
 *    (regla mínima: la página nunca se desplaza de lado).
 */
export type CardFact = {
  label: string;
  value: ReactNode;
  tone?: "danger" | "accent" | "muted";
  strong?: boolean;
};

export function cx(...parts: Array<string | undefined | null | false>): string {
  return parts.filter(Boolean).join(" ");
}

/** `style` con la variable `--depth` que lee `.report-indent`. */
export function depthStyle(depth: number): CSSProperties {
  return { "--depth": depth } as CSSProperties;
}

export function ReportScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("report-scroll", className)}>{children}</div>;
}

export function ReportTable({ children }: { children: ReactNode }) {
  return <div className="report-table">{children}</div>;
}

export function ReportCards({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("report-cards no-print divide-y divide-op-border/50 text-sm", className)}>
      {children}
    </div>
  );
}

const TONE: Record<NonNullable<CardFact["tone"]>, string> = {
  danger: "text-danger",
  accent: "text-op-accent",
  muted: "text-op-muted",
};

export function CardFacts({ items, className }: { items: CardFact[]; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-2 gap-x-3 gap-y-1.5", className)}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="font-mono text-[9px] uppercase tracking-wider text-op-muted">{it.label}</dt>
          <dd
            className={cx(
              "font-mono tabular text-[13px] whitespace-nowrap",
              it.strong && "font-semibold",
              it.tone && TONE[it.tone],
            )}
          >
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CardTotal({ label, items }: { label: ReactNode; items: CardFact[] }) {
  return (
    <div className="border-t-2 border-op-border bg-op-bg px-3 py-2 font-semibold">
      <div>{label}</div>
      <CardFacts className="mt-1.5" items={items} />
    </div>
  );
}
