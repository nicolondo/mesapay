import type { ReactNode } from "react";
import type { HelpIconName } from "@/content/help/categories";

/** Íconos del centro de ayuda: los de las categorías y los de la interfaz. */
export type HelpUiIconName =
  | HelpIconName
  | "search"
  | "mail"
  | "download"
  | "chevron"
  | "back"
  | "close"
  | "help";

const PATHS: Record<HelpUiIconName, ReactNode> = {
  start: <path d="M5 21V4m0 0h11.5l-2.5 4 2.5 4H5" />,
  tables: (
    <>
      <rect x="4" y="7" width="16" height="10" rx="3" />
      <path d="M8 3h8M8 21h8M2 10v4m20-4v4" />
    </>
  ),
  cash: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6.5 9.5h.01M17.5 14.5h.01" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 17.5h2" />
    </>
  ),
  diner: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20.5a7 7 0 0 1 14 0" />
    </>
  ),
  menu: <path d="M12 5v16M3 3l9 2 9-2v16l-9 2-9-2V3Z" />,
  invoice: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6m-6 4h3" />,
  chart: <path d="M4 20h16M6 16v-5m6 5V7m6 9V3" />,
  team: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0M16 5.3a3 3 0 0 1 0 5.4M18 20a6 6 0 0 0-2.6-4.9" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  printer: (
    <>
      <path d="M7 9V3h10v6" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  download: <path d="M12 4v11m-5-5 5 5 5-5M5 20h14" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  back: <path d="m15 6-6 6 6 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01" />
    </>
  ),
};

export function HelpIcon({
  name,
  className = "h-5 w-5",
}: {
  name: HelpUiIconName | string;
  className?: string;
}) {
  const path = PATHS[name as HelpUiIconName] ?? PATHS.help;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {path}
    </svg>
  );
}
