import type { SVGProps } from "react";

// Íconos propios de Inventario, con el mismo trazo que @/components/ui/Icon
// (24×24, stroke 1.65, puntas redondeadas). Decorativos: el texto o el
// aria-label del control que los contiene dicen qué hacen.
export type InventoryIconName = "more" | "barcode" | "alert" | "plus" | "minus" | "adjust" | "settings" | "search" | "close" | "chevronLeft" | "chevronRight" | "list" | "pencil" | "archive" | "restore" | "check" | "circle" | "arrowUp" | "arrowDown" | "chevronDown" | "swap" | "info" | "trash";

const paths: Record<InventoryIconName, React.ReactNode> = {
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  barcode: <path d="M4 6v12M7 6v12M10.5 6v12M14 6v12M16.5 6v12M20 6v12" />,
  alert: (
    <>
      <path d="M10.3 4.2 2.8 17.4A2 2 0 0 0 4.5 20.4h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 16.8h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  adjust: <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" />,
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chevronLeft: <path d="m15 6-6 6 6 6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  pencil: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4" />,
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </>
  ),
  restore: <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6M4 4v4.6h4.6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  circle: <circle cx="12" cy="12" r="7.5" />,
  arrowUp: <path d="M12 19V5m0 0-6 6m6-6 6 6" />,
  arrowDown: <path d="M12 5v14m0 0-6-6m6 6 6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  swap: <path d="M4 8h14m0 0-4-4m4 4-4 4M20 16H6m0 0 4-4m-4 4 4 4" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6h.01" />
    </>
  ),
  trash: <path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5" />,
};

export function InvIcon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: InventoryIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
