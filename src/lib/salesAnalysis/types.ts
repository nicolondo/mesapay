// Tipos compartidos del análisis de ventas (consultas → página → exportación).
import type { Channel, ReportingMethod, SalesFilters } from "./filters";
import type { DayRange, Granularity } from "./period";
import type { DurationSummary, Kpis, ReturnsSummary, SalesTotals } from "./metrics";
import type { HeatRow } from "./heatmap";
import type { TrendRow } from "./trend";
import type { MenuEngineering } from "./menuEngineering";

export type ProductRow = {
  /** menuItemId, o "libre:<nombre>" para las líneas libres (servicios). */
  key: string;
  menuItemId: string | null;
  name: string;
  categoryId: string | null;
  units: number;
  netCents: number;
  grossCents: number;
  /** Cuentas en las que aparece. */
  orders: number;
};

export type CategoryRow = {
  /** null = líneas libres (no salen de la carta). */
  categoryId: string | null;
  label: string | null;
  parentLabel: string | null;
  units: number;
  netCents: number;
  orders: number;
};

export type ModifierRow = {
  /** Nombre del grupo en la carta actual (null si el plato ya no lo tiene). */
  group: string | null;
  option: string;
  units: number;
  products: number;
};

export type WaiterRow = {
  /** null = cuentas sin mesero identificable. */
  waiterId: string | null;
  name: string | null;
  netCents: number;
  orders: number;
  diners: number;
  /** null = no aplica (filtro por producto o categoría). */
  tipCents: number | null;
  commissionCents: number | null;
};

export type MethodRow = {
  method: ReportingMethod;
  /** Cobrado bruto (aprobado + luego devuelto), con propina. */
  amountCents: number;
  tipCents: number;
  payments: number;
  orders: number;
};

export type ChannelRow = { channel: Channel; netCents: number; orders: number; diners: number };

export type TableRow = {
  tableId: string;
  number: number;
  label: string | null;
  netCents: number;
  orders: number;
  diners: number;
};

export type OrderListRow = {
  id: string;
  shortCode: string;
  paidAt: Date;
  channel: Channel;
  tableNumber: number;
  tableLabel: string | null;
  waiterName: string | null;
  diners: number;
  units: number;
  netCents: number;
  tipCents: number | null;
  totalCents: number;
  methods: ReportingMethod[];
};

export type PeriodData = {
  range: DayRange;
  totals: SalesTotals;
  /** null = no aplica (filtro por producto/categoría). */
  returns: ReturnsSummary | null;
  duration: DurationSummary;
  trend: TrendRow[];
  products: ProductRow[];
  categories: CategoryRow[];
  waiters: WaiterRow[];
  methods: MethodRow[];
  channels: ChannelRow[];
};

export type FilterOptions = {
  waiters: { id: string; name: string; disabled: boolean }[];
  categories: { id: string; label: string; parentLabel: string | null }[];
  products: { id: string; name: string; categoryId: string }[];
  tables: { id: string; number: number; label: string | null }[];
};

export type SalesAnalysis = {
  filters: SalesFilters;
  today: string;
  cutoffHour: number;
  counterMode: boolean;
  itemFilter: boolean;
  range: DayRange;
  compareRange: DayRange | null;
  granularity: Granularity;
  current: PeriodData;
  compare: PeriodData | null;
  kpis: Kpis;
  compareKpis: Kpis | null;
  heat: HeatRow[];
  tables: TableRow[];
  modifiers: ModifierRow[];
  /** Cuentas del día (sólo cuando el período es un único día). */
  orders: OrderListRow[] | null;
  ordersTruncated: boolean;
  /** Productos disponibles en la carta que no vendieron en el período. */
  unsold: { id: string; name: string }[];
  /** null = módulo de recetas apagado. */
  engineering: MenuEngineering | null;
  options: FilterOptions;
};
