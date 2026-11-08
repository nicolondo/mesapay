"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fixReviewPriceAsTotal, resolveReviewInvoice, reviewLineAmounts, reviewLineDiscountDetail, reviewLineQtyBase, reviewPriceQuantity, setReviewTaxIncluded, type InvoiceReviewLine } from "@/lib/erp/invoiceReviewLine";
import { prefillInvoiceDiscounts } from "@/lib/erp/invoiceDiscount";
import { applyInvoiceSupplierMatch, chooseInvoiceIngredient, resetInvoiceSupplier } from "@/lib/erp/invoiceReviewAlias";
import { initialInvoicePrice, parseInvoiceTaxPct, type InvoiceTaxBasis } from "@/lib/erp/invoiceAmounts";
import { inferPurchaseInvoiceTaxBases } from "@/lib/erp/invoiceTaxBasis";
import { InvoiceLineTaxToggle } from "./InvoiceLineTaxToggle";
import { DiscountControl } from "./DiscountControl";
import {
  InvoiceRetentionsEditor,
  LineTaxFields,
  useInvoiceRetentions,
  useLineTaxText,
  usePurchaseTaxContext,
  useRetentionRows,
} from "./purchaseTaxUi";
import { DEFAULT_INC_PCT, lineIncCents, lineTaxEditable, receptionLineTax, type LineTaxChoice } from "@/lib/erp/purchaseLineTax";
import { sanitizeDecimalInput } from "@/lib/decimalInput";
import { parseDiscountInput, persistedOrderDiscounts, resolveOrderDiscounts } from "@/lib/erp/purchaseDiscount";
import { retentionTotalCents } from "@/lib/erp/purchaseRetentions";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, pesosToCents } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import { SupplierCombobox } from "@/components/suppliers/SupplierCombobox";
import {
  API_CREATE_ERROR_KEYS,
  Field,
  inputCls,
  splitSupplierText,
  usePurchaseCountry,
  type IngredientRef,
  type SupplierRef,
} from "./shared";
import { NewOrderForm } from "./oc/NewOrderForm";
import { waLink } from "@/lib/crm/phone";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";
import {
  type InvoiceTaxExtras,
  invoiceGrandTotalCents,
  expectedReceiptCostCents,
  normalizeTaxPct,
  poTotals,
  purchaseLineAmounts,
  purchaseOrderTotals,
  receivedPurchaseLineAmounts,
  purchaseTaxRates,
  retentionsCents,
  totalsMatch,
} from "@/lib/erp/purchaseTax";

/* ───────────────────────────── Tipos ───────────────────────────────── */

const PO_STATUSES = [
  "draft",
  "sent",
  "partially_received",
  "received",
  "canceled",
] as const;
type PoStatus = (typeof PO_STATUSES)[number];

type OrderSummary = Partial<InvoiceTaxExtras> & {
  /** Parte de las retenciones practicada al recibir (no sigue el avance). */
  receptionRetentionCents?: number;
  id: string;
  number: number;
  status: PoStatus;
  createdAt: string | Date;
  // CxP (tab "Por pagar") — el GET de lista devuelve todos los escalares.
  supplierInvoiceNumber: string | null;
  invoiceDueAt: string | Date | null;
  // Abonado acumulado (centavos). Saldo = total bruto recibido − paidCents.
  paidCents: number;
  supplier: { id: string; name: string };
  items: {
    expectedCostCents: number;
    receivedCostCents: number;
    taxPct: number;
    expectedTaxCents: number | null;
    expectedIncCents: number;
    qtyOrderedBase: number;
    receivedQtyBase: number;
  }[];
  _count: { items: number };
};

type OrderDetail = Partial<InvoiceTaxExtras> & {
  receptionRetentionCents?: number;
  id: string;
  number: number;
  status: PoStatus;
  notes: string | null;
  expectedAt: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  // CxP (D5)
  supplierInvoiceNumber: string | null;
  invoiceDueAt: string | null;
  paidAt: string | null;
  // Abonado acumulado (centavos). Saldo = total bruto recibido − paidCents.
  paidCents: number;
  supplier: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    paymentTermsDays: number | null;
  };
  createdBy: { id: string; name: string | null } | null;
  items: {
    id: string;
    qtyOrderedBase: number;
    presentations: number | null;
    expectedCostCents: number;
    /** Neto de lista antes de descuentos (#393); null = sin descuento. */
    listCostCents?: number | null;
    receivedQtyBase: number;
    receivedCostCents: number;
    taxPct: number;
    expectedTaxCents: number | null;
    expectedIncCents: number;
    ingredient: { id: string; name: string; measureKind: MeasureKind };
    supplierItem: {
      id: string;
      presentationLabel: string;
      contentQty: number;
    } | null;
  }[];
  // Recepciones del libro (movimientos purchase_in ligados a la OC).
  movements: ReceptionMovement[];
  // Abonos (CxP · F3) — historial de pagos parciales/totales, desc por fecha.
  payments: PurchasePaymentRef[];
  // Facturas subidas (A2.5) — evidencia PDF/foto que originó la OC.
  invoiceUploads: { id: string; fileUrl: string; createdAt: string }[];
};

type ReceptionMovement = {
  id: string;
  qtyBase: number;
  valueCents: number;
  createdAt: string;
  ingredient: { id: string; name: string; measureKind: MeasureKind };
  createdBy: { id: string; name: string | null } | null;
};

/**
 * Abono de una OC (CxP · F3): monto, fecha, cuenta de origen, nota y quién
 * lo registró. `accountCode`/`accountName` son null en los abonos anteriores
 * al campo: para ésos se muestra el texto libre de `method`.
 */
type PurchasePaymentRef = {
  id: string;
  amountCents: number;
  paidAt: string;
  method: string | null;
  accountCode: string | null;
  accountName: string | null;
  note: string | null;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
};

type OrderItem = OrderDetail["items"][number];

/** Cuenta de dinero (caja, banco, pasarela) de donde puede salir un abono. */
type PaymentAccountRef = { code: string; name: string };

/* ─────────────────────────── Helpers ───────────────────────────────── */

/** Búsqueda sin acentos: minúsculas + tildes fuera ("azucar" → "azúcar"). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** "g/kg", "ml/L", "un" — símbolos de unidad, iguales en es/en/pt. */
function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

/** Consecutivo legible "0007" — el prefijo (OC/PO) vive en i18n. */
function padNumber(n: number): string {
  return String(n).padStart(4, "0");
}

/** "2026-07-10" (input date) → ISO al mediodía local (sin corrimiento de día). */
function dateInputToIso(value: string): string {
  return new Date(`${value}T12:00:00`).toISOString();
}

function isoToDateInput(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Hoy como valor de un input date ("2026-07-10"). */
function todayDateInput(): string {
  return isoToDateInput(new Date().toISOString());
}

/** Centavos → texto para un input en pesos (sin separador de miles). */
function centsToPesosInput(cents: number): string {
  return String(Math.round(cents) / 100);
}

/** Texto de un input en pesos → centavos (null si vacío/inválido). */
function pesosInputToCents(value: string): number | null {
  if (value.trim() === "") return null;
  const p = Number(value.replace(",", "."));
  if (!isFinite(p) || p < 0) return null;
  return pesosToCents(p);
}

/** 150000 g → { qty: "150", unit: "kg" } — para precargar inputs de cantidad. */
function baseToInputQty(
  base: number,
  kind: MeasureKind,
): { qty: string; unit: string } {
  const units = DISPLAY_UNITS[kind];
  const big = units[units.length - 1];
  if (big.factor > 1 && base >= big.factor) {
    return { qty: String(base / big.factor), unit: big.symbol };
  }
  // units[0].factor: 1 para g/ml, 1000 para count "un" (base milesimal).
  return { qty: String(base / units[0].factor), unit: units[0].symbol };
}

/** Texto plano → HTML seguro para la vista de impresión. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "2 × Bulto 50 kg — Lomo de res" | "5 kg — Papa" (línea de OC compartida
 *  entre el texto de WhatsApp y la vista imprimible). */
function orderLineText(it: OrderItem, locale: Locale): string {
  const qty =
    it.supplierItem && it.presentations != null
      ? `${it.presentations} × ${it.supplierItem.presentationLabel}`
      : formatBaseQty(it.qtyOrderedBase, it.ingredient.measureKind, locale);
  return `${qty} — ${it.ingredient.name}`;
}

const STATUS_KEYS: Record<PoStatus, string> = {
  draft: "statusDraft",
  sent: "statusSent",
  partially_received: "statusPartial",
  received: "statusReceived",
  canceled: "statusCanceled",
};

// Colores por estado: neutro (borrador), tinta (enviada), ámbar (parcial),
// ok (recibida), danger (anulada) — mismos tokens del design system.
const STATUS_CHIP_CLS: Record<PoStatus, string> = {
  draft: "bg-paper text-op-muted",
  sent: "bg-ink text-bone",
  partially_received: "bg-[#C98A2E]/15 text-[#7F5A1F]",
  received: "bg-ok/10 text-ok",
  canceled: "bg-danger/10 text-danger",
};

function StatusChip({ status }: { status: PoStatus }) {
  const t = useTranslations("opErp");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
        STATUS_CHIP_CLS[status]
      }
    >
      {t(STATUS_KEYS[status])}
    </span>
  );
}

/**
 * Desglose Subtotal + IVA + Total de una lista de líneas netas + taxPct.
 * Si el IVA total es 0 solo muestra el Total (no ensucia con "IVA $0"),
 * salvo `alwaysBreakdown` para contextos donde el desglose siempre ayuda.
 */
