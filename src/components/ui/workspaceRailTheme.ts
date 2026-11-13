import type { CSSProperties } from "react";

/** Shared rail palette: content may change theme, the navigation stays dark. */
export const WORKSPACE_RAIL_THEME = {
  "--rail": "#151109",
  "--rail-2": "#1C1710",
  "--rail-line": "#2C2418",
  "--rail-line-2": "#3A3020",
  "--rail-text": "#F1EADD",
  "--rail-muted": "#9C9184",
  // The brand accent is inherited from globals.css in both portals.
} as CSSProperties;
