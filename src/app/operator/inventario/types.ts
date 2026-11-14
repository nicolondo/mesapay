import type { StockLevelView, StockRowView } from "@/lib/erp/inventoryView";
import type { MeasureKind } from "@/lib/erp/units";

export type StockLevel = StockLevelView;
export type StockRow = StockRowView;

export type Tab = "stock" | "movements" | "counts";
export type SheetMode = "entry" | "adjust" | "waste";

/** Pestaña ↔ valor de `?tab=` (enlazable desde la ayuda y el menú). */
export const TAB_PARAM: Record<Tab, string> = { stock: "existencias", movements: "movimientos", counts: "conteos" };

export function tabFromParam(value: string | null | undefined): Tab {
  const hit = (Object.entries(TAB_PARAM) as [Tab, string][]).find(([, param]) => param === value);
  return hit ? hit[0] : "stock";
}

export type MovementRow = {
  id: string;
  kind: string;
  qtyBase: number;
  valueCents: number;
  wasteReason: string | null;
  note: string | null;
  createdAt: string;
  ingredient: { id: string; name: string; measureKind: MeasureKind };
  createdBy: { id: string; name: string | null } | null;
};

// ── Conteos (spec D5): sesión borrador → cierre con ajustes ──
export type CountSummary = {
  id: string;
  status: "draft" | "closed";
  revision: number;
  preliminaryAt: string | null;
  recountStartedAt: string | null;
  finalReview: { token: string; revision: number } | null;
  notes: string | null;
  createdAt: string;
  closedAt: string | null;
  createdBy: { name: string | null } | null;
  _count: { items: number };
};

export type CountItemRow = {
  id: string;
  expectedQty: number;
  countedQty: number | null;
  countedParts?: number[];
  preliminaryQty: number | null;
  preliminaryParts?: number[];
  finalExpectedQty: number | null;
  ingredient: {
    id: string;
    name: string;
    measureKind: MeasureKind;
    category: string | null;
    active: boolean;
    trackInventory: boolean;
    // Código de barras del empaque — lo usa el escaneo del conteo.
    barcode: string | null;
    barcodes: { barcode: string }[];
  };
};

export type CountDetail = Omit<CountSummary, "_count"> & {
  items: CountItemRow[];
  /** Snapshot del conteo definitivo; trae el plan de qué recontar (recountPlan.ts). */
  recountSnapshot?: unknown;
};

/** Etiqueta (clave i18n) de la etapa/estado de una sesión de conteo. */
export function countStageKey(c: Pick<CountSummary, "status" | "preliminaryAt" | "recountStartedAt">): string {
  if (c.status !== "draft") return "countStatusClosed";
  return c.recountStartedAt ? "countStageDefinitive" : c.preliminaryAt ? "countStagePreliminary" : "countStageInitial";
}

// Claves i18n por kind de movimiento — resueltas con t() al render.
// Kinds futuros caen al código crudo.
export const KIND_LABEL_KEYS: Record<string, string> = {
  purchase_in: "kindPurchaseIn",
  adjust_in: "kindAdjustIn",
  adjust_out: "kindAdjustOut",
  waste: "kindWaste",
  count_adjust: "kindCountAdjust",
  // A4 — consumo automático por venta (lo escribe el server al pagar).
  sale_consumption: "kindSaleConsumption",
  // A5 — producción de lotes (los escribe /operator/produccion).
  production_in: "kindProductionIn",
  production_out: "kindProductionOut",
};

export const WASTE_REASONS = ["expired", "damaged", "kitchen_error", "spill", "other"] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export const WASTE_REASON_KEYS: Record<string, string> = {
  expired: "wasteExpired",
  damaged: "wasteDamaged",
  kitchen_error: "wasteKitchenError",
  spill: "wasteSpill",
  other: "wasteOther",
};