function TaxBreakdown({
  lines,
  currency,
  totalLabel,
  alwaysBreakdown,
  discountCents,
  listSubtotalCents,
  incCents = 0,
  retainedCents = 0,
  retentionRows,
}: {
  lines: { costCents: number; taxPct: number; taxCents?: number | null }[];
  currency: string;
  totalLabel?: string;
  alwaysBreakdown?: boolean;
  /** Descuento ya aplicado a `lines`; se muestra como fila aparte. */
  discountCents?: number;
  /** Subtotal ANTES del descuento (precio de lista). */
  listSubtotalCents?: number;
  incCents?: number;
  retainedCents?: number;
  /** Retenciones por tipo (si suman `retainedCents`); si no, una sola fila. */
  retentionRows?: { label: string; cents: number }[];
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const { subtotalCents, taxCents, totalCents } = poTotals(lines);
  const rows = retentionRows && retentionRows.reduce((sum, r) => sum + r.cents, 0) === retainedCents
    ? retentionRows
    : [{ label: t("invLineRetentions"), cents: retainedCents }];
  const discount = discountCents ?? 0;
  const showBreakdown = alwaysBreakdown || taxCents > 0 || discount > 0 || incCents > 0 || retainedCents > 0;
  const money = (c: number) => formatMoney(c, { currency, locale });
  return (
    <div className="bg-op-bg/50">
      {showBreakdown && (
        <>
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[11px] text-op-muted">{t("subtotalLabel")}</span>
            <span className="text-[11px] text-op-muted tabular-nums">
              {money(listSubtotalCents ?? subtotalCents)}
            </span>
          </div>
          {discount > 0 && (
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[11px] text-op-muted">
                {t("discountLabel")}
              </span>
              <span className="text-[11px] text-ok tabular-nums">
                {`− ${money(discount)}`}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[11px] text-op-muted">{t("taxLabel")}</span>
            <span className="text-[11px] text-op-muted tabular-nums">
              {money(taxCents)}
            </span>
          </div>
        </>
      )}
      {incCents > 0 && <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-op-muted">
        <span>{t("invTaxInc")}</span><span>{money(incCents)}</span>
      </div>}
      {retainedCents > 0 && rows.filter((r) => r.cents > 0).map((r) => (
        <div key={r.label} className="flex items-center justify-between px-3 py-1.5 text-[11px] text-op-muted">
          <span>{r.label}</span><span>{`− ${money(r.cents)}`}</span>
        </div>
      ))}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {totalLabel ?? t("totalLabel")}
        </span>
        <span className="text-sm font-medium tabular-nums">
          {money(totalCents + incCents - retainedCents)}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────────── Lista ───────────────────────────────── */

type Filter = "all" | PoStatus;
type Tab = "orders" | "unpaid";

export function ComprasClient({
  initialOrders,
  initialCursor,
  suppliers,
  currency,
  initialDetailId = null,
}: {
  initialOrders: OrderSummary[];
  initialCursor: string | null;
  suppliers: SupplierRef[];
  currency: string;
  /** `?oc=<id>`: abre el detalle de esa orden (enlace desde los reportes). */
  initialDetailId?: string | null;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  // null = lista invalidada (cambio de filtro u orden nueva) → refetch.
  const [orders, setOrders] = useState<OrderSummary[] | null>(initialOrders);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor);
  const [tab, setTab] = useState<Tab>("orders");
  const [filter, setFilter] = useState<Filter>("all");
  const [listErr, setListErr] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(initialDetailId);
  // Carga de factura con IA (A2.5): resultado del POST → sheet de revisión.
  const [invoiceResult, setInvoiceResult] = useState<InvoiceUploadResult | null>(
    null,
  );

  useEffect(() => {
    if (orders !== null || listErr) return;
    let cancelled = false;
    (async () => {
      try {
        const qs = filter === "all" ? "" : `?status=${filter}`;
        const r = await fetch(`/api/operator/purchase-orders${qs}`);
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (cancelled) return;
        setOrders((j.orders ?? []) as OrderSummary[]);
        setNextCursor(j.nextCursor ?? null);
      } catch {
        if (!cancelled) setListErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orders, listErr, filter]);

  function invalidate() {
    setOrders(null);
    setNextCursor(null);
    setListErr(false);
  }

  function changeFilter(f: Filter) {
    if (f === filter) return;
    setFilter(f);
    invalidate();
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      params.set("cursor", nextCursor);
      const r = await fetch(`/api/operator/purchase-orders?${params}`);
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setOrders((prev) => [
        ...(prev ?? []),
        ...((j.orders ?? []) as OrderSummary[]),
      ]);
      setNextCursor(j.nextCursor ?? null);
    } catch {
      setListErr(true);
    }
    setLoadingMore(false);
  }

  return (
    <div className="space-y-4">
      {/* Segmentos Órdenes / Por pagar */}
      <div className="mp-seg" role="tablist">
        {(
          [
            ["orders", t("tabOrders")],
            ["unpaid", t("tabUnpaid")],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className="mp-seg__i"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "unpaid" ? (
        <UnpaidTab currency={currency} onOpenDetail={setDetailId} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mp-btn mp-btn--primary mp-btn--block"
            >
              {t("newOrder")}
            </button>
            <button
              type="button"
              onClick={() => setSuggestOpen(true)}
              className="mp-btn mp-btn--secondary mp-btn--block"
            >
              {t("suggestedButton")}
            </button>
            <InvoiceUploadButton onUploaded={setInvoiceResult} />
          </div>

          {/* Filtro por estado */}
          <div className="flex flex-wrap gap-2">
            {(["all", ...PO_STATUSES] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => changeFilter(f)}
                className={
                  "min-h-[36px] px-3 rounded-full border text-xs font-medium transition-colors " +
                  (filter === f
                    ? "border-ink bg-ink text-bone"
                    : "border-op-border bg-op-surface text-op-muted hover:text-ink")
                }
              >
                {f === "all" ? t("filterAllStatuses") : t(STATUS_KEYS[f])}
              </button>
            ))}
          </div>

          {listErr ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : orders === null ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : orders.length === 0 ? (
        filter === "all" ? (
          <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
            <div className="font-display text-lg mb-1">
              {t("emptyOrdersTitle")}
            </div>
            <p className="text-sm text-op-muted">{t("emptyOrdersBody")}</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
            {t("emptyFilteredOrders")}
          </div>
        )
      ) : (
        <>
          <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
            {orders.map((o) => {
              // Bruto (neto + IVA) — lo que se paga con impuestos.
              const total = purchaseOrderTotals(o).totalCents;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setDetailId(o.id)}
                  className="w-full text-left px-4 py-2.5 border-b border-op-border last:border-b-0 hover:bg-op-bg"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium shrink-0">
                          {t("poNumber", { number: padNumber(o.number) })}
                        </span>
                        <span className="text-sm text-op-muted truncate">
                          {o.supplier.name}
                        </span>
                        <StatusChip status={o.status} />
                      </div>
                      <div className="text-[11px] text-op-muted mt-0.5 truncate">
                        {[
                          formatDate(o.createdAt, { locale }),
                          t("poLineCount", { count: o._count.items }),
                        ].join(" · ")}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-medium tabular-nums">
                        {formatMoney(total, { currency, locale })}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {nextCursor && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="mp-btn mp-btn--secondary mp-btn--block"
            >
              {loadingMore ? t("loading") : t("loadMore")}
            </button>
          )}
            </>
          )}
        </>
      )}

      {/* El detalle va ANTES del sheet de creación en el DOM para que el
          sheet (hermano posterior, mismo z) pinte encima si conviven. */}
      {detailId && (
        <OrderDetailSheet
          orderId={detailId}
          currency={currency}
          onClose={() => setDetailId(null)}
          onChanged={invalidate}
        />
      )}

      {createOpen && (
        <NewOrderForm
          suppliers={suppliers}
          currency={currency}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            invalidate();
            setDetailId(id);
          }}
        />
      )}

      {suggestOpen && (
        <SuggestedSheet
          currency={currency}
          onClose={() => setSuggestOpen(false)}
          onDone={() => {
            setSuggestOpen(false);
            invalidate();
          }}
          onPartial={invalidate}
        />
      )}

      {invoiceResult && (
        <InvoiceReviewSheet
          result={invoiceResult}
          suppliers={suppliers}
          currency={currency}
          onClose={() => setInvoiceResult(null)}
          onConfirmed={(id) => {
            setInvoiceResult(null);
            invalidate();
            setDetailId(id);
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────── OC sugerida por reorden (sheet, D4) ───────────── */

/** Línea sugerida tal cual llega del GET /suggested; `presentations` se
 *  vuelve string editable en el estado local (input controlado). */
type SuggestedLine = {
  ingredientId: string;
  ingredientName: string;
  measureKind: MeasureKind;
  stockQtyBase: number;
  reorderPointBase: number;
  needBase: number;
  supplierItemId: string;
  presentationLabel: string;
  contentQty: number;
  presentations: number;
  lastPriceCents: number | null;
  expectedCostCents: number;
};

type UnassignedLine = {
  ingredientId: string;
  ingredientName: string;
  measureKind: MeasureKind;
  stockQtyBase: number;
  reorderPointBase: number;
  needBase: number;
};

type ReviewLine = Omit<SuggestedLine, "presentations" | "expectedCostCents"> & {
  presentations: string;
};

type ReviewGroup = {
  supplierId: string;
  supplierName: string;
  lines: ReviewLine[];
};

/** Costo esperado de la línea (n × último precio) o null si no hay precio
 *  registrado o el nº de presentaciones digitado no es un entero ≥ 1. */
function reviewLineCost(l: ReviewLine): number | null {
  if (l.lastPriceCents == null) return null;
  const n = Number(l.presentations);
  if (!Number.isInteger(n) || n < 1) return null;
  return n * l.lastPriceCents;
}

function SuggestedSheet({
  currency,
  onClose,
  onDone,
  onPartial,
}: {
  currency: string;
  onClose: () => void;
  /** Todos los borradores se crearon: cerrar + refrescar la lista. */
  onDone: () => void;
  /** Falló un proveedor pero otros ya se crearon: solo refrescar. */
  onPartial: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  // null = cargando; loadErr distingue inventory apagado (403) de red.
  const [groups, setGroups] = useState<ReviewGroup[] | null>(null);
  const [unassigned, setUnassigned] = useState<UnassignedLine[]>([]);
  const [loadErr, setLoadErr] = useState<"load" | "module" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/purchase-orders/suggested");
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error === "module_disabled" ? "module" : "load");
        }
        const j = await r.json();
        if (cancelled) return;
        setGroups(
          (
            (j.suppliers ?? []) as {
              supplierId: string;
              supplierName: string;
              lines: SuggestedLine[];
            }[]
          ).map((g) => ({
            supplierId: g.supplierId,
            supplierName: g.supplierName,
            lines: g.lines.map((l) => ({
              ...l,
              presentations: String(l.presentations),
            })),
          })),
        );
        setUnassigned((j.unassigned ?? []) as UnassignedLine[]);
      } catch (e) {
        if (!cancelled) {
          setLoadErr((e as Error).message === "module" ? "module" : "load");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function updatePresentations(
    supplierId: string,
    ingredientId: string,
    value: string,
  ) {
    setGroups((prev) =>
      (prev ?? []).map((g) =>
        g.supplierId === supplierId
          ? {
              ...g,
              lines: g.lines.map((l) =>
                l.ingredientId === ingredientId
                  ? { ...l, presentations: value }
                  : l,
              ),
            }
          : g,
      ),
    );
  }

  /** Quitar la línea; si el proveedor queda vacío, sale del sheet entero. */
  function removeLine(supplierId: string, ingredientId: string) {
    setGroups((prev) =>
      (prev ?? [])
        .map((g) =>
          g.supplierId === supplierId
            ? {
                ...g,
                lines: g.lines.filter((l) => l.ingredientId !== ingredientId),
              }
            : g,
        )
        .filter((g) => g.lines.length > 0),
    );
  }

  async function submit() {
    const gs = groups;
    if (!gs || gs.length === 0 || busy) return;
    setErr(null);
    // Validación completa ANTES de crear nada — o se crean todos o ninguno
    // empieza con líneas inválidas a medias.
    for (const g of gs) {
      for (const l of g.lines) {
        const n = Number(l.presentations);
        if (!Number.isInteger(n) || n < 1) {
          setErr(t("errLineInvalid"));
          return;
        }
      }
    }
    setBusy(true);
    // Un POST por proveedor, secuencial. Si uno falla, los ya creados se
    // quitan de la vista y el sheet queda abierto con los pendientes.
    const remaining = [...gs];
    while (remaining.length > 0) {
      const g = remaining[0];
      const r = await fetch("/api/operator/purchase-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          supplierId: g.supplierId,
          lines: g.lines.map((l) => {
            const n = Number(l.presentations);
            return {
              ingredientId: l.ingredientId,
              supplierItemId: l.supplierItemId,
              presentations: n,
              expectedCostCents: (l.lastPriceCents ?? 0) * n,
            };
          }),
        }),
      }).catch(() => null);
      if (!r || !r.ok) {
        const j = r ? await r.json().catch(() => ({})) : {};
        const key = API_CREATE_ERROR_KEYS[(j as { error?: string }).error ?? ""];
        setBusy(false);
        setGroups(remaining);
        setErr(
          `${t("suggestedCreateFailed", { name: g.supplierName })} ${
            key ? t(key) : t("errSaveFailed")
          }`,
        );
        if (remaining.length < gs.length) onPartial();
        return;
      }
      remaining.shift();
    }
    setBusy(false);
    onDone();
  }

  const isEmpty =
    groups !== null && groups.length === 0 && unassigned.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-2xl">{t("suggestedTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <p className="text-[11px] text-op-muted mb-4">{t("suggestedHint")}</p>

        {loadErr === "module" ? (
          <div className="text-xs text-danger">
            {t("suggestedNeedsInventory")}
          </div>
        ) : loadErr === "load" ? (
          <div className="text-xs text-danger">{t("errLoadFailed")}</div>
        ) : groups === null ? (
          <div className="py-6 text-center text-sm text-op-muted">
            {t("loading")}
          </div>
        ) : isEmpty ? (
          <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-8 text-center text-sm text-op-muted">
            {t("suggestedEmpty")}
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => {
              const subtotal = g.lines.reduce(
                (sum, l) => sum + (reviewLineCost(l) ?? 0),
                0,
              );
              return (
                <div key={g.supplierId}>
                  <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
                    {g.supplierName}
                  </div>
                  <div className="border border-op-border rounded-2xl overflow-hidden">
                    {g.lines.map((l) => {
                      const cost = reviewLineCost(l);
                      return (
                        <div
                          key={l.ingredientId}
                          className="px-3 py-2 border-b border-op-border last:border-b-0"
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">
                                {l.ingredientName}
                              </div>
                              <div className="text-[11px] text-op-muted mt-0.5 truncate">
                                {[
                                  `${formatBaseQty(
                                    l.stockQtyBase,
                                    l.measureKind,
                                    locale,
                                  )} / ${t("reorderMinRef", {
                                    qty: formatBaseQty(
                                      l.reorderPointBase,
                                      l.measureKind,
                                      locale,
                                    ),
                                  })}`,
                                  l.presentationLabel,
                                ].join(" · ")}
                              </div>
                            </div>
                            <div className="text-sm font-medium tabular-nums shrink-0">
                              {cost == null
                                ? "—"
                                : formatMoney(cost, { currency, locale })}
                            </div>
                          </div>
                          <div className="flex items-center justify-end gap-2 mt-1">
                            <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted truncate">
                              {t("fieldPresentationsCount")}
                            </span>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              inputMode="numeric"
                              value={l.presentations}
                              onChange={(e) =>
                                updatePresentations(
                                  g.supplierId,
                                  l.ingredientId,
                                  e.target.value,
                                )
                              }
                              aria-label={t("fieldPresentationsCount")}
                              className="min-h-[40px] w-20 px-2 rounded-lg border border-op-border bg-op-bg text-sm text-center shrink-0"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                removeLine(g.supplierId, l.ingredientId)
                              }
                              className="min-h-[40px] px-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 shrink-0"
                            >
                              {t("removeLine")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-between px-3 py-2 bg-op-bg/50">
                      <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                        {t("orderTotalLabel")}
                      </span>
                      <span className="text-sm font-medium tabular-nums">
                        {formatMoney(subtotal, { currency, locale })}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Bajo mínimo pero sin proveedor preferido — informativo. */}
            {unassigned.length > 0 && (
              <div>
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
                  {t("suggestedUnassignedTitle")}
                </div>
                <div className="border border-op-border rounded-2xl overflow-hidden">
                  {unassigned.map((u) => (
                    <div
                      key={u.ingredientId}
                      className="flex items-center gap-3 px-3 py-2 border-b border-op-border last:border-b-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {u.ingredientName}
                        </div>
                        <div className="text-[11px] text-op-muted mt-0.5 truncate">
                          {`${formatBaseQty(
                            u.stockQtyBase,
                            u.measureKind,
                            locale,
                          )} / ${t("reorderMinRef", {
                            qty: formatBaseQty(
                              u.reorderPointBase,
                              u.measureKind,
                              locale,
                            ),
                          })}`}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                          {t("suggestedNeedLabel")}
                        </div>
                        <div className="text-sm font-medium tabular-nums">
                          {formatBaseQty(u.needBase, u.measureKind, locale)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-op-muted mt-1">
                  {t("suggestedUnassignedHint")}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex items-center justify-end gap-3 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="mp-btn mp-btn--secondary"
          >
            {t("cancel")}
          </button>
          {groups !== null && groups.length > 0 && (
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="mp-btn mp-btn--primary"
            >
              {busy
                ? t("creating")
                : t("suggestedCreate", { count: groups.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ──────────────── Cargar factura con IA (A2.5) — tipos ─────────────── */

/** Línea cruda de la extracción de la IA. */
type ExtractionLine = {
  description: string;
  quantity: number;
  unit: string | null;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  unitPriceTaxBasis?: InvoiceTaxBasis;
  lineTotalTaxBasis?: InvoiceTaxBasis;
  unitPriceTaxBasisConflict?: boolean;
  lineTotalTaxBasisConflict?: boolean;
  unitPriceLabel?: string | null;
  lineTotalLabel?: string | null;
  lineTaxCents?: number | null;
  lineIncCents?: number | null;
  lineIncAmbiguous?: boolean;
  // Descuento impreso en la línea (ausente en lecturas viejas).
  listUnitPriceCents?: number | null;
  lineDiscountPct?: number | null;
  lineDiscountCents?: number | null;
  taxPct: string | null;
  confidence: number;
};

type SupplierMatch =
  | { kind: "matched"; supplier: { id: string; name: string; nit: string | null } }
  | { kind: "suggest_create"; name: string; nit: string | null };

type IngredientMatch =
  | {
      kind: "matched";
      ingredient: { id: string; name: string; measureKind: MeasureKind };
    }
  | { kind: "suggest_create"; name: string };

type SuggestedPresentation = {
  supplierItemId: string;
  presentationLabel: string;
  contentQty: number;
  lastPriceCents: number | null;
};

type MatchLine = {
  sourceLineIndex?: number;
  matchSource?: "alias" | "name";
  aliasUnavailable?: boolean;
  line: ExtractionLine;
  lowConfidence: boolean;
  ingredient: IngredientMatch;
  suggestedPresentation: SuggestedPresentation | null;
};

/** Respuesta del POST /api/operator/purchase-invoices. */
type InvoiceUploadResult = {
  uploadId: string;
  fileUrl: string;
  extraction: {
    documentType: "factura" | "cuenta_de_cobro" | "otro" | null;
    supplierNit: string | null;
    supplierName: string | null;
    supplierInvoiceNumber: string | null;
    issueDate: string | null;
    currency: "COP" | "MXN" | "unknown";
    lines: ExtractionLine[];
    // Totales IMPRESOS que leyó la IA (para validar concordancia); null si
    // no se ven en el documento.
    invoiceSubtotalCents: number | null;
    invoiceDiscountCents?: number | null;
    invoiceTaxCents: number | null;
    invoiceTotalCents: number | null;
    // Otros impuestos discriminados a nivel documento (ERP A3).
    invoiceIncCents: number | null;
    retefuenteCents: number | null;
    reteIvaCents: number | null;
    reteIcaCents: number | null;
    confidence: number;
    notes?: string;
  };
  match: {
    supplier: SupplierMatch;
    lines: MatchLine[];
    computedTotalCents: number;
  };
};

// Errores del POST de subida → clave i18n (fallback invUploadErrFailed).
const API_UPLOAD_ERROR_KEYS: Record<string, string> = {
  no_file: "invUploadErrNoFile",
  bad_format: "invUploadErrBadFormat",
  bad_size: "invUploadErrBadSize",
  module_disabled: "invUploadErrModuleDisabled",
  ai_response_incomplete: "invUploadErrIncomplete",
  ai_invalid_response: "invUploadErrInvalidResponse",
  ai_timeout: "invUploadErrTimeout",
  no_lines: "invUploadErrNoLines",
  not_a_document: "invUploadErrNotDocument",
};

// Errores del POST de confirmación → clave i18n (fallback errSaveFailed).
const API_CONFIRM_ERROR_KEYS: Record<string, string> = {
  alias_invalid: "invAliasInvalid",
  alias_conflict: "invAliasConflict",
  invalid: "invReviewErrInvalid",
  supplier_not_found: "invReviewErrSupplierNotFound",
  ingredient_not_found: "invReviewErrIngredientNotFound",
  no_lines: "invReviewErrNoLines",
  not_found: "invReviewErrNotFound",
  not_pending: "invReviewErrNotPending",
  module_disabled: "invUploadErrModuleDisabled",
};

/* ──────────── Cargar factura: botón + spinner de lectura IA ────────── */

function InvoiceUploadButton({
  onUploaded,
}: {
  onUploaded: (result: InvoiceUploadResult) => void;
}) {
  const t = useTranslations("opErp");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestInFlight = useRef(false);
  const inputId = "inv-upload-file";
  const errorId = "inv-upload-error";

  async function handleFile(file: File) {
    // The ref also covers a second click before React renders disabled controls.
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setSelectedFile(file);
    setErr(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const r = await fetch("/api/operator/purchase-invoices", {
        method: "POST",
        body,
      });
      const j = await r.json().catch(() => null) as (InvoiceUploadResult & { error?: unknown }) | null;
      if (!r.ok || j?.error) {
        const key = typeof j?.error === "string" ? API_UPLOAD_ERROR_KEYS[j.error] : undefined;
        setErr(key ? t(key) : t("invUploadErrFailed"));
        return;
      }
      // A failed/legacy extraction must never look like an invoice worth $0.
      if (!j || typeof j.uploadId !== "string" || typeof j.fileUrl !== "string"
        || !Array.isArray(j.extraction?.lines) || !Array.isArray(j.match?.lines)
        || !j.match.supplier) {
        setErr(t("invUploadErrInvalidResponse"));
        return;
      }
      if (j.extraction.lines.length === 0 || j.match.lines.length === 0) {
        setErr(t("invUploadErrNoLines"));
        return;
      }
      setSelectedFile(null);
      onUploaded(j);
    } catch {
      setErr(t("invUploadErrFailed"));
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {/* La carga ocupa las 2 columnas del grid (fila propia). */}
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        aria-describedby={err ? errorId : undefined}
        className="col-span-2 min-h-[44px] px-2 rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg flex items-center justify-center disabled:opacity-50 disabled:cursor-wait"
      >
        {t(err ? "invUploadChooseAnother" : "invUploadButton")}
      </button>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".pdf,image/*"
        disabled={busy}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset para permitir re-subir el mismo archivo tras un error.
          e.target.value = "";
          if (file) void handleFile(file);
        }}
      />
      {err && (
        <div className="col-span-2 rounded-2xl border border-danger/20 bg-danger/5 p-4">
          <p id={errorId} role="alert" className="text-sm leading-relaxed text-danger">{err}</p>
          {selectedFile && <>
            <p className="mt-2 break-all text-xs text-op-muted">{t("invUploadSelectedFile", { name: selectedFile.name })}</p>
            <button type="button" disabled={busy} onClick={() => void handleFile(selectedFile)}
              className="mt-3 min-h-[44px] rounded-full border border-op-border bg-op-surface px-4 text-sm font-medium hover:bg-op-bg disabled:opacity-50">
              {t("invUploadRetry")}
            </button>
          </>}
        </div>
      )}

      {busy && (
        <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center p-6">
          <div className="bg-op-surface rounded-3xl border border-op-border p-8 max-w-xs w-full text-center">
            <div className="mx-auto mb-4 h-8 w-8 rounded-full border-2 border-op-border border-t-ink animate-spin" />
            <div role="status" className="text-sm font-medium">{t("invUploadReading")}</div>
            <p className="text-[11px] text-op-muted mt-1">
              {t("invUploadReadingHint")}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/* ───────────────── Revisar factura (sheet, D4/D5) ──────────────────── */

/** Estado editable de una línea de la revisión. */
let invLineKeySeq = 0;

/** Raw major units for MoneyInput, preserving cents. */
function centsToPesosDigits(c: number | null | undefined): string {
  return c && c > 0 ? String(c / 100) : "";
}

/** Dígitos crudos de pesos (MoneyInput) → centavos. */
function pesosDigitsToCents(digits: string): number {
  const p = Number(digits);
  return digits && isFinite(p) && p > 0 ? pesosToCents(p) : 0;
}

/** Construye una línea de revisión desde un MatchLine de la IA. */
/** Infiere la medida de un insumo NUEVO desde la unidad leída (texto libre). */
function inferMeasureFromUnit(unit: string | null): MeasureKind | null {
  if (!unit) return null;
  const u = unit.toLowerCase();
  if (/(^|\W)(kg|kilo|kilos|kgr|g|gr|grs|gramo|gramos|lb|libra|libras|arroba|@)(\W|$)/.test(u))
    return "mass";
  if (/(^|\W)(l|lt|lts|litro|litros|ml|cc|gal|galon|garrafa)(\W|$)/.test(u))
    return "volume";
  if (/(^|\W)(un|und|unid|unidad|unidades|u|caja|cajas|bulto|paq|paquete|pack|docena|lata|latas|botella|botellas|bolsa|bolsas)(\W|$)/.test(u))
    return "count";
  return null;
}
/** Unidad de display por defecto (grande, para admitir cantidades decimales). */
function defaultUnitFor(kind: MeasureKind): string {
  return kind === "mass" ? "kg" : kind === "volume" ? "L" : "un";
}
/** Si la unidad leída coincide con un símbolo de display de esa medida, úsalo. */
function matchReadUnit(kind: MeasureKind, unit: string | null): string | null {
  if (!unit) return null;
  const u = unit.trim().toLowerCase();
  return DISPLAY_UNITS[kind].find((d) => d.symbol.toLowerCase() === u)?.symbol ?? null;
}

function matchLineToReviewLine(m: MatchLine, index: number): InvoiceReviewLine {
  const ing = m.ingredient;
  const q = m.line.quantity;
  // Insumo nuevo: inferir la medida de la unidad leída; si no se puede,
  // una cantidad DECIMAL casi siempre es peso/volumen (conteo es entero),
  // así que default masa; una entera, conteo.
  const measureKind: MeasureKind =
    ing.kind === "matched"
      ? ing.ingredient.measureKind
      : (inferMeasureFromUnit(m.line.unit) ??
        (Number.isInteger(q) ? "count" : "mass"));
  return {
    key: ++invLineKeySeq,
    sourceLineIndex: m.sourceLineIndex ?? index,
    sourceDescription: m.line.description,
    rememberMatch: false,
    matchSource: m.matchSource,
    aliasUnavailable: m.aliasUnavailable,
    ingredientId: ing.kind === "matched" ? ing.ingredient.id : null,
    ingredientName:
      ing.kind === "matched" ? ing.ingredient.name : ing.name,
    measureKind,
    suggestedPresentation: m.suggestedPresentation,
    qtyMode: m.suggestedPresentation ? "presentation" : "direct",
    // Presentación: si la cantidad leída es un entero, suele ser el # de
    // presentaciones (2 cajas). Si no, arranca en 1 y el operador ajusta.
    presentations:
      m.suggestedPresentation && Number.isInteger(q) && q > 0
        ? String(q)
        : "1",
    // PRELLENAR la cantidad leída (antes quedaba vacía — había que
    // re-teclearla).
    qty: q > 0 ? String(q) : "",
    unit: matchReadUnit(measureKind, m.line.unit) ?? defaultUnitFor(measureKind),
    ...initialInvoicePrice(m.line),
    taxPct: parseInvoiceTaxPct(m.line.taxPct),
    lowConfidence: m.lowConfidence,
    readUnit: m.line.unit,
    readQty: m.line.quantity,
  };
}

const INV_MODE_STORAGE_KEY = "mesapay:invReviewMode";

/** Chip emparejado/nuevo: verde "Ya existe" vs azul "Se creará" (F4). */
function MatchStatusChip({ existing }: { existing: boolean }) {
  const t = useTranslations("opErp");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
        (existing
          ? "bg-[#2E7D32]/15 text-[#2E7D32]"
          : "bg-[#2563EB]/12 text-[#2563EB]")
      }
    >
      {t(existing ? "invReviewStatusExisting" : "invReviewStatusNew")}
    </span>
  );
}

function InvoiceReviewSheet({
  result,
  suppliers,
  currency,
  onClose,
  onConfirmed,
}: {
  result: InvoiceUploadResult;
  suppliers: SupplierRef[];
  currency: string;
  onClose: () => void;
  onConfirmed: (orderId: string) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const country = usePurchaseCountry();
  const taxRates = useMemo(() => purchaseTaxRates(country), [country]);

  const { uploadId, fileUrl, extraction, match } = result;
  const isPdf = /\.pdf(\?|$)/i.test(fileUrl);

  // Proveedor: emparejado o crear nuevo (toggle entre existente/nuevo).
  const [supplier, setSupplier] = useState<SupplierRef | null>(
    match.supplier.kind === "matched"
      ? {
          id: match.supplier.supplier.id,
          name: match.supplier.supplier.name,
        }
      : null,
  );
  const [creatingSupplier, setCreatingSupplier] = useState(
    match.supplier.kind === "suggest_create",
  );
  const [newSupplierName, setNewSupplierName] = useState(
    match.supplier.kind === "suggest_create" ? match.supplier.name : "",
  );
  const [newSupplierNit, setNewSupplierNit] = useState(
    match.supplier.kind === "suggest_create"
      ? (match.supplier.nit ?? "")
      : (extraction.supplierNit ?? ""),
  );
  const [supplierMatchBusy, setSupplierMatchBusy] = useState(false);
  const [supplierMatchError, setSupplierMatchError] = useState(false);
  const supplierMatchRequest = useRef(0);

  const [invoiceNumber, setInvoiceNumber] = useState(
    extraction.supplierInvoiceNumber ?? "",
  );
  const [issueDate, setIssueDate] = useState(
    extraction.issueDate ?? "",
  );

  // Descuentos del proveedor (prellenado determinista, una sola vez).
  const [discountPrefill] = useState(() => {
    // Also interpret older pending uploads, once. Later supplier/ingredient
    // matches must never overwrite an operator's tax choice.
    const inferred = inferPurchaseInvoiceTaxBases(extraction);
    const built = match.lines.map((line, index) => matchLineToReviewLine({ ...line,
      line: inferred.lines[line.sourceLineIndex ?? index] ?? line.line,
    }, index));
    // Only what the printed numbers prove is prefilled; a net price that
    // already contains the discount is never discounted again.
    return prefillInvoiceDiscounts(inferred, built, {
      incCents: Math.max(0, (extraction.invoiceIncCents ?? 0)
        - extraction.lines.reduce((sum, l) => sum + (l.lineIncCents ?? 0), 0)),
      retentionsCents: (extraction.retefuenteCents ?? 0) + (extraction.reteIvaCents ?? 0) + (extraction.reteIcaCents ?? 0),
    });
  });
  const [lines, setLines] = useState<InvoiceReviewLine[]>(discountPrefill.lines);
  const [orderDiscRaw, setOrderDiscRaw] = useState(discountPrefill.orderDiscRaw);
  const [orderDiscIsPct, setOrderDiscIsPct] = useState(discountPrefill.orderDiscIsPct);
  const [orderDiscFromInvoice, setOrderDiscFromInvoice] = useState(discountPrefill.orderDiscountFromInvoice);

  // Insumos existentes para el picker "usar existente" (carga diferida).
  const [ingredients, setIngredients] = useState<IngredientRef[] | null>(null);
  const [ingredientsError, setIngredientsError] = useState(false);
  const [ingredientsAttempt, setIngredientsAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/ingredients");
        if (!r.ok) throw new Error("ingredients_unavailable");
        const j = await r.json();
        if (cancelled) return;
        setIngredients(
          ((j.ingredients ?? []) as IngredientRef[]).filter((i) => i.active),
        );
      } catch {
        if (!cancelled) setIngredientsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingredientsAttempt]);

  function retryIngredients() {
    setIngredientsError(false);
    setIngredientsAttempt(attempt => attempt + 1);
  }

  async function changeReviewSupplier(next: SupplierRef | null, preserveSelection = false) {
    const requestId = ++supplierMatchRequest.current;
    setSupplier(next);
    setSupplierMatchError(false);
    if (!preserveSelection) setLines(previous => previous.map(resetInvoiceSupplier));
    setSupplierMatchBusy(next != null);
    if (!next) return;
    try {
      const response = await fetch(`/api/operator/purchase-invoices/${uploadId}?supplierId=${encodeURIComponent(next.id)}`);
      if (!response.ok) throw new Error("supplier_match_unavailable");
      const data = await response.json() as { match: InvoiceUploadResult["match"] | null };
      if (!data.match) throw new Error("supplier_match_unavailable");
      if (requestId !== supplierMatchRequest.current) return;
      const matches = new Map(data.match.lines.map((line, index) => [line.sourceLineIndex ?? index, line]));
      setLines(previous => previous.map(line => {
        const match = line.sourceLineIndex == null ? undefined : matches.get(line.sourceLineIndex);
        return match ? applyInvoiceSupplierMatch(line, match) : line;
      }));
    } catch {
      if (requestId === supplierMatchRequest.current) setSupplierMatchError(true);
    } finally {
      if (requestId === supplierMatchRequest.current) setSupplierMatchBusy(false);
    }
  }

  // Modo de confirmación (D5): recordado por comercio en localStorage. El
  // sheet solo se monta en el cliente tras subir, así que leer en el lazy
  // init no arriesga hydration mismatch.
  const [mode, setMode] = useState<"draft" | "receive">(() => {
    try {
      const saved = window.localStorage.getItem(INV_MODE_STORAGE_KEY);
      return saved === "receive" ? "receive" : "draft";
    } catch {
      return "draft";
    }
  });
  const [dueDate, setDueDate] = useState("");
  function changeMode(m: "draft" | "receive") {
    setMode(m);
    try {
      window.localStorage.setItem(INV_MODE_STORAGE_KEY, m);
    } catch {
      // Sin persistencia; no es bloqueante.
    }
  }

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);

  // The supplier the invoice matched stays selectable even if it is not in
  // the active list loaded with the page.
  const supplierOptions = useMemo(
    () => (supplier && !suppliers.some((s) => s.id === supplier.id) ? [...suppliers, supplier] : suppliers),
    [suppliers, supplier],
  );

  // Preview and confirmation share one interpretation, including exact VAT
  // and both discount levels (the same proration the server re-checks).
  const resolved = useMemo(
    () => resolveReviewInvoice(lines, parseDiscountInput(orderDiscRaw, orderDiscIsPct)),
    [lines, orderDiscRaw, orderDiscIsPct],
  );
  const breakdownLines = useMemo(
    () => resolved.lines.map((l) => ({ costCents: l?.netCents ?? 0, taxCents: l?.taxCents ?? 0, taxPct: 0 })),
    [resolved],
  );
  const totals = useMemo(
    () => ({ subtotalCents: resolved.netCents, taxCents: resolved.taxCents }),
    [resolved],
  );

  // Otros impuestos del documento (ERP A3): INC (impoconsumo) + retenciones,
  // que la IA leyó y el operador verifica. En pesos enteros (MoneyInput).
  const [incPesos, setIncPesos] = useState(() =>
    centsToPesosDigits(Math.max(0, (extraction.invoiceIncCents ?? 0)
      - extraction.lines.reduce((sum, l) => sum + (l.lineIncCents ?? 0), 0))),
  );
  const [retefuentePesos, setRetefuentePesos] = useState(() =>
    centsToPesosDigits(extraction.retefuenteCents),
  );
  const [reteIvaPesos, setReteIvaPesos] = useState(() =>
    centsToPesosDigits(extraction.reteIvaCents),
  );
  const [reteIcaPesos, setReteIcaPesos] = useState(() =>
    centsToPesosDigits(extraction.reteIcaCents),
  );
  const extras = useMemo<InvoiceTaxExtras>(
    () => ({
      incCents: pesosDigitsToCents(incPesos) + lines.reduce((sum, l) => sum + pesosDigitsToCents(l.incAmount), 0),
      retefuenteCents: pesosDigitsToCents(retefuentePesos),
      reteIvaCents: pesosDigitsToCents(reteIvaPesos),
      reteIcaCents: pesosDigitsToCents(reteIcaPesos),
    }),
    [incPesos, retefuentePesos, reteIvaPesos, reteIcaPesos, lines],
  );
  const unallocatedConsumption = pesosDigitsToCents(incPesos) > 0;
  const incompleteAmounts = !resolved.complete;
  // Total a pagar = subtotal + IVA + INC − retenciones.
  const grandTotalCents = useMemo(
    () => invoiceGrandTotalCents(totals.subtotalCents, totals.taxCents, extras),
    [totals.subtotalCents, totals.taxCents, extras],
  );
  // Concordancia con el total IMPRESO de la factura (si se leyó).
  const mismatch = useMemo(
    () => !totalsMatch(grandTotalCents, extraction.invoiceTotalCents),
    [grandTotalCents, extraction.invoiceTotalCents],
  );
  // Descuentos: avisos, nunca recálculos silenciosos del IVA impreso.
  const taxBeforeDiscount = lines.some((l) => l.taxBeforeDiscount);
  const printedTaxCents = extraction.invoiceTaxCents;
  const discountTaxMismatch = resolved.discountCents > 0 && !taxBeforeDiscount
    && printedTaxCents != null && resolved.complete
    && Math.abs(resolved.taxCents - printedTaxCents) > 100 + 50 * lines.length;
  const unplacedDiscount = discountPrefill.unplacedDiscountCents != null
    && (extraction.invoiceTotalCents == null || mismatch)
    ? discountPrefill.unplacedDiscountCents : null;

  // Resumen emparejado/nuevo: cuántos insumos ya existen vs se crearán
  // (ingredientId != null ⇒ existe). Para que el operador vea qué va a crear.
  const matchCounts = useMemo(() => {
    const existing = lines.filter((l) => l.ingredientId).length;
    return { existing, toCreate: lines.length - existing };
  }, [lines]);

  // Sugerir retenciones con los conceptos activos del comercio (base
  // subtotal/IVA + umbrales UVT). Prellena los tres campos; el operador
  // puede ajustar a mano después.
  const [retSuggestBusy, setRetSuggestBusy] = useState(false);
  async function suggestRetentions() {
    setRetSuggestBusy(true);
    try {
      const r = await fetch("/api/operator/accounting/retenciones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subtotalCents: totals.subtotalCents,
          taxCents: totals.taxCents,
        }),
      });
      if (r.ok) {
        const j = (await r.json()) as {
          retefuenteCents: number;
          reteIvaCents: number;
          reteIcaCents: number;
        };
        setRetefuentePesos(centsToPesosDigits(j.retefuenteCents) ?? "");
        setReteIvaPesos(centsToPesosDigits(j.reteIvaCents) ?? "");
        setReteIcaPesos(centsToPesosDigits(j.reteIcaCents) ?? "");
      }
    } finally {
      setRetSuggestBusy(false);
    }
  }

  function updateLine(key: number, changes: Partial<InvoiceReviewLine>) {
    if (changes.incAmount !== undefined) {
      const previous = lines.find(line => line.key === key);
      const assigned = pesosDigitsToCents(changes.incAmount) - pesosDigitsToCents(previous?.incAmount ?? "");
      // Moving consumption from the document footer into a line is an
      // allocation, not an additional tax. Consume the unassigned balance.
      if (assigned > 0) setIncPesos(value => centsToPesosDigits(Math.max(0, pesosDigitsToCents(value) - assigned)));
    }
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        const base = (changes.qtyMode != null && changes.qtyMode !== l.qtyMode)
          || (changes.unit != null && changes.unit !== l.unit) ? fixReviewPriceAsTotal(l) : l;
        const changed = (k: keyof InvoiceReviewLine) => changes[k] !== undefined && changes[k] !== l[k];
        // A new discount changes the base: an automatic IVA follows it.
        const resetTax = changes.taxAmount === undefined && (
          (["cost", "taxPct", "taxBasis", "incAmount", "amountKind", "discRaw", "discIsPct"] as const).some(changed)
          || (l.amountKind === "unit" && (changes.qty !== undefined || changes.presentations !== undefined)));
        // Hints about what was read stop applying once the operator edits it.
        const edited = (["cost", "discRaw", "discIsPct"] as const).some(changed);
        return { ...base, ...changes, ...(resetTax ? { taxAmount: "" } : {}),
          ...(edited ? { discountFromInvoice: false, discountUnmatched: false } : {}),
          ...(resetTax || changed("taxAmount") ? { taxBeforeDiscount: false } : {}) };
      }),
    );
  }

  function removeLine(key: number) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function addManualLine() {
    setLines((prev) => [
      ...prev,
      {
        key: ++invLineKeySeq,
        ingredientId: null,
        ingredientName: "",
        measureKind: "count",
        suggestedPresentation: null,
        qtyMode: "direct",
        presentations: "1",
        qty: "",
        unit: BASE_UNIT_SYMBOL.count,
        cost: "",
        taxPct: 0,
        amountKind: "line",
        taxBasis: "net",
        taxBasisManual: true,
        taxAmount: "",
        incAmount: "",
        lowConfidence: false,
        readUnit: null,
        readQty: 0,
      },
    ]);
  }

  async function discard() {
    if (busyRef.current || !window.confirm(t("invReviewConfirmDiscard"))) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const response = await fetch(`/api/operator/purchase-invoices/${uploadId}`, { method: "DELETE" });
      if (!response.ok) {
        if (response.status === 409 && await recoverConfirmedOrder()) return;
        setErr(t("errSaveFailed"));
        return;
      }
      onClose();
    } catch {
      setErr(t("errSaveFailed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function closeReview() {
    if (!busyRef.current) onClose();
  }

  // A lost response may hide a committed order. Recover that order before retrying.
  async function recoverConfirmedOrder(): Promise<boolean> {
    try {
      const response = await fetch(`/api/operator/purchase-invoices/${uploadId}`, { cache: "no-store" });
      if (!response.ok) return false;
      const data = await response.json();
      if (data.upload?.status === "confirmed" && typeof data.upload.purchaseOrderId === "string" && data.upload.purchaseOrderId) {
        onConfirmed(data.upload.purchaseOrderId);
        return true;
      }
    } catch {
      // Keep the edited form available; the confirmation endpoint guards retries.
    }
    return false;
  }

  async function confirm() {
    if (busyRef.current || supplierMatchBusy || supplierMatchError) return;
    setErr(null);
    // Proveedor: existente o nombre nuevo.
    if (!supplier && (!creatingSupplier || !newSupplierName.trim())) {
      setErr(t("invReviewErrNoSupplier"));
      return;
    }
    if (lines.length === 0) {
      setErr(t("invReviewErrNoLines"));
      return;
    }
    if (unallocatedConsumption) {
      setErr(t("invLineUnallocatedConsumption"));
      return;
    }
    // Validación por línea: insumo, cantidad y costo.
    const payloadLines: {
      sourceLineIndex?: number;
      rememberMatch?: boolean;
      ingredientId: string | null;
      newIngredientName?: string;
      newIngredientMeasureKind?: MeasureKind;
      qtyBase: number;
      expectedCostCents: number;
      taxPct: number;
      expectedTaxCents: number;
      expectedIncCents: number;
      listCostCents?: number;
      discountPct?: number | null;
      discountCents?: number | null;
    }[] = [];
    // Con descuento viajan también lista + descuento (#393). El servidor
    // verifica que reproduzcan EXACTAMENTE el neto: nunca lo descuenta otra vez.
    const withDiscounts = resolved.discountCents > 0;
    for (const [index, l] of lines.entries()) {
      if (l.aliasUnavailable) {
        setErr(t("invAliasUnavailable"));
        return;
      }
      if (!l.ingredientId && !l.ingredientName.trim()) {
        setErr(t("invReviewErrNoLineIngredient"));
        return;
      }
      const qtyBase = reviewLineQtyBase(l);
      if (qtyBase == null) {
        setErr(t("invReviewErrLineQty"));
        return;
      }
      const amounts = resolved.lines[index];
      if (amounts == null || l.taxPct == null) {
        setErr(t("invLineReviewAmounts"));
        return;
      }
      const discountFields = withDiscounts
        ? { listCostCents: amounts.listCents, discountPct: amounts.discountPct, discountCents: amounts.discountCents }
        : {};
      payloadLines.push(
        l.ingredientId
          ? {
              sourceLineIndex: l.sourceLineIndex,
              rememberMatch: l.rememberMatch === true,
              ingredientId: l.ingredientId,
              qtyBase,
              expectedCostCents: amounts.netCents,
              taxPct: l.taxPct,
              expectedTaxCents: amounts.taxCents,
              expectedIncCents: amounts.incCents,
              ...discountFields,
            }
          : {
              ingredientId: null,
              newIngredientName: l.ingredientName.trim(),
              newIngredientMeasureKind: l.measureKind,
              qtyBase,
              expectedCostCents: amounts.netCents,
              taxPct: l.taxPct,
              expectedTaxCents: amounts.taxCents,
              expectedIncCents: amounts.incCents,
              ...discountFields,
            },
      );
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const r = await fetch(
        `/api/operator/purchase-invoices/${uploadId}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            supplierId: supplier ? supplier.id : null,
            newSupplierName: supplier ? undefined : newSupplierName.trim(),
            newSupplierNit: supplier ? undefined : newSupplierNit.trim() || null,
            lines: payloadLines,
            mode,
            supplierInvoiceNumber: invoiceNumber.trim() || null,
            invoiceDueAt:
              mode === "receive" && dueDate ? dateInputToIso(dueDate) : null,
            incCents: extras.incCents,
            retefuenteCents: extras.retefuenteCents,
            reteIvaCents: extras.reteIvaCents,
            reteIcaCents: extras.reteIcaCents,
            ...(withDiscounts
              ? { discountPct: resolved.orderDiscount.pct, discountCents: resolved.orderDiscount.cents }
              : {}),
          }),
        },
      );
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        if (j?.error === "not_pending" && await recoverConfirmedOrder()) return;
        const key = API_CONFIRM_ERROR_KEYS[j?.error as string];
        setErr(key ? t(key) : t("errSaveFailed"));
        return;
      }
      if (typeof j?.order?.id !== "string" || !j.order.id) throw new Error("invalid_confirmation_response");
      onConfirmed(j.order.id);
    } catch {
      if (!await recoverConfirmedOrder()) setErr(t("errSaveFailed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={closeReview}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("invReviewTitle")}
        className="w-full md:max-w-3xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <fieldset disabled={busy} className="min-w-0">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-2xl">{t("invReviewTitle")}</h2>
          <button
            type="button"
            onClick={closeReview}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <p className="text-[11px] text-op-muted mb-4">{t("invReviewHint")}</p>

        <div className="grid md:grid-cols-2 gap-4">
          {/* Evidencia: imagen o PDF original */}
          <div className="order-1 md:order-2">
            {isPdf ? (
              <div className="rounded-2xl border border-op-border overflow-hidden bg-op-bg">
                <iframe
                  src={fileUrl}
                  title={t("invReviewImageAlt")}
                  className="w-full h-64 md:h-[70dvh]"
                />
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-3 py-2 text-center text-xs font-medium text-op-muted hover:text-ink border-t border-op-border"
                >
                  {t("invReviewViewPdf")}
                </a>
              </div>
            ) : (
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-2xl border border-op-border overflow-hidden bg-op-bg"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={fileUrl}
                  alt={t("invReviewImageAlt")}
                  className="w-full max-h-[70dvh] object-contain"
                />
              </a>
            )}
          </div>

          {/* Datos editables */}
          <div className="order-2 md:order-1 space-y-3">
            {/* Resumen emparejado/nuevo (F4): qué se va a crear de un vistazo */}
            {(matchCounts.existing > 0 || matchCounts.toCreate > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {matchCounts.existing > 0 && (
                  <span className="px-2 h-6 inline-flex items-center rounded-full text-[11px] font-medium bg-[#2E7D32]/15 text-[#2E7D32]">
                    {t("invReviewSummaryExisting", { count: matchCounts.existing })}
                  </span>
                )}
                {matchCounts.toCreate > 0 && (
                  <span className="px-2 h-6 inline-flex items-center rounded-full text-[11px] font-medium bg-[#2563EB]/12 text-[#2563EB]">
                    {t("invReviewSummaryNew", { count: matchCounts.toCreate })}
                  </span>
                )}
              </div>
            )}

            {/* Encabezado: proveedor */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {t("invReviewSupplierSection")}
              </div>
              {supplier ? (
                <MatchStatusChip existing />
              ) : creatingSupplier ? (
                <MatchStatusChip existing={false} />
              ) : null}
              {extraction.documentType === "cuenta_de_cobro" && (
                <span className="px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium border border-op-border bg-op-bg text-op-muted">
                  {t("invReviewDocCuentaCobro")}
                </span>
              )}
            </div>
            {extraction.documentType === "cuenta_de_cobro" && (
              <p className="text-[11px] text-op-muted -mt-1.5">
                {t("invReviewDocCuentaCobroHint")}
              </p>
            )}

            {creatingSupplier ? (
              <>
                <Field label={t("invReviewNewSupplierName")} required>
                  <input
                    type="text"
                    value={newSupplierName}
                    onChange={(e) => setNewSupplierName(e.target.value)}
                    maxLength={120}
                    className={inputCls}
                  />
                </Field>
                <Field label={t("invReviewNewSupplierNit")}>
                  <input
                    type="text"
                    value={newSupplierNit}
                    onChange={(e) => setNewSupplierNit(e.target.value)}
                    maxLength={40}
                    className={inputCls}
                  />
                </Field>
                {suppliers.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCreatingSupplier(false)}
                    className="text-[11px] font-medium text-op-muted hover:text-ink"
                  >
                    {t("invReviewUseExistingSupplier")}
                  </button>
                )}
              </>
            ) : (
              // Proveedor con autocompletado (nombre o NIT). Viene elegido si
              // la IA lo reconoció; «Crear proveedor» abre el alta de arriba
              // con lo escrito o, si no se escribió nada, con lo que leyó la IA.
              <SupplierCombobox
                id="inv-supplier"
                suppliers={supplierOptions}
                value={supplier?.id ?? null}
                onChange={(id, s) => {
                  if ((id ?? null) === (supplier?.id ?? null)) return;
                  void changeReviewSupplier(s ? { id: s.id, name: s.name, taxId: s.taxId } : null);
                }}
                onCreateRequested={(text) => {
                  const typed = splitSupplierText(text);
                  if (supplier) void changeReviewSupplier(null);
                  setNewSupplierName(typed.name || newSupplierName || extraction.supplierName || "");
                  setNewSupplierNit(typed.taxId || newSupplierNit || extraction.supplierNit || "");
                  setCreatingSupplier(true);
                }}
                aria-label={t("invReviewSupplierSection")}
              />
            )}

            {supplierMatchBusy && <p role="status" className="text-xs text-op-muted">{t("invAliasLoading")}</p>}
            {supplierMatchError && (
              <div role="alert" className="text-xs text-danger">
                {t("invAliasLoadError")}
                <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm mt-2" onClick={() => { void changeReviewSupplier(supplier, true); }}>
                  {t("invAliasRetry")}
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Field label={t("invReviewFieldInvoiceNumber")}>
                <input
                  type="text"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  maxLength={80}
                  className={inputCls}
                />
              </Field>
              <Field label={t("invReviewFieldIssueDate")}>
                <input
                  type="date"
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>

            {/* Líneas */}
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted pt-1">
              {t("invReviewLinesSection")}
            </div>

            {lines.map((l) => (
              <InvoiceReviewLineCard
                key={l.key}
                line={l}
                currency={currency}
                taxRates={taxRates}
                ingredients={ingredients}
                ingredientsError={ingredientsError}
                onRetryIngredients={retryIngredients}
                onChange={(changes) => updateLine(l.key, changes)}
                onRemove={() => removeLine(l.key)}
              />
            ))}

            <button
              type="button"
              onClick={addManualLine}
              className="mp-btn mp-btn--secondary mp-btn--block"
            >
              {t("invReviewAddLine")}
            </button>

            {incompleteAmounts && <p role="status" className="text-xs text-terracotta">{t("invLineReviewAmounts")}</p>}

            {/* Desglose recomputado en vivo, como el pie de la factura:
                Subtotal / Descuento / IVA / INC / Retenciones / Total. El
                descuento del total se prorratea entre las líneas igual que
                en el servidor, así el IVA mostrado es el que se guarda. */}
            <div className="rounded-xl bg-op-bg/50 border border-op-border overflow-hidden">
              <DiscountControl
                id="inv-order-discount"
                label={t("orderDiscountLabel")}
                raw={orderDiscRaw}
                isPct={orderDiscIsPct}
                currency={currency}
                onChange={(raw, isPct) => {
                  setOrderDiscRaw(raw);
                  setOrderDiscIsPct(isPct);
                  setOrderDiscFromInvoice(false);
                }}
                hint={orderDiscFromInvoice ? t("invDiscOrderFromInvoice") : undefined}
                className="px-3 py-2 border-b border-op-border"
              />
              <TaxBreakdown
                lines={breakdownLines}
                currency={currency}
                totalLabel={t("invReviewTotalNote")}
                incCents={extras.incCents}
                retainedCents={retentionsCents(extras)}
                discountCents={resolved.discountCents}
                listSubtotalCents={resolved.subtotalCents}
              />
            </div>

            {unplacedDiscount != null && (
              <div role="status" className="rounded-xl border border-[#C98A2E]/30 bg-[#C98A2E]/10 p-3 text-[11px] text-[#7F5A1F]">
                {t("invDiscUnplaced", { amount: formatMoney(unplacedDiscount, { currency, locale }) })}
              </div>
            )}
            {taxBeforeDiscount && (
              <div role="status" className="rounded-xl border border-[#C98A2E]/30 bg-[#C98A2E]/10 p-3 text-[11px] text-[#7F5A1F]">
                {t("invDiscTaxBeforeDiscount")}
              </div>
            )}
            {discountTaxMismatch && printedTaxCents != null && (
              <div role="status" className="rounded-xl border border-[#C98A2E]/30 bg-[#C98A2E]/10 p-3 text-[11px] text-[#7F5A1F]">
                {t("invDiscTaxMismatch", {
                  computed: formatMoney(resolved.taxCents, { currency, locale }),
                  printed: formatMoney(printedTaxCents, { currency, locale }),
                })}
              </div>
            )}

            {/* Otros impuestos del documento (ERP A3): INC + retenciones. La IA
                los prellena; el operador los verifica/corrige. INC suma,
                retenciones restan al total a pagar. */}
            <div className="rounded-xl border border-op-border bg-op-bg/50 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                  {t("invTaxOtherSection")}
                </div>
                {/* Sugerencia con los conceptos ACTIVOS del comercio (umbral
                    UVT incluido) — Contabilidad → Impuestos → Retenciones. */}
                <button
                  type="button"
                  onClick={suggestRetentions}
                  disabled={retSuggestBusy || totals.subtotalCents <= 0}
                  className="text-[11px] text-terracotta hover:underline disabled:opacity-40 shrink-0"
                >
                  {retSuggestBusy
                    ? t("invTaxSuggesting")
                    : t("invTaxSuggestRetentions")}
                </button>
              </div>
              {(
                [
                  ["inc", t("invLineUnassignedInc"), incPesos, setIncPesos],
                  [
                    "retefuente",
                    t("invTaxRetefuente"),
                    retefuentePesos,
                    setRetefuentePesos,
                  ],
                  ["reteiva", t("invTaxReteIva"), reteIvaPesos, setReteIvaPesos],
                  ["reteica", t("invTaxReteIca"), reteIcaPesos, setReteIcaPesos],
                ] as [string, string, string, (v: string) => void][]
              ).map(([key, label, value, setter]) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2"
                >
                  <label
                    htmlFor={`invtax-${key}`}
                    className="text-xs text-op-muted"
                  >
                    {label}
                  </label>
                  <MoneyInput
                    id={`invtax-${key}`}
                    value={value}
                    fractionDigits={2}
                    onChange={setter}
                    ariaLabel={label}
                    placeholder="0"
                    className="w-32 min-h-[36px] px-2 rounded-lg border border-op-border bg-op-surface text-sm text-right"
                  />
                </div>
              ))}
              <p className="text-[11px] text-op-muted">{t("invLineIncFooterHint")}</p>
              {unallocatedConsumption && <p role="alert" className="text-xs text-danger">{t("invLineUnallocatedConsumption")}</p>}
              {retentionsCents(extras) > 0 && (
                <p className="text-[10px] text-op-muted">
                  {t("invTaxRetentionNote")}
                </p>
              )}
              <div className="flex items-center justify-between border-t border-op-border pt-2 text-sm font-medium">
                <span>{t("invTaxGrandTotal")}</span>
                <span>{formatMoney(grandTotalCents, { currency, locale })}</span>
              </div>
            </div>

            {/* Concordancia con el total impreso de la factura (no bloquea). */}
            {mismatch && extraction.invoiceTotalCents != null && (
              <div className="rounded-xl border border-[#C98A2E]/30 bg-[#C98A2E]/10 p-3 text-[11px] text-[#7F5A1F]">
                {t("invTotalMismatch", {
                  computed: formatMoney(grandTotalCents, {
                    currency,
                    locale,
                  }),
                  printed: formatMoney(extraction.invoiceTotalCents, {
                    currency,
                    locale,
                  }),
                })}
              </div>
            )}

            {extraction.notes?.trim() && (
              <div className="rounded-xl border border-[#C98A2E]/30 bg-[#C98A2E]/10 p-3">
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-[#7F5A1F] mb-0.5">
                  {t("invReviewNotesLabel")}
                </div>
                <div className="text-[11px] text-[#7F5A1F]">
                  {extraction.notes}
                </div>
              </div>
            )}

            {/* Switch borrador / recibir (D5) */}
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted pt-1">
              {t("invReviewModeSection")}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["draft", t("invReviewModeDraft")],
                  ["receive", t("invReviewModeReceive")],
                ] as ["draft" | "receive", string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => changeMode(value)}
                  className={
                    "min-h-[44px] px-2 rounded-xl border text-sm font-medium transition-colors " +
                    (mode === value
                      ? "border-ink bg-ink text-bone"
                      : "border-op-border bg-op-bg hover:bg-op-surface")
                  }
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "receive" && (
              <Field label={t("invReviewDueDateLabel")}>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={inputCls}
                />
              </Field>
            )}
          </div>
        </div>

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex items-center justify-between gap-3 mt-4">
          <button
            type="button"
            onClick={discard}
            disabled={busy}
            className="min-h-[44px] px-4 rounded-full text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
          >
            {t("invReviewDiscard")}
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={closeReview}
              className="mp-btn mp-btn--secondary"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={busy || supplierMatchBusy || supplierMatchError}
              className="mp-btn mp-btn--primary"
            >
              {busy ? t("invReviewConfirming") : t("invReviewConfirm")}
            </button>
          </div>
        </div>
        </fieldset>
      </div>
    </div>
  );
}

/** Tarjeta editable de una línea de la factura en revisión. */
function InvoiceReviewLineCard({
  line: l,
  currency,
  taxRates,
  ingredients,
  ingredientsError,
  onRetryIngredients,
  onChange,
  onRemove,
}: {
  line: InvoiceReviewLine;
  currency: string;
  taxRates: number[];
  ingredients: IngredientRef[] | null;
  ingredientsError: boolean;
  onRetryIngredients: () => void;
  onChange: (changes: Partial<InvoiceReviewLine>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [ingQ, setIngQ] = useState("");
  const [picking, setPicking] = useState(false);

  const ingMatches = useMemo(() => {
    const needle = fold(ingQ.trim());
    return (ingredients ?? [])
      .filter((i) => !needle || fold(i.name).includes(needle))
      .slice(0, 8);
  }, [ingredients, ingQ]);

  const qtyBase = reviewLineQtyBase(l);
  const amounts = reviewLineAmounts(l);
  const discountDetail = reviewLineDiscountDetail(l, amounts);
  const priceQuantity = reviewPriceQuantity(l);
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const readQtyStr = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 3,
  }).format(l.readQty);

  return (
    <div className="rounded-2xl border border-op-border bg-op-bg/50 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* Insumo: existente o crear nuevo */}
          {l.ingredientId ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                {l.ingredientName}
              </span>
              <span className="font-mono text-[10px] text-op-muted">
                {unitSymbols(l.measureKind)}
              </span>
            </div>
          ) : (
            <div className="text-[11px] font-medium text-op-muted">
              {l.ingredientName
                ? t("invReviewCreateIngredient", { name: l.ingredientName })
                : t("invReviewNewIngredientName")}
            </div>
          )}
        </div>
        <MatchStatusChip existing={l.ingredientId != null} />
        {l.lowConfidence && (
          <span className="px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 bg-[#C98A2E]/15 text-[#7F5A1F]">
            {t("invReviewLowConfidence")}
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="min-h-[36px] px-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 shrink-0"
        >
          {t("invReviewRemoveLine")}
        </button>
      </div>

      {l.sourceDescription && (
        <p className="text-xs text-op-muted break-words">{t("invAliasSource", { name: l.sourceDescription })}</p>
      )}
      {l.matchSource === "alias" && (
        <p className="text-xs text-[#2E7D32]" role="status">{t("invAliasSaved")}</p>
      )}
      {l.aliasUnavailable && (
        <p className="text-xs text-danger" role="alert">{t("invAliasUnavailable")}</p>
      )}

      {/* Selector de insumo existente / nombre + measureKind del nuevo */}
      {picking ? (
        <div>
          <input
            type="search"
            value={ingQ}
            onChange={(e) => setIngQ(e.target.value)}
            placeholder={t("ingredientSearchPlaceholder")}
            aria-label={t("ingredientSearchPlaceholder")}
            disabled={ingredients === null}
            className={inputCls}
          />
          <div className="mt-1 rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-40 overflow-y-auto">
            {ingredientsError ? (
              <div role="alert" className="px-3 py-2 text-xs text-danger">
                {t("invAliasIngredientsError")}
                <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm mt-2" onClick={onRetryIngredients}>{t("invAliasRetry")}</button>
              </div>
            ) : ingredients === null ? (
              <p role="status" className="px-3 py-2 text-xs text-op-muted">{t("loading")}</p>
            ) : ingMatches.length === 0 ? (
              <div className="px-3 py-2 text-xs text-op-muted">
                {t("noIngredientMatches")}
              </div>
            ) : (
              ingMatches.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => {
                    onChange(chooseInvoiceIngredient(l, i));
                    setPicking(false);
                    setIngQ("");
                  }}
                  className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0"
                >
                  <span>{i.name}</span>
                  <span className="font-mono text-[10px] text-op-muted ml-2">
                    {unitSymbols(i.measureKind)}
                  </span>
                </button>
              ))
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              setIngQ("");
            }}
            className="text-[11px] font-medium text-op-muted hover:text-ink mt-1"
          >
            {t("cancel")}
          </button>
        </div>
      ) : l.ingredientId ? (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="text-[11px] font-medium text-op-muted hover:text-ink"
          >
            {t("invReviewChangeIngredient")}
          </button>
          <button
            type="button"
            onClick={() => onChange(chooseInvoiceIngredient(l, { id: null, name: "", measureKind: l.measureKind }))}
            className="text-[11px] font-medium text-op-muted hover:text-ink"
          >
            {t("invReviewCreateNewIngredient")}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="mp-btn mp-btn--secondary mp-btn--block"
          >
            {t("invReviewUseExistingIngredient")}
          </button>
          <Field label={t("invReviewNewIngredientName")} required>
            <input
              type="text"
              value={l.ingredientName}
              onChange={(e) => onChange({ ingredientName: e.target.value, manuallySelected: true, aliasUnavailable: false })}
              maxLength={120}
              className={inputCls}
            />
          </Field>
          <Field label={t("invReviewMeasureKind")}>
            <select
              value={l.measureKind}
              onChange={(e) => {
                const kind = e.target.value as MeasureKind;
                onChange(chooseInvoiceIngredient(l, { id: null, name: l.ingredientName, measureKind: kind }));
              }}
              className={inputCls}
            >
              <option value="mass">{t("invReviewMeasureMass")}</option>
              <option value="volume">{t("invReviewMeasureVolume")}</option>
              <option value="count">{t("invReviewMeasureCount")}</option>
            </select>
          </Field>
        </>
      )}

      {l.ingredientId && l.sourceLineIndex != null && l.matchSource !== "alias" && (
        <label className="flex items-start gap-2 rounded-xl border border-op-border bg-op-surface p-3 text-xs leading-relaxed">
          <input type="checkbox" aria-label={t("invAliasRemember")} className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={l.rememberMatch === true}
            onChange={e => onChange({ rememberMatch: e.target.checked, ...(e.target.checked ? { manuallySelected: true } : {}) })} />
          <span>{t("invAliasRemember")}<span className="block text-op-muted mt-1">{t("invAliasRememberHint")}</span></span>
        </label>
      )}

      {/* Cantidad: por presentación (si hay sugerencia) o directa */}
      {l.suggestedPresentation && (
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["presentation", t("invReviewQtyModePresentation")],
              ["direct", t("invReviewQtyModeDirect")],
            ] as ["presentation" | "direct", string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ qtyMode: value })}
              className={
                "min-h-[40px] px-2 rounded-xl border text-xs font-medium transition-colors " +
                (l.qtyMode === value
                  ? "border-ink bg-ink text-bone"
                  : "border-op-border bg-op-bg hover:bg-op-surface")
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {l.qtyMode === "presentation" && l.suggestedPresentation ? (
        <Field
          label={t("invReviewPresentationLabel", {
            label: l.suggestedPresentation.presentationLabel,
            qty: formatBaseQty(
              l.suggestedPresentation.contentQty,
              l.measureKind,
              locale,
            ),
          })}
          required
        >
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={l.presentations}
            onChange={(e) => onChange({ presentations: e.target.value })}
            className={inputCls}
          />
        </Field>
      ) : (
        <Field label={t("fieldQty")} required>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={l.qty}
              onChange={(e) => onChange({ qty: sanitizeDecimalInput(e.target.value) })}
              className={inputCls + " flex-1 min-w-0"}
            />
            <select
              value={l.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              disabled={DISPLAY_UNITS[l.measureKind].length < 2}
              className="min-h-[44px] w-16 px-2 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
            >
              {DISPLAY_UNITS[l.measureKind].map((u) => (
                <option key={u.symbol} value={u.symbol}>
                  {u.symbol}
                </option>
              ))}
            </select>
          </div>
        </Field>
      )}

      <div className="grid grid-cols-1 gap-2">
        <Field label={t("invLineAmountKind")}>
          <select className={inputCls} value={l.amountKind} aria-label={t("invLineAmountKind")}
            onChange={e => onChange({ amountKind: e.target.value as InvoiceReviewLine["amountKind"] })}>
            <option value="line">{t("invLineAmount")}</option>
            <option value="unit">{t("invUnitAmount")}</option>
          </select>
        </Field>
      </div>
      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Field label={`${t(l.amountKind === "line" ? "invLineAmount" : "invUnitAmount")} (${currency})`} required>
            <MoneyInput
              value={l.cost}
              fractionDigits={2}
              onChange={(d) => onChange({ cost: d })}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="shrink-0">
          <Field label={t("fieldTaxPct")}>
            <select className={`${inputCls} w-24`} value={l.taxPct ?? ""} aria-label={t("fieldTaxPct")}
              onChange={e => onChange({ taxPct: e.target.value === "" ? null : normalizeTaxPct(e.target.value) })}>
              <option value="">{t("invLineChooseRate")}</option>
              {[...new Set([...taxRates, ...(l.taxPct == null ? [] : [l.taxPct])])].sort((a, b) => a - b).map(pct =>
                <option key={pct} value={pct}>{t("taxPctOption", { pct })}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <p className="text-[11px] text-op-muted">{t(l.amountKind === "line" ? "invLineTotalHint" : "invLineUnitHint")}</p>
      {/* Descuento de la línea: mismo control que en la orden de compra. Se
          aplica sobre el importe de arriba; el IVA automático va sobre la
          base ya descontada. */}
      <div className="rounded-xl border border-op-border bg-op-surface px-3 py-2">
        <DiscountControl
          id={`inv-line-discount-${l.key}`}
          label={t("invDiscLineLabel")}
          raw={l.discRaw ?? ""}
          isPct={l.discIsPct ?? true}
          currency={currency}
          onChange={(discRaw, discIsPct) => onChange({ discRaw, discIsPct })}
        />
        <p className="mt-1 text-[10px] text-op-muted">
          {t(l.taxBasis === "gross" ? "invDiscLineHintGross" : "invDiscLineHint")}
        </p>
        {l.discountFromInvoice && (
          <p className="mt-1 text-[11px] text-[#2E7D32]" role="status">{t("invDiscLineFromInvoice")}</p>
        )}
        {l.discountUnmatched && (
          <p className="mt-1 text-[11px] text-terracotta" role="status">{t("invDiscLineUnmatched")}</p>
        )}
      </div>
      <InvoiceLineTaxToggle basis={l.taxBasis} manual={l.taxBasisManual}
        onChange={included => onChange(setReviewTaxIncluded(l, included))} />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("invLineIncAmount")}>
          <MoneyInput value={l.incAmount} fractionDigits={2} placeholder="0"
            onChange={incAmount => onChange({ incAmount })} className={inputCls} />
        </Field>
        <Field label={t("invLineVatAmount")}>
          <MoneyInput value={l.taxAmount} fractionDigits={2} placeholder={t("invLineAutomatic")}
            onChange={taxAmount => onChange({ taxAmount })} className={inputCls} />
        </Field>
      </div>
      {(l.taxBasis === "unknown" || l.taxPct == null || (l.incNeedsReview && !l.incAmount.trim())) &&
        <p className="text-[11px] text-terracotta">{t("invLineUnknownHint")}</p>}
      {l.taxBeforeDiscount && <p className="text-[11px] text-[#7F5A1F]" role="status">{t("invDiscLineTaxBeforeDiscount")}</p>}
      {amounts && <div className="border-t border-op-border pt-2 space-y-1 text-[11px] tabular-nums" data-testid="invoice-line-amounts">
        {discountDetail && discountDetail.shownDiscountCents > 0 && <>
          <div className="flex justify-between gap-2 text-op-muted"><span>{t("invDiscLineList")}</span><span>{money(discountDetail.shownListCents)}</span></div>
          <div className="flex justify-between gap-2 text-op-muted"><span>{t("discountLabel")}</span><span className="text-ok">{`− ${money(discountDetail.shownDiscountCents)}`}</span></div>
        </>}
        <div className="flex justify-between gap-2 text-op-muted"><span>{t("invLineNetAmount")}</span><span>{money(amounts.netCents)}</span></div>
        <div className="flex justify-between gap-2 text-op-muted"><span>{t("taxLabel")}</span><span>{money(amounts.taxCents)}</span></div>
        {amounts.incCents > 0 && <div className="flex justify-between gap-2 text-op-muted"><span>{t("invTaxInc")}</span><span>{money(amounts.incCents)}</span></div>}
        <div className="flex justify-between gap-2 text-sm font-medium"><span>{t("invLineFinalAmount")}</span><span>{money(amounts.totalCents)}</span></div>
        {priceQuantity > 0 && <p className="text-op-muted">{t("invLineUnitFinal", { amount: money(Math.round(amounts.totalCents / priceQuantity)), unit: l.qtyMode === "presentation" && l.suggestedPresentation ? l.suggestedPresentation.presentationLabel : l.unit })}</p>}
      </div>}
      {l.amountLabel && <p className="text-[10px] text-op-muted">{t("invLineSourceLabel", { label: l.amountLabel })}</p>}

      {/* Pista de lo leído + cantidad base resultante */}
      <div className="text-[10px] text-op-muted">
        {[
          l.readQty > 0
            ? l.readUnit
              ? t("invReviewReadUnitHint", {
                  qty: readQtyStr,
                  unit: l.readUnit,
                })
              : t("invReviewReadUnitHintNoUnit", { qty: readQtyStr })
            : null,
          qtyBase != null
            ? formatBaseQty(qtyBase, l.measureKind, locale)
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
}

/* ─────────────────────── Detalle de la orden (sheet) ───────────────── */

function OrderDetailSheet({
  orderId,
  currency,
  onClose,
  onChanged,
}: {
  orderId: string;
  currency: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // Edición de borrador (notas + entrega esperada) — spec: solo en draft.
  const [editing, setEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [expectedDraft, setExpectedDraft] = useState("");
  // Recepción (D3): sheet encima del detalle; reloadKey fuerza el refetch
  // tras recibir (los movements cambiaron en el server).
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // CxP (F3): formulario de abono desplegable dentro del detalle.
  const [payOpen, setPayOpen] = useState(false);
  const lineTaxText = useLineTaxText();
  const retentionRows = useRetentionRows();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/purchase-orders/${orderId}`);
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (!cancelled) setOrder(j.order as OrderDetail);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, reloadKey]);

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setErr(null);
    setOkMsg(null);
    setBusy(true);
    const r = await fetch(`/api/operator/purchase-orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "wrong_status" ? t("errWrongStatus") : t("errSaveFailed"),
      );
      return false;
    }
    const j = await r.json();
    // El PATCH devuelve la orden SIN includes — merge sobre el detalle
    // cargado para conservar supplier/items/movements.
    setOrder((prev) =>
      prev ? { ...prev, ...(j.order as Partial<OrderDetail>) } : prev,
    );
    onChanged();
    return true;
  }

  function markSent() {
    void patch({ action: "mark_sent" });
  }

  function cancelOrder() {
    if (!window.confirm(t("confirmCancelOrder"))) return;
    void patch({ action: "cancel" });
  }

  function startEdit() {
    if (!order) return;
    setNotesDraft(order.notes ?? "");
    setExpectedDraft(isoToDateInput(order.expectedAt));
    setEditing(true);
  }

  async function saveEdit() {
    const ok = await patch({
      action: "edit",
      notes: notesDraft.trim() || null,
      expectedAt: expectedDraft ? dateInputToIso(expectedDraft) : null,
    });
    if (ok) setEditing(false);
  }

  // Reversar un abono (CxP · F3). Refresca el detalle para traer los saldos
  // frescos y el historial actualizado; avisa a la lista de "por pagar".
  async function deletePayment(paymentId: string) {
    if (!window.confirm(t("confirmDeletePayment"))) return;
    setErr(null);
    setOkMsg(null);
    setBusy(true);
    const r = await fetch(
      `/api/operator/purchase-orders/${orderId}/payments/${paymentId}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!r.ok) {
      setErr(t("errSaveFailed"));
      return;
    }
    setReloadKey((k) => k + 1);
    onChanged();
  }

  // Si la OC ya se recibió (completa), el costo real recibido manda; si no,
  // el esperado. Cada línea aporta su costo NETO + su IVA.
  const useReceived = order?.status === "received";
  const detailLines = (order?.items ?? []).map((it) => ({
    costCents: useReceived ? it.receivedCostCents : it.expectedCostCents,
    taxPct: it.taxPct,
    taxCents: (useReceived ? receivedPurchaseLineAmounts(it) : purchaseLineAmounts(it)).taxCents,
  }));
  // Total bruto (neto + IVA) — para WhatsApp/impresión.
  const detailTotals = purchaseOrderTotals(order ?? { items: [] }, useReceived ? "received" : "expected");
  const total = detailTotals.totalCents;
  // Retenciones por tipo cuando suman lo mostrado (orden completa o
  // esperado); si no, una sola fila «Retenciones».
  const kindRows = retentionRows(order ?? {});
  const detailRetentionRows = kindRows.reduce((sum, r) => sum + r.cents, 0) === detailTotals.retentionsCents
    ? kindRows
    : [{ label: t("invLineRetentions"), cents: detailTotals.retentionsCents }];
  // Descuentos del proveedor (#393): "Subtotal / Descuento" como la factura.
  // Solo mientras los costos mostrados son los de la orden (si se recibió a
  // otro costo, la lista de la orden ya no explica ese neto).
  const detailDiscount = (() => {
    const items = order?.items ?? [];
    const sameCost = items.every((it) => !useReceived || it.receivedCostCents === it.expectedCostCents);
    const discount = items.reduce(
      (sum, it) => sum + Math.max(0, (it.listCostCents ?? it.expectedCostCents) - it.expectedCostCents),
      0,
    );
    return sameCost && discount > 0 ? { discountCents: discount, listSubtotalCents: detailTotals.subtotalCents + discount } : null;
  })();

  // Enviar (WhatsApp/imprimir) marca `sent` si aún es borrador — optimista
  // y fire-and-forget: el envío ya salió, el server solo lo registra (D6).
  function markSentIfDraft() {
    if (!order || order.status !== "draft") return;
    setOrder((prev) =>
      prev && prev.status === "draft"
        ? { ...prev, status: "sent", sentAt: new Date().toISOString() }
        : prev,
    );
    onChanged();
    void fetch(`/api/operator/purchase-orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mark_sent" }),
    }).catch(() => {});
  }

  /** Texto de la orden para WhatsApp (D6). */
  function buildWaText(o: OrderDetail): string {
    return [
      t("waHeader", { number: t("poNumber", { number: padNumber(o.number) }) }),
      "",
      ...o.items.map((it) => orderLineText(it, locale)),
      ...(o.notes ? ["", o.notes] : []),
      "",
      `${t("orderTotalLabel")}: ${formatMoney(total, { currency, locale })}`,
    ].join("\n");
  }

  /** Vista imprimible: ventana nueva con HTML mínimo + window.print()
   *  (el detalle es un sheet sobre la lista — imprimir la página entera
   *  arrastraría el fondo; mismo espíritu que los PrintButton existentes). */
  function printOrder() {
    if (!order) return;
    const title = t("poNumber", { number: padNumber(order.number) });
    const rows = order.items
      .map(
        (it) =>
          `<tr><td>${escapeHtml(orderLineText(it, locale))}</td>` +
          `<td class="num">${escapeHtml(
            formatMoney((useReceived ? receivedPurchaseLineAmounts(it) : purchaseLineAmounts(it)).totalCents, { currency, locale }),
          )}</td></tr>`,
      )
      .join("");
    // Pie: si hay IVA, desglose Subtotal + IVA + Total; si no, solo Total.
    const printTotals = detailTotals;
    const totalRow = (label: string, cents: number) =>
      `<tr><td>${escapeHtml(label)}</td>` +
      `<td class="num">${escapeHtml(
        formatMoney(cents, { currency, locale }),
      )}</td></tr>`;
    const printTotalsRows = totalRow(t("subtotalLabel"), detailDiscount?.listSubtotalCents ?? printTotals.subtotalCents)
      + (detailDiscount ? totalRow(t("discountLabel"), -detailDiscount.discountCents) : "")
      + (printTotals.taxCents > 0 ? totalRow(t("taxLabel"), printTotals.taxCents) : "")
      + (printTotals.incCents > 0 ? totalRow(t("invTaxInc"), printTotals.incCents) : "")
      + (printTotals.retentionsCents > 0
        ? detailRetentionRows.map((r) => totalRow(r.label, -r.cents)).join("")
        : "")
      + totalRow(t("orderTotalLabel"), printTotals.totalCents);
    const meta = [
      `${t("fieldSupplier")}: ${order.supplier.name}`,
      order.supplier.phone,
      formatDate(order.createdAt, { locale }),
      order.expectedAt
        ? `${t("fieldExpectedAt")}: ${formatDate(order.expectedAt, {
            locale,
            timeStyle: undefined,
          })}`
        : null,
    ]
      .filter(Boolean)
      .map((line) => `<div>${escapeHtml(line as string)}</div>`)
      .join("");
    const html =
      `<!doctype html><html><head><meta charset="utf-8"/>` +
      `<title>${escapeHtml(title)}</title><style>` +
      `body{font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px;` +
      `color:#111;margin:24px;}h1{font-size:18px;margin:0 0 4px;}` +
      `.meta{color:#555;margin-bottom:16px;line-height:1.5;}` +
      `table{width:100%;border-collapse:collapse;}` +
      `td,th{padding:6px 4px;border-bottom:1px solid #ddd;text-align:left;}` +
      `.num{text-align:right;white-space:nowrap;}` +
      `tfoot td{font-weight:600;border-bottom:none;}` +
      `.notes{margin-top:12px;color:#555;white-space:pre-wrap;}` +
      `</style></head><body>` +
      `<h1>${escapeHtml(title)}</h1><div class="meta">${meta}</div>` +
      `<table><tbody>${rows}</tbody><tfoot>` +
      printTotalsRows +
      `</tfoot></table>` +
      (order.notes
        ? `<div class="notes">${escapeHtml(order.notes)}</div>`
        : "") +
      `</body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    markSentIfDraft();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {loadErr ? (
          <div className="text-xs text-danger">{t("errLoadFailed")}</div>
        ) : order === null ? (
          <div className="py-6 text-center text-sm text-op-muted">
            {t("loading")}
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="font-display text-2xl shrink-0">
                  {t("poNumber", { number: padNumber(order.number) })}
                </h2>
                <StatusChip status={order.status} />
              </div>
              <div className="flex items-center shrink-0 -mt-1 -mr-2">
                {order.status === "draft" && !editing && (
                  <button
                    type="button"
                    onClick={startEdit}
                    className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-op-muted hover:text-ink"
                  >
                    {t("edit")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="text-op-muted text-sm min-h-[44px] min-w-[44px]"
                  aria-label={t("cancel")}
                >
                  {"✕"}
                </button>
              </div>
            </div>

            <div className="text-sm font-medium mb-0.5 truncate">
              {order.supplier.name}
            </div>
            <div className="text-[11px] text-op-muted">
              {[
                order.supplier.phone,
                order.supplier.paymentTermsDays == null
                  ? t("termsCash")
                  : t("termsDays", { count: order.supplier.paymentTermsDays }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div className="text-[11px] text-op-muted mt-0.5">
              {[
                formatDate(order.createdAt, { locale }),
                order.createdBy?.name ?? null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {/* Hitos del ciclo (solo los que aplican) */}
            <div className="text-[11px] text-op-muted mt-0.5">
              {[
                order.expectedAt
                  ? `${t("fieldExpectedAt")}: ${formatDate(order.expectedAt, {
                      locale,
                      timeStyle: undefined,
                    })}`
                  : null,
                order.sentAt
                  ? `${t("statusSent")}: ${formatDate(order.sentAt, { locale })}`
                  : null,
                order.receivedAt
                  ? `${t("statusReceived")}: ${formatDate(order.receivedAt, {
                      locale,
                    })}`
                  : null,
                order.canceledAt
                  ? `${t("statusCanceled")}: ${formatDate(order.canceledAt, {
                      locale,
                    })}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {order.notes && !editing && (
              <div className="text-[11px] text-op-muted mt-1">
                {order.notes}
              </div>
            )}

            {editing && (
              <div className="mt-3 rounded-2xl border border-op-border bg-op-bg/50 p-4 space-y-3">
                <Field label={t("fieldExpectedAt")}>
                  <input
                    type="date"
                    value={expectedDraft}
                    onChange={(e) => setExpectedDraft(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label={t("fieldNotes")}>
                  <textarea
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    maxLength={1000}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
                  />
                </Field>
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="mp-btn mp-btn--secondary"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={busy}
                    className="mp-btn mp-btn--primary"
                  >
                    {busy ? t("saving") : t("save")}
                  </button>
                </div>
              </div>
            )}

            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mt-4 mb-2">
              {t("linesTitle")}
            </div>
            <div className="border border-op-border rounded-2xl overflow-hidden">
              {order.items.map((it) => {
                const kind = it.ingredient.measureKind;
                const composition =
                  it.supplierItem && it.presentations != null
                    ? [
                        `${it.presentations} × ${it.supplierItem.presentationLabel}`,
                        formatBaseQty(it.qtyOrderedBase, kind, locale),
                      ].join(" · ")
                    : formatBaseQty(it.qtyOrderedBase, kind, locale);
                return (
                  <div
                    key={it.id}
                    className="px-3 py-2 border-b border-op-border last:border-b-0"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {it.ingredient.name}
                        </div>
                        <div className="text-[11px] text-op-muted mt-0.5 truncate">
                          {composition}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-medium tabular-nums">
                          {formatMoney(purchaseLineAmounts(it).totalCents, {
                            currency,
                            locale,
                          })}
                        </div>
                        {(it.taxPct > 0 || it.expectedIncCents > 0) && (
                          <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                            {lineTaxText(it.taxPct, purchaseLineAmounts(it).incCents, currency)}
                          </div>
                        )}
                        {/* Acumulado de recepciones — solo lectura (la
                            recepción llega en A2.4). */}
                        {it.receivedQtyBase > 0 && (
                          <div className="text-[11px] text-ok mt-0.5 tabular-nums">
                            {`${t("receivedLabel")}: ${formatBaseQty(
                              it.receivedQtyBase,
                              kind,
                              locale,
                            )} · ${formatMoney(receivedPurchaseLineAmounts(it).totalCents, {
                              currency,
                              locale,
                            })}`}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              <TaxBreakdown
                lines={detailLines}
                currency={currency}
                totalLabel={t("orderTotalLabel")}
                incCents={detailTotals.incCents}
                retainedCents={detailTotals.retentionsCents}
                retentionRows={detailRetentionRows}
                discountCents={detailDiscount?.discountCents}
                listSubtotalCents={detailDiscount?.listSubtotalCents}
              />
            </div>

            {/* Historial de recepciones (libro purchase_in de esta OC) */}
            {order.movements.length > 0 && (
              <>
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mt-4 mb-2">
                  {t("receptionsCount", { count: order.movements.length })}
                </div>
                <div className="border border-op-border rounded-2xl overflow-hidden">
                  {order.movements.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-3 px-3 py-2 border-b border-op-border last:border-b-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {m.ingredient.name}
                        </div>
                        <div className="text-[11px] text-op-muted mt-0.5 truncate">
                          {[
                            formatDate(m.createdAt, { locale }),
                            m.createdBy?.name ?? null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-medium tabular-nums text-ok">
                          {`+${formatBaseQty(
                            m.qtyBase,
                            m.ingredient.measureKind,
                            locale,
                          )}`}
                        </div>
                        <div className="text-[11px] text-op-muted tabular-nums">
                          {formatMoney(m.valueCents, { currency, locale })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Factura subida (A2.5): evidencia PDF/foto que originó la OC. */}
            {order.invoiceUploads.length > 0 && (
              <>
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mt-4 mb-2">
                  {t("invoiceEvidence")}
                </div>
                <div className="border border-op-border rounded-2xl overflow-hidden">
                  {order.invoiceUploads.map((u) => (
                    <a
                      key={u.id}
                      href={u.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-3 px-3 py-2 border-b border-op-border last:border-b-0 hover:bg-op-bg"
                    >
                      <span className="text-sm truncate">
                        {formatDate(u.createdAt, { locale })}
                      </span>
                      <span className="text-sm font-medium text-terracotta shrink-0">
                        {t("viewInvoice")}
                      </span>
                    </a>
                  ))}
                </div>
              </>
            )}

            {/* CxP (F3): saldo + abonos. Solo OCs con mercancía recibida
                tienen cuenta por pagar (mismo gate del server). */}
            {(order.status === "received" ||
              order.status === "partially_received") &&
              (() => {
                // Total bruto de la CxP = Σ bruto de lo recibido (neto + IVA),
                // igual que el server. El esperado no cuenta para el saldo.
                const cxpTotals = purchaseOrderTotals(order, "received");
                const cxpTotal = cxpTotals.totalCents;
                const balance = cxpTotal - order.paidCents;
                return (
                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                        {t("cxpSectionTitle")}
                      </span>
                      {balance <= 0 ? (
                        <PayStatusChip status="paid" />
                      ) : order.paidCents > 0 ? (
                        <PayStatusChip status="partial" />
                      ) : null}
                    </div>
                    <div className="border border-op-border rounded-2xl overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-op-border">
                        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                          {t("cxpTotalLabel")}
                        </span>
                        <span className="text-sm tabular-nums">
                          {formatMoney(cxpTotal, { currency, locale })}
                        </span>
                      </div>
                      {cxpTotals.retentionsCents > 0 && (
                        <div className="px-3 py-1 border-b border-op-border text-[10px] text-op-muted" data-testid="cxp-retained">
                          {t("poCxpRetainedHint", { amount: formatMoney(cxpTotals.retentionsCents, { currency, locale }) })}
                        </div>
                      )}
                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-op-border">
                        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                          {t("cxpPaidLabel")}
                        </span>
                        <span className="text-sm tabular-nums">
                          {formatMoney(order.paidCents, { currency, locale })}
                        </span>
                      </div>
                      <div className="flex items-center justify-between px-3 py-1.5">
                        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                          {t("cxpBalanceLabel")}
                        </span>
                        <span className="text-sm font-medium tabular-nums">
                          {formatMoney(balance, { currency, locale })}
                        </span>
                      </div>
                    </div>

                    {/* Historial de abonos */}
                    {order.payments.length > 0 && (
                      <div className="border border-op-border rounded-2xl overflow-hidden mt-2">
                        {order.payments.map((p) => (
                          <div
                            key={p.id}
                            className="flex items-center gap-2 px-3 py-2 border-b border-op-border last:border-b-0"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium tabular-nums">
                                {formatMoney(p.amountCents, {
                                  currency,
                                  locale,
                                })}
                              </div>
                              <div className="text-[11px] text-op-muted mt-0.5 truncate">
                                {[
                                  formatDate(p.paidAt, { locale }),
                                  p.accountName ?? p.method,
                                  p.createdBy?.name ?? null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
                              {p.note && (
                                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                                  {p.note}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => void deletePayment(p.id)}
                              disabled={busy}
                              className="min-h-[36px] px-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 shrink-0 disabled:opacity-40"
                            >
                              {t("deletePayment")}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {balance > 0 &&
                      (payOpen ? (
                        <div className="border border-op-border rounded-2xl p-3 mt-2">
                          <PaymentForm
                            orderId={order.id}
                            totalCents={cxpTotal}
                            paidCents={order.paidCents}
                            currency={currency}
                            onDone={() => {
                              setPayOpen(false);
                              setReloadKey((k) => k + 1);
                              onChanged();
                            }}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setErr(null);
                            setOkMsg(null);
                            setPayOpen(true);
                          }}
                          className="mp-btn mp-btn--secondary mp-btn--block mt-2"
                        >
                          {t("registerPayment")}
                        </button>
                      ))}
                  </div>
                );
              })()}

            {err && <div className="text-xs text-danger mt-3">{err}</div>}
            {okMsg && <div className="text-xs text-ok mt-3">{okMsg}</div>}

            {/* Recibir mercancía — cualquier estado receivable (D3): se
                puede recibir directo desde borrador. */}
            {(order.status === "draft" ||
              order.status === "sent" ||
              order.status === "partially_received") && (
              <button
                type="button"
                onClick={() => {
                  setErr(null);
                  setOkMsg(null);
                  setReceiveOpen(true);
                }}
                disabled={busy}
                className="mp-btn mp-btn--primary mp-btn--block mt-4"
              >
                {t("receiveGoods")}
              </button>
            )}

            {/* Envío al proveedor (D6): WhatsApp + imprimir; ambos marcan
                `sent` si aún es borrador. */}
            {(order.status === "draft" || order.status === "sent") && (
              <>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  {order.supplier.phone ? (
                    <a
                      href={waLink(order.supplier.phone, buildWaText(order))}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={markSentIfDraft}
                      className="min-h-[44px] px-3 rounded-full bg-[#25D366]/10 text-[#128C7E] text-sm font-medium flex items-center justify-center"
                    >
                      {t("sendWhatsApp")}
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="min-h-[44px] px-3 rounded-full bg-[#25D366]/10 text-[#128C7E] text-sm font-medium opacity-40"
                    >
                      {t("sendWhatsApp")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={printOrder}
                    className="mp-btn mp-btn--secondary mp-btn--block"
                  >
                    {t("printOrder")}
                  </button>
                </div>
                {!order.supplier.phone && (
                  <div className="text-[10px] text-op-muted mt-1">
                    {t("waNoPhoneHint")}
                  </div>
                )}
                <div className="flex items-center justify-end gap-3 mt-4">
                  <button
                    type="button"
                    onClick={cancelOrder}
                    disabled={busy}
                    className="min-h-[44px] px-4 rounded-full text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
                  >
                    {t("cancelOrder")}
                  </button>
                  {order.status === "draft" && (
                    <button
                      type="button"
                      onClick={markSent}
                      disabled={busy}
                      className="mp-btn mp-btn--secondary"
                    >
                      {busy ? t("saving") : t("markSent")}
                    </button>
                  )}
                </div>
              </>
            )}

            {receiveOpen && (
              <ReceiveSheet
                order={order}
                currency={currency}
                onClose={() => setReceiveOpen(false)}
                onDone={(updated, complete) => {
                  setReceiveOpen(false);
                  // El POST devuelve la orden SIN includes — merge y refetch
                  // (los movements/acumulados frescos vienen del reload).
                  setOrder((prev) =>
                    prev ? { ...prev, ...updated } : prev,
                  );
                  setReloadKey((k) => k + 1);
                  setOkMsg(
                    complete ? t("receiveComplete") : t("receivePartial"),
                  );
                  onChanged();
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────────── Recepción de mercancía (sheet) ──────────────── */

type ReceiveLine = {
  itemId: string;
  include: boolean;
  qty: string;
  unit: string;
  cost: string;
  /** true cuando el operador tocó el costo — deja de precargarse. */
  costDirty: boolean;
  /** Descuento de la factura en esta línea (además del de la orden). */
  discRaw: string;
  discIsPct: boolean;
  /**
   * Impuesto según la factura (solo en una línea sin nada recibido). Sin
   * tocar (`taxDirty` false) es el de la orden y su consumo se reparte por
   * cantidad; tocado, se manda y el servidor lo fija en la línea.
   */
  tax: LineTaxChoice;
  incRaw: string;
  incIsPct: boolean;
  taxDirty: boolean;
};

/** Centavos → texto del control de consumo en valor ("1234.5"). */
function centsToIncRaw(cents: number): string {
  return cents > 0 ? String(cents / 100) : "";
}

/**
 * Lo que se registra en la recepción: costo digitado (sin impuestos) menos
 * el descuento de la línea y la parte del descuento del total, con el mismo
 * cálculo de la orden de compra (#393). Devuelve null en la fila inválida.
 * Con el impuesto de la factura tocado en una línea sin recibir, también su
 * tarifa de IVA y el consumo de ESTA entrega (el % va sobre el neto ya
 * descontado).
 */
function resolveReception(
  lines: ReceiveLine[],
  itemsById: Map<string, OrderItem>,
  orderDiscRaw: string,
  orderDiscIsPct: boolean,
) {
  const rows = lines.flatMap((l) => {
    const it = l.include ? itemsById.get(l.itemId) : undefined;
    if (!it) return [];
    const qtyBase = toBaseQty(Number(l.qty.replace(",", ".")), it.ingredient.measureKind, l.unit);
    const pesos = Number(l.cost.replace(",", "."));
    const listCents = l.cost.trim() !== "" && isFinite(pesos) && pesos >= 0 ? pesosToCents(pesos) : null;
    return [{ line: l, qtyBase, listCents }];
  });
  const valid = rows.filter(
    (r): r is { line: ReceiveLine; qtyBase: number; listCents: number } => r.qtyBase != null && r.listCents != null,
  );
  const persisted = persistedOrderDiscounts(
    valid.map((r) => ({ listCents: r.listCents, discRaw: r.line.discRaw, discIsPct: r.line.discIsPct })),
    orderDiscRaw,
    orderDiscIsPct,
  );
  const applied = resolveOrderDiscounts(
    valid.map((r, i) => ({ listCents: r.listCents, discount: persisted.lines[i]! })),
    persisted.order,
  );
  return {
    invalid: valid.length !== rows.length,
    lines: valid.map((r, i) => {
      const costCents = applied.lines[i]!.netCents;
      const it = itemsById.get(r.line.itemId);
      const taxChanged = r.line.taxDirty && it != null && lineTaxEditable(it);
      return {
        itemId: r.line.itemId,
        qtyBase: r.qtyBase,
        costCents,
        ...(taxChanged
          ? {
              taxPct: r.line.tax.ivaPct,
              incCents: r.line.tax.inc ? lineIncCents(costCents, parseDiscountInput(r.line.incRaw, r.line.incIsPct)) : 0,
            }
          : {}),
      };
    }),
    subtotalCents: applied.subtotalCents,
    discountCents: applied.discountCents,
  };
}

/** Consumo que le toca a una entrega con el impuesto de la orden (reparto por cantidad). */
function receptionIncDefault(it: OrderItem, qtyBase: number | null): number {
  if (qtyBase == null) return 0;
  return purchaseLineAmounts(it, it.receivedCostCents, it.receivedQtyBase + qtyBase).incCents
    - receivedPurchaseLineAmounts(it).incCents;
}

// Errores del POST /receive → clave i18n (fallback errSaveFailed).
const API_RECEIVE_ERROR_KEYS: Record<string, string> = {
  wrong_status: "errWrongStatus",
  line_invalid: "errLineInvalid",
  nothing_to_receive: "errNothingToReceive",
  retention_exceeds_base: "errRetentionExceedsBase",
  retention_exceeds_total: "errRetentionExceedsTotal",
  line_tax_locked: "errLineTaxLocked",
};

function ReceiveSheet({
  order,
  currency,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  currency: string;
  onClose: () => void;
  onDone: (updated: Partial<OrderDetail>, complete: boolean) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  // Solo líneas con pendiente (pedido − recibido); las completas se saltan.
  const pending = useMemo(
    () =>
      order.items.filter((it) => it.qtyOrderedBase - it.receivedQtyBase > 0),
    [order.items],
  );
  const itemsById = useMemo(
    () => new Map(pending.map((it) => [it.id, it])),
    [pending],
  );

  /** Costo esperado proporcional a la cantidad recibida, en pesos (input). */
  function proportionalCost(it: OrderItem, qtyBase: number | null): string {
    if (qtyBase == null) return "";
    return String(expectedReceiptCostCents(it, qtyBase) / 100);
  }

  const [lines, setLines] = useState<ReceiveLine[]>(() =>
    pending.map((it) => {
      const remaining = it.qtyOrderedBase - it.receivedQtyBase;
      const { qty, unit } = baseToInputQty(
        remaining,
        it.ingredient.measureKind,
      );
      return {
        itemId: it.id,
        include: true,
        qty,
        unit,
        cost: proportionalCost(it, remaining),
        costDirty: false,
        discRaw: "",
        discIsPct: true,
        tax: { ivaPct: it.taxPct, inc: it.expectedIncCents > 0 },
        incRaw: "",
        incIsPct: false,
        taxDirty: false,
      };
    }),
  );
  const [orderDiscRaw, setOrderDiscRaw] = useState("");
  const [orderDiscIsPct, setOrderDiscIsPct] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const country = usePurchaseCountry();
  const taxRates = useMemo(() => purchaseTaxRates(country), [country]);
  const taxCtx = usePurchaseTaxContext();
  const lineTaxText = useLineTaxText();
  const retentionRows = useRetentionRows();

  // Lo que se va a registrar y su efecto en la cuenta por pagar: la misma
  // cuenta que hace el servidor (IVA documental proporcional al neto real,
  // consumo y retenciones según lo recibido; el impuesto que cambió la
  // factura, con el mismo `receptionLineTax`).
  const reception = useMemo(
    () => resolveReception(lines, itemsById, orderDiscRaw, orderDiscIsPct),
    [lines, itemsById, orderDiscRaw, orderDiscIsPct],
  );
  const receptionTotals = useMemo(() => {
    const received = new Map(reception.lines.map((r) => [r.itemId, r]));
    const before = purchaseOrderTotals(order, "received");
    const items = order.items.map((it) => {
      const r = received.get(it.id);
      if (!r) return it;
      const tax = "taxPct" in r ? receptionLineTax(it, r, r.qtyBase, r.costCents) : null;
      const taxed = tax?.changed
        ? { ...it, taxPct: tax.taxPct, expectedTaxCents: tax.expectedTaxCents, expectedIncCents: tax.expectedIncCents }
        : it;
      return { ...taxed, receivedQtyBase: it.receivedQtyBase + r.qtyBase, receivedCostCents: it.receivedCostCents + r.costCents };
    });
    const incDelta = items.reduce((sum, it, i) => sum + it.expectedIncCents - order.items[i]!.expectedIncCents, 0);
    const after = purchaseOrderTotals({ ...order, incCents: (order.incCents ?? 0) + incDelta, items }, "received");
    return {
      netCents: after.subtotalCents - before.subtotalCents,
      taxCents: after.taxCents - before.taxCents,
      incCents: after.incCents - before.incCents,
      // Las de una factura importada como borrador, según el avance.
      retentionsCents: after.retentionsCents - before.retentionsCents,
    };
  }, [reception, order]);
  // Retenciones de la factura de ESTA entrega, sobre lo que llega en ella.
  const receptionDoc = {
    baseCents: receptionTotals.netCents,
    ivaCents: receptionTotals.taxCents,
    incCents: receptionTotals.incCents,
  };
  const retentions = useInvoiceRetentions(taxCtx, receptionDoc);
  const retainedNow = retentionTotalCents(retentions.totals);

  function updateLine(itemId: string, changes: Partial<ReceiveLine>) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.itemId !== itemId) return l;
        const next = { ...l, ...changes };
        // Mientras el operador no toque el costo, se re-deriva proporcional
        // a la cantidad digitada (costo esperado de ESA cantidad).
        if (!next.costDirty && changes.cost === undefined) {
          const it = itemsById.get(itemId);
          if (it) {
            const qtyBase = toBaseQty(
              Number(next.qty.replace(",", ".")),
              it.ingredient.measureKind,
              next.unit,
            );
            next.cost = proportionalCost(it, qtyBase);
          }
        }
        return next;
      }),
    );
  }

  const anyIncluded = lines.some((l) => l.include);

  // Cambio del «Impuesto» de una línea en la factura. La primera vez que se
  // toca, arranca de lo que se ve (el consumo que le tocaba a la entrega);
  // elegir consumo en una línea que no lo traía propone el 8 %.
  function changeReceiveTax(
    l: ReceiveLine,
    shown: { incRaw: string; incIsPct: boolean },
    next: { choice?: LineTaxChoice; incRaw?: string; incIsPct?: boolean },
  ) {
    const tax = next.choice ?? l.tax;
    let incRaw = next.incRaw ?? shown.incRaw;
    let incIsPct = next.incIsPct ?? shown.incIsPct;
    if (next.choice?.inc && !l.tax.inc && incRaw.trim() === "") {
      incRaw = String(DEFAULT_INC_PCT);
      incIsPct = true;
    }
    updateLine(l.itemId, { tax, incRaw, incIsPct, taxDirty: true });
  }

  async function submit() {
    setErr(null);
    // Neto de cada línea, ya con los descuentos de la factura: es lo que
    // entra al inventario, a la cuenta por pagar y al precio del proveedor.
    if (reception.invalid) {
      setErr(t("errLineInvalid"));
      return;
    }
    if (retentions.error) return;
    const payload = reception.lines;
    if (payload.length === 0) return;
    setBusy(true);
    const r = await fetch(
      `/api/operator/purchase-orders/${order.id}/receive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: payload, ...retentions.totals }),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_RECEIVE_ERROR_KEYS[j.error as string];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    onDone(j.order as Partial<OrderDetail>, Boolean(j.complete));
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-2xl">{t("receiveGoods")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <p className="text-[11px] text-op-muted mb-4">{t("receiveHint")}</p>

        {pending.length === 0 ? (
          <div className="text-xs text-danger">{t("errNothingToReceive")}</div>
        ) : (
          <div className="border border-op-border rounded-2xl overflow-hidden">
            {lines.map((l) => {
              const it = itemsById.get(l.itemId);
              if (!it) return null;
              const kind = it.ingredient.measureKind;
              const remaining = it.qtyOrderedBase - it.receivedQtyBase;
              return (
                <div
                  key={l.itemId}
                  className="px-3 py-2.5 border-b border-op-border last:border-b-0"
                >
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={l.include}
                      onChange={(e) =>
                        updateLine(l.itemId, { include: e.target.checked })
                      }
                      className="h-4 w-4 accent-ink shrink-0"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">
                        {it.ingredient.name}
                      </span>
                      <span className="block text-[11px] text-op-muted mt-0.5 truncate">
                        {`${t("pendingLabel")}: ${formatBaseQty(
                          remaining,
                          kind,
                          locale,
                        )}`}
                      </span>
                    </span>
                  </label>
                  {l.include && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <Field label={t("fieldQty")} required>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={l.qty}
                            onChange={(e) =>
                              updateLine(l.itemId, { qty: sanitizeDecimalInput(e.target.value) })
                            }
                            className={inputCls + " flex-1 min-w-0"}
                          />
                          <select
                            value={l.unit}
                            onChange={(e) =>
                              updateLine(l.itemId, { unit: e.target.value })
                            }
                            disabled={DISPLAY_UNITS[kind].length < 2}
                            className="min-h-[44px] w-16 px-2 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
                          >
                            {DISPLAY_UNITS[kind].map((u) => (
                              <option key={u.symbol} value={u.symbol}>
                                {u.symbol}
                              </option>
                            ))}
                          </select>
                        </div>
                      </Field>
                      <Field label={`${t("fieldRealCost")} (${currency})`} required hint={t("receiveCostHint")}>
                        <MoneyInput
                          value={l.cost}
                          fractionDigits={2}
                          onChange={(d) =>
                            updateLine(l.itemId, {
                              cost: d,
                              costDirty: true,
                            })
                          }
                          className={inputCls}
                        />
                      </Field>
                      <div className="col-span-2">
                        <DiscountControl
                          id={`receive-discount-${l.itemId}`}
                          label={t("invDiscLineLabel")}
                          raw={l.discRaw}
                          isPct={l.discIsPct}
                          currency={currency}
                          onChange={(discRaw, discIsPct) => updateLine(l.itemId, { discRaw, discIsPct })}
                        />
                        {/* El costo precargado ya trae el descuento de la
                            orden: aquí solo va uno adicional de la factura. */}
                        {it.listCostCents != null && it.listCostCents > it.expectedCostCents && (
                          <p className="mt-1 text-[10px] text-op-muted">{t("receiveDiscIncluded")}</p>
                        )}
                      </div>
                      <div className="col-span-2">
                        {(() => {
                          const qtyBase = toBaseQty(Number(l.qty.replace(",", ".")), kind, l.unit);
                          const defaultInc = receptionIncDefault(it, qtyBase);
                          if (!lineTaxEditable(it)) {
                            // Ya llegó una parte: el impuesto quedó con la primera entrega.
                            const text = lineTaxText(it.taxPct, defaultInc, currency);
                            return (
                              <p className="text-[11px] text-op-muted">
                                {[text || t("poTaxNone"), t("poTaxLocked")].join(" · ")}
                              </p>
                            );
                          }
                          const shown = l.taxDirty
                            ? { incRaw: l.incRaw, incIsPct: l.incIsPct }
                            : { incRaw: centsToIncRaw(defaultInc), incIsPct: false };
                          const sent = reception.lines.find((x) => x.itemId === l.itemId);
                          const incCents = sent && "incCents" in sent ? (sent.incCents ?? 0) : defaultInc;
                          return (
                            <LineTaxFields
                              id={`receive-${l.itemId}`}
                              choice={l.tax}
                              rates={taxRates}
                              incRaw={shown.incRaw}
                              incIsPct={shown.incIsPct}
                              incCents={incCents}
                              currency={currency}
                              onChange={(next) => changeReceiveTax(l, shown, next)}
                            />
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {/* Pie de la factura de esta entrega: descuento del total
                (prorrateado como en la orden) y lo que queda por pagar. */}
            {anyIncluded && (
              <>
                <DiscountControl
                  id="receive-order-discount"
                  label={t("orderDiscountLabel")}
                  raw={orderDiscRaw}
                  isPct={orderDiscIsPct}
                  currency={currency}
                  onChange={(raw, isPct) => {
                    setOrderDiscRaw(raw);
                    setOrderDiscIsPct(isPct);
                  }}
                  className="px-3 py-2 border-t border-op-border"
                />
                {/* Impuestos y retenciones de la factura de esta entrega. */}
                <div className="px-3 py-3 border-t border-op-border space-y-2">
                  <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                    {t("poTaxSectionTitle")}
                  </div>
                  <InvoiceRetentionsEditor
                    state={retentions}
                    ctx={taxCtx}
                    doc={receptionDoc}
                    currency={currency}
                    hint={t("poRetPerReceptionHint")}
                  />
                </div>
                <div className="border-t border-op-border" data-testid="receive-breakdown">
                  <TaxBreakdown
                    lines={[{ costCents: receptionTotals.netCents, taxPct: 0, taxCents: receptionTotals.taxCents }]}
                    currency={currency}
                    totalLabel={t("invTaxGrandTotal")}
                    alwaysBreakdown
                    discountCents={reception.discountCents}
                    listSubtotalCents={reception.subtotalCents}
                    incCents={receptionTotals.incCents}
                    retainedCents={receptionTotals.retentionsCents + retainedNow}
                    retentionRows={receptionTotals.retentionsCents === 0 ? retentionRows(retentions.totals) : undefined}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex items-center justify-end gap-3 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="mp-btn mp-btn--secondary"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !anyIncluded || pending.length === 0 || retentions.error != null}
            className="mp-btn mp-btn--primary"
          >
            {busy ? t("receiving") : t("receiveSubmit")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Por pagar (CxP, D5) ─────────────────────── */

/** Total recibido de la OC (bruto: neto + IVA del acumulado por línea). */
function receivedTotal(o: OrderSummary): number {
  return purchaseOrderTotals(o, "received").totalCents;
}

/** Saldo pendiente de la OC = total bruto recibido − abonado. */
function outstandingOf(o: OrderSummary): number {
  return receivedTotal(o) - o.paidCents;
}

// Estado de pago de la CxP (por abonos): pagada / parcial / vencida / pendiente.
type PayStatus = "paid" | "partial" | "overdue" | "pending";

/** Deriva el estado de pago de una OC. `now`=0 (sin fetch aún) ⇒ nunca vencida. */
function payStatus(o: OrderSummary, now: number): PayStatus {
  const outstanding = outstandingOf(o);
  if (outstanding <= 0) return "paid";
  const overdue =
    o.invoiceDueAt != null && now > 0 && new Date(o.invoiceDueAt).getTime() < now;
  if (overdue) return "overdue";
  if (o.paidCents > 0) return "partial";
  return "pending";
}

const PAY_STATUS_KEYS: Record<PayStatus, string> = {
  paid: "payStatusPaid",
  partial: "payStatusPartial",
  overdue: "payStatusOverdue",
  pending: "payStatusPending",
};

// Colores por estado de pago — mismos tokens del archivo: ok (pagada), ámbar
// (parcial), danger (vencida), neutro (pendiente).
const PAY_STATUS_CLS: Record<PayStatus, string> = {
  paid: "bg-ok/10 text-ok",
  partial: "bg-[#C98A2E]/15 text-[#7F5A1F]",
  overdue: "bg-danger/10 text-danger",
  pending: "bg-paper text-op-muted",
};

function PayStatusChip({ status }: { status: PayStatus }) {
  const t = useTranslations("opErp");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
        PAY_STATUS_CLS[status]
      }
    >
      {t(PAY_STATUS_KEYS[status])}
    </span>
  );
}

function UnpaidTab({
  currency,
  onOpenDetail,
}: {
  currency: string;
  onOpenDetail: (id: string) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [rows, setRows] = useState<OrderSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listErr, setListErr] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [payFor, setPayFor] = useState<OrderSummary | null>(null);
  const [invoiceFor, setInvoiceFor] = useState<OrderSummary | null>(null);
  // "Ahora" congelado al momento del fetch (regla de pureza del render):
  // suficiente para resaltar vencidas — el corte es por día, no por segundo.
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (rows !== null || listErr) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/purchase-orders?unpaid=1");
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (cancelled) return;
        setRows((j.orders ?? []) as OrderSummary[]);
        setNextCursor(j.nextCursor ?? null);
        setNow(Date.now());
      } catch {
        if (!cancelled) setListErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, listErr]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(
        `/api/operator/purchase-orders?unpaid=1&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setRows((prev) => [
        ...(prev ?? []),
        ...((j.orders ?? []) as OrderSummary[]),
      ]);
      setNextCursor(j.nextCursor ?? null);
    } catch {
      setListErr(true);
    }
    setLoadingMore(false);
  }

  // Refrescar la lista desde cero (tras registrar/borrar un abono): un pago
  // total saca la OC de "por pagar"; uno parcial actualiza saldo/estado.
  function reload() {
    setRows(null);
    setNextCursor(null);
    setListErr(false);
  }

  // Total por pagar = suma de los SALDOS pendientes (no del bruto total).
  const totalDue = (rows ?? []).reduce((sum, o) => sum + outstandingOf(o), 0);

  return (
    <>
      {listErr ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : rows === null ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t(nextCursor ? "unpaidMoreCandidates" : "unpaidEmpty")}
        </div>
      ) : (
        <>
          <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-op-bg/50 border-b border-op-border">
              <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {t("unpaidTotalLabel")}
              </span>
              <span className="text-sm font-medium tabular-nums">
                {formatMoney(totalDue, { currency, locale })}
              </span>
            </div>
            {rows.map((o) => {
              const status = payStatus(o, now);
              const overdue = status === "overdue";
              const totals = purchaseOrderTotals(o, "received");
              const total = totals.totalCents;
              const outstanding = total - o.paidCents;
              return (
                <div
                  key={o.id}
                  className="px-4 py-2.5 border-b border-op-border last:border-b-0"
                >
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => onOpenDetail(o.id)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium shrink-0">
                          {t("poNumber", { number: padNumber(o.number) })}
                        </span>
                        <span className="text-sm text-op-muted truncate">
                          {o.supplier.name}
                        </span>
                        <PayStatusChip status={status} />
                      </div>
                      <div className="text-[11px] mt-0.5 truncate">
                        <span className="text-op-muted">
                          {o.supplierInvoiceNumber
                            ? t("invoiceLabel", {
                                number: o.supplierInvoiceNumber,
                              })
                            : t("noInvoiceNumber")}
                        </span>
                        {o.invoiceDueAt != null && (
                          <span
                            className={
                              overdue
                                ? "text-danger font-medium"
                                : "text-op-muted"
                            }
                          >
                            {" · "}
                            {t("dueLabel", {
                              date: formatDate(o.invoiceDueAt, {
                                locale,
                                timeStyle: undefined,
                              }),
                            })}
                            {overdue && ` · ${t("overdueLabel")}`}
                          </span>
                        )}
                      </div>
                    </button>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-medium tabular-nums">
                        {formatMoney(outstanding, { currency, locale })}
                      </div>
                      <div className="text-[10px] text-op-muted tabular-nums mt-0.5">
                        {t("cxpTotalPaid", {
                          total: formatMoney(total, { currency, locale }),
                          paid: formatMoney(o.paidCents, { currency, locale }),
                        })}
                      </div>
                      {totals.retentionsCents > 0 && (
                        <div className="text-[10px] text-op-muted tabular-nums mt-0.5">
                          {t("poUnpaidRetained", { amount: formatMoney(totals.retentionsCents, { currency, locale }) })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => setInvoiceFor(o)}
                      className="min-h-[36px] px-3 rounded-full text-[11px] font-medium text-op-muted hover:text-ink"
                    >
                      {t("editInvoice")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayFor(o)}
                      className="mp-btn mp-btn--sm mp-btn--secondary"
                    >
                      {t("registerPayment")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {!listErr && rows !== null && nextCursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mp-btn mp-btn--secondary mp-btn--block"
        >
          {loadingMore ? t("loading") : t("loadMore")}
        </button>
      )}

      {payFor && (
        <RegisterPaymentSheet
          order={payFor}
          currency={currency}
          onClose={() => setPayFor(null)}
          onDone={() => {
            setPayFor(null);
            reload();
          }}
        />
      )}

      {invoiceFor && (
        <InvoiceSheet
          order={invoiceFor}
          onClose={() => setInvoiceFor(null)}
          onSaved={(updated) => {
            setInvoiceFor(null);
            setRows((prev) =>
              (prev ?? []).map((r) =>
                r.id === updated.id ? { ...r, ...updated } : r,
              ),
            );
          }}
        />
      )}
    </>
  );
}

// Errores del POST /payments → clave i18n (fallback errSaveFailed).
const API_PAYMENT_ERROR_KEYS: Record<string, string> = {
  exceeds_balance: "errExceedsBalance",
  wrong_status: "errWrongStatus",
  invalid: "errLineInvalid",
  not_found: "errLoadFailed",
  account_invalid: "errAccountInvalid",
};

/** Resultado del POST/DELETE de abonos (saldos frescos del server). */
type PaymentResult = {
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
};

/**
 * Formulario de un abono: monto (prellenado con el saldo, editable),
 * fecha, cuenta de donde sale la plata (caja, banco, pasarela) y nota.
 * Botón "Registrar pago" + atajo "Pagar saldo" (abono por el saldo
 * completo). Reutilizado por el sheet de la CxP y por el detalle de la OC.
 */
function PaymentForm({
  orderId,
  totalCents,
  paidCents,
  currency,
  onDone,
}: {
  orderId: string;
  totalCents: number;
  paidCents: number;
  currency: string;
  onDone: (r: PaymentResult) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const outstanding = Math.max(0, totalCents - paidCents);

  const [amount, setAmount] = useState(() => centsToPesosInput(outstanding));
  const [paidAt, setPaidAt] = useState(todayDateInput);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cuentas de dinero de donde puede salir el pago. null = cargando;
  // [] = la carga falló o el plan no tiene ninguna (no se puede pagar).
  const [accounts, setAccounts] = useState<PaymentAccountRef[] | null>(null);
  const [accountCode, setAccountCode] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/operator/purchase-orders/payment-accounts")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (!alive) return;
        const rows = (j as { accounts: PaymentAccountRef[] }).accounts;
        setAccounts(rows);
        // Default: la primera cuenta (caja general), sin pisar una elección previa.
        setAccountCode((prev) => prev || (rows[0]?.code ?? ""));
      })
      .catch(() => {
        if (alive) setAccounts([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const accountsReady = (accounts?.length ?? 0) > 0;
  const accountsError =
    accounts !== null && accounts.length === 0
      ? t("paymentAccountsLoadFailed")
      : null;

  async function post(amountCents: number) {
    if (busy) return;
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      setErr(t("errLineInvalid"));
      return;
    }
    if (!accountCode) {
      setErr(t("errAccountInvalid"));
      return;
    }
    if (amountCents > outstanding) {
      setErr(t("errExceedsBalance"));
      return;
    }
    setErr(null);
    setBusy(true);
    const r = await fetch(
      `/api/operator/purchase-orders/${orderId}/payments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents,
          paidAt: paidAt ? dateInputToIso(paidAt) : null,
          accountCode,
          note: note.trim() || null,
        }),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_PAYMENT_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(t(key ?? "errSaveFailed"));
      return;
    }
    const j = (await r.json()) as PaymentResult;
    onDone(j);
  }

  function submit() {
    const cents = pesosInputToCents(amount);
    if (cents === null) {
      setErr(t("errLineInvalid"));
      return;
    }
    void post(cents);
  }

  function payFull() {
    void post(outstanding);
  }

  return (
    <>
      <div className="rounded-2xl border border-op-border overflow-hidden mb-4">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-op-border">
          <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("cxpTotalLabel")}
          </span>
          <span className="text-sm tabular-nums">
            {formatMoney(totalCents, { currency, locale })}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-op-border">
          <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("cxpPaidLabel")}
          </span>
          <span className="text-sm tabular-nums">
            {formatMoney(paidCents, { currency, locale })}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("cxpBalanceLabel")}
          </span>
          <span className="text-sm font-medium tabular-nums">
            {formatMoney(outstanding, { currency, locale })}
          </span>
        </div>
      </div>

      <div className="space-y-3">
        <Field label={t("fieldPaymentAmount")}>
          <MoneyInput
            value={amount}
            onChange={setAmount}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldPaymentDate")}>
          <input
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldPayFromAccount")} hint={t("payFromAccountHint")}>
          <select
            value={accountCode}
            onChange={(e) => setAccountCode(e.target.value)}
            disabled={!accountsReady}
            className="w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          >
            {(accounts ?? []).map((a) => (
              <option key={a.code} value={a.code}>
                {`${a.code} · ${a.name}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("fieldPaymentNote")} hint={t("paymentNoteHint")}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
          />
        </Field>
      </div>

      {(err ?? accountsError) && (
        <div className="text-xs text-danger mt-3">{err ?? accountsError}</div>
      )}

      <div className="flex items-center justify-end gap-3 mt-4">
        <button
          type="button"
          onClick={payFull}
          disabled={busy || outstanding < 1 || !accountsReady}
          className="mp-btn mp-btn--secondary"
        >
          {t("payFull")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !accountsReady}
          className="mp-btn mp-btn--primary"
        >
          {busy ? t("saving") : t("registerPayment")}
        </button>
      </div>
    </>
  );
}

/** Sheet "Registrar pago" desde la CxP: cabecera + PaymentForm. */
function RegisterPaymentSheet({
  order,
  currency,
  onClose,
  onDone,
}: {
  order: OrderSummary;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("opErp");

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-2xl">{t("registerPaymentTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <div className="text-[11px] text-op-muted mb-4 truncate">
          {[
            t("poNumber", { number: padNumber(order.number) }),
            order.supplier.name,
          ].join(" · ")}
        </div>

        <PaymentForm
          orderId={order.id}
          totalCents={receivedTotal(order)}
          paidCents={order.paidCents}
          currency={currency}
          onDone={onDone}
        />
      </div>
    </div>
  );
}

/** Nº de factura + vencimiento (PATCH update_invoice). */
function InvoiceSheet({
  order,
  onClose,
  onSaved,
}: {
  order: OrderSummary;
  onClose: () => void;
  onSaved: (updated: Partial<OrderSummary> & { id: string }) => void;
}) {
  const t = useTranslations("opErp");
  const [invoiceNumber, setInvoiceNumber] = useState(
    order.supplierInvoiceNumber ?? "",
  );
  const [dueAt, setDueAt] = useState(
    isoToDateInput(
      order.invoiceDueAt == null ? null : String(order.invoiceDueAt),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setBusy(true);
    const r = await fetch(`/api/operator/purchase-orders/${order.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update_invoice",
        supplierInvoiceNumber: invoiceNumber.trim() || null,
        invoiceDueAt: dueAt ? dateInputToIso(dueAt) : null,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setErr(t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    onSaved(j.order as Partial<OrderSummary> & { id: string });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-2xl">{t("editInvoiceTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <div className="text-[11px] text-op-muted mb-4 truncate">
          {[
            t("poNumber", { number: padNumber(order.number) }),
            order.supplier.name,
          ].join(" · ")}
        </div>

        <div className="space-y-3">
          <Field label={t("fieldInvoiceNumber")}>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              maxLength={80}
              className={inputCls}
            />
          </Field>
          <Field label={t("fieldInvoiceDueAt")}>
            <input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex items-center justify-end gap-3 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="mp-btn mp-btn--secondary"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="mp-btn mp-btn--primary"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

