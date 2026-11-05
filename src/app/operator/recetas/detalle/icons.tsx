// Iconos de trazo del detalle de receta (mismo lenguaje que
// @/components/ui/Icon: 24×24, trazo 2, puntas redondas). Decorativos: el
// texto de al lado da el sentido.

import type { ReactNode } from "react";

type P = { className?: string; size?: number };

function Svg({
  className = "",
  size = 14,
  children,
}: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={"shrink-0 " + className}
    >
      {children}
    </svg>
  );
}

export function WarningIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5m0 3h.01" />
    </Svg>
  );
}

export function InfoIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8h.01" />
    </Svg>
  );
}

export function AlertIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6m0 4h.01" />
    </Svg>
  );
}

export function ChevronIcon({ open = false, ...p }: P & { open?: boolean }) {
  return (
    <Svg
      {...p}
      className={
        (p.className ?? "") +
        " transition-transform duration-150 motion-reduce:transition-none " +
        (open ? "rotate-90" : "")
      }
    >
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

export function ExternalIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}

export function CheckIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m5 12 5 5L19 7" />
    </Svg>
  );
}
