import type { ReactNode } from "react";
import { cx } from "./ReportCards";

/**
 * Semáforo de un reporte: ícono + texto, nunca sólo color (se lee igual
 * en blanco y negro, con daltonismo y al imprimir). Sin estado: lo usan
 * tanto páginas de servidor como componentes cliente.
 *
 *  · ok        cuadra / sin hallazgos (verde, ✓)
 *  · warning   diferencia o algo por revisar (ámbar, !)
 *  · critical  error que hay que corregir (rojo, ✕)
 *  · info      para tener en cuenta (neutro, i)
 *  · empty     sin movimiento (gris, —)
 */
export type StatusTone = "ok" | "warning" | "critical" | "info" | "empty";

// El texto mezcla el color de estado con la tinta del tema: en el claro
// oscurece el ámbar (que solo no llega a 4,5:1) y en el oscuro aclara el
// verde y el rojo, que sobre el fondo noche quedaban apagados.
export const STATUS_TEXT: Record<StatusTone, string> = {
  ok: "text-[color-mix(in_srgb,var(--ok)_80%,var(--op-text))]",
  warning: "text-[color-mix(in_srgb,var(--warn)_62%,var(--op-text))]",
  critical: "text-[color-mix(in_srgb,var(--danger)_85%,var(--op-text))]",
  info: "text-op-muted",
  empty: "text-op-muted",
};

const TONE: Record<StatusTone, string> = {
  ok: `bg-ok/10 border-ok/25 ${STATUS_TEXT.ok}`,
  warning: `bg-warn/10 border-warn/30 ${STATUS_TEXT.warning}`,
  critical: `bg-danger/10 border-danger/25 ${STATUS_TEXT.critical}`,
  info: "bg-op-bg text-op-muted border-op-border",
  empty: "bg-op-bg text-op-muted border-op-border",
};

export function StatusIcon({ tone, className }: { tone: StatusTone; className?: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: cx("shrink-0", className),
  };
  switch (tone) {
    case "ok":
      return (
        <svg {...common}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      );
    case "warning":
      return (
        <svg {...common}>
          <path d="M12 3.5 2.5 20h19L12 3.5Z" />
          <path d="M12 10v4.5M12 17.5v.01" />
        </svg>
      );
    case "critical":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </svg>
      );
    case "info":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5.5M12 7.5v.01" />
        </svg>
      );
    case "empty":
      return (
        <svg {...common}>
          <path d="M7 12h10" />
        </svg>
      );
  }
}

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold leading-tight",
        TONE[tone],
        className,
      )}
    >
      <StatusIcon tone={tone} />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}
