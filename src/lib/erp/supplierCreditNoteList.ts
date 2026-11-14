// Lista de notas crédito de proveedores (Compras › Notas crédito) — PURO:
// parámetros de la URL, enlaces y tipos de las filas. La consulta vive en
// supplierCreditNoteQueries.ts.
import { isSupplierCreditNoteKind, type SupplierCreditNoteKind } from "./supplierCreditNotes";

export const CREDIT_NOTE_STATUS_FILTERS = ["all", "with_balance", "active", "voided"] as const;
export type CreditNoteStatusFilter = (typeof CREDIT_NOTE_STATUS_FILTERS)[number];

export const CREDIT_NOTE_PAGE_SIZE = 25;

export type CreditNoteListParams = {
  q: string;
  supplier: string;
  kind: SupplierCreditNoteKind | "all";
  status: CreditNoteStatusFilter;
  /** yyyy-mm-dd o "". */
  from: string;
  to: string;
  page: number;
};

export const DEFAULT_CREDIT_NOTE_PARAMS: CreditNoteListParams = {
  q: "",
  supplier: "",
  kind: "all",
  status: "all",
  from: "",
  to: "",
  page: 1,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export function parseCreditNoteListParams(sp: Record<string, string | string[] | undefined>): CreditNoteListParams {
  const kind = first(sp.tipo);
  const status = first(sp.estado);
  const page = Number.parseInt(first(sp.pagina), 10);
  const supplier = first(sp.proveedor);
  return {
    q: first(sp.q).slice(0, 80),
    supplier: /^[a-z0-9]{10,40}$/i.test(supplier) ? supplier : "",
    kind: isSupplierCreditNoteKind(kind) ? kind : "all",
    status: (CREDIT_NOTE_STATUS_FILTERS as readonly string[]).includes(status) ? (status as CreditNoteStatusFilter) : "all",
    from: DAY.test(first(sp.desde)) ? first(sp.desde) : "",
    to: DAY.test(first(sp.hasta)) ? first(sp.hasta) : "",
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

export const CREDIT_NOTES_PATH = "/operator/compras/notas-credito";

/** URL de la lista con esos filtros (sólo los que no son el valor por defecto). */
export function creditNoteListHref(p: Partial<CreditNoteListParams> & { nota?: string | null }): string {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  if (p.supplier) qs.set("proveedor", p.supplier);
  if (p.kind && p.kind !== "all") qs.set("tipo", p.kind);
  if (p.status && p.status !== "all") qs.set("estado", p.status);
  if (p.from) qs.set("desde", p.from);
  if (p.to) qs.set("hasta", p.to);
  if (p.page && p.page > 1) qs.set("pagina", String(p.page));
  if (p.nota) qs.set("nota", p.nota);
  const s = qs.toString();
  return s ? `${CREDIT_NOTES_PATH}?${s}` : CREDIT_NOTES_PATH;
}

export function hasCreditNoteFilters(p: CreditNoteListParams): boolean {
  return Boolean(p.q || p.supplier || p.kind !== "all" || p.status !== "all" || p.from || p.to);
}

export type CreditNoteRow = {
  id: string;
  number: string;
  /** ISO (mediodía de Colombia). */
  date: string;
  kind: SupplierCreditNoteKind;
  agreement: string | null;
  supplier: { id: string; name: string; taxId: string | null };
  totalCents: number;
  ivaCents: number;
  appliedCents: number;
  refundedCents: number;
  availableCents: number;
  status: "active" | "voided";
  hasCude: boolean;
  attachmentUrl: string | null;
};

export type CreditNoteSummary = {
  count: number;
  totalCents: number;
  /** Saldo a favor vigente de las notas que cumplen el filtro. */
  availableCents: number;
  byKind: Record<SupplierCreditNoteKind, number>;
};

export type CreditNoteListPage = {
  rows: CreditNoteRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: CreditNoteSummary;
};
