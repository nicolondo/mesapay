import type { SVGProps } from "react";

export type IconName =
  | "overview"
  | "tables"
  | "kitchen"
  | "bar"
  | "serve"
  | "calendar"
  | "orders"
  | "menu"
  | "business"
  | "settings"
  | "help"
  | "search"
  | "arrow"
  | "close"
  | "plus";
const paths: Record<IconName, React.ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  tables: (
    <>
      <rect x="4" y="7" width="16" height="10" rx="3" />
      <path d="M8 3h8M8 21h8M2 10v4m20-4v4" />
    </>
  ),
  kitchen: (
    <>
      <path d="M7 14a4 4 0 0 1-2-7 4 4 0 0 1 7-3 4 4 0 0 1 7 3 4 4 0 0 1-2 7v6H7zM7 16h10" />
    </>
  ),
  bar: (
    <>
      <path d="m4 3 8 10 8-10H4Zm8 10v8m-4 0h8M7 7h10" />
    </>
  ),
  serve: (
    <>
      <path d="M3 17h18M5 14a7 7 0 0 1 14 0H5Zm7-9V3M7 21h10" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3" />
    </>
  ),
  orders: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6m-6 4h3" />
    </>
  ),
  menu: (
    <>
      <path d="M12 5v16M3 3l9 2 9-2v16l-9 2-9-2V3Z" />
    </>
  ),
  business: (
    <>
      <path d="M4 20h16M6 16v-5m6 5V7m6 9V3" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
};
export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
export function routeIcon(href: string): IconName {
  const part = href.split("/")[2] ?? "";
  return (
    (
      {
        "": "overview",
        tables: "tables",
        kitchen: "kitchen",
        bar: "bar",
        serve: "serve",
        reservas: "calendar",
        orders: "orders",
        clientes: "orders",
        payments: "business",
        facturas: "orders",
        menu: "menu",
        menus: "menu",
        settings: "settings",
        ayuda: "help",
      } as Record<string, IconName>
    )[part] ?? "business"
  );
}
