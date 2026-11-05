// Lista de comensales registrados de /operator/clientes (pestaña
// "Comensales registrados"): filtros de la URL y orden. Puro —sin DB—; la
// consulta vive en `dinerListQueries.ts`.
//
// Antes la pantalla traía los 500 registros más recientes (`take: 500`) y
// los ordenaba por consumo en memoria: un comensal viejo que más había
// consumido podía quedar fuera sin aviso, y sólo se encontraba por cédula o
// correo EXACTOS. Ahora la búsqueda y el orden corren en la base sobre todos
// los comensales del comercio, con paginación.
import { CUSTOMERS_PATH, parsePage } from "@/lib/billingCustomerList";

export const DINER_PAGE_SIZE = 50;
export const DINER_QUERY_MAX = 120;

/** Mayor consumo (lo de siempre), registro más reciente o nombre. */
export type DinerSort = "spend" | "recent" | "name";
export const DINER_SORTS: readonly DinerSort[] = ["spend", "recent", "name"];

export type DinerListParams = {
  /** Nombre, correo o cédula (contiene). */
  q: string;
  sort: DinerSort;
  page: number;
};

export const DEFAULT_DINER_LIST_PARAMS: DinerListParams = { q: "", sort: "spend", page: 1 };

/** Pestaña de /operator/clientes. */
export type CustomersView = "billing" | "diners";

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * Pestaña pedida. Quien no gestiona clientes de facturación sólo tiene la
 * de comensales.
 */
export function parseCustomersView(sp: RawParams, canManageBilling: boolean): CustomersView {
  if (!canManageBilling) return "diners";
  return first(sp.view) === "diners" ? "diners" : "billing";
}

export function parseDinerListParams(sp: RawParams): DinerListParams {
  const sort = first(sp.sort);
  return {
    q: first(sp.q).trim().slice(0, DINER_QUERY_MAX),
    sort: (DINER_SORTS as readonly string[]).includes(sort) ? (sort as DinerSort) : "spend",
    page: parsePage(sp.page),
  };
}

/** Query string de la pestaña de comensales, sin los valores por defecto. */
export function dinerListQuery(params: Partial<DinerListParams>): string {
  const qs = new URLSearchParams({ view: "diners" });
  if (params.q) qs.set("q", params.q);
  if (params.sort && params.sort !== "spend") qs.set("sort", params.sort);
  if (params.page && params.page > 1) qs.set("page", String(params.page));
  return qs.toString();
}

export function dinerListHref(params: Partial<DinerListParams>): string {
  return `${CUSTOMERS_PATH}?${dinerListQuery(params)}`;
}

export type DinerListSummary = {
  count: number;
  /** Con al menos una cuenta pagada en este comercio. */
  withOrders: number;
  totalCents: number;
};
