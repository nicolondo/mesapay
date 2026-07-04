"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, pesosToCents } from "@/lib/format";
import { waLink } from "@/lib/crm/phone";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";

/* ───────────────────────────── Tipos ───────────────────────────────── */

const PO_STATUSES = [
  "draft",
  "sent",
  "partially_received",
  "received",
  "canceled",
] as const;
type PoStatus = (typeof PO_STATUSES)[number];

type OrderSummary = {
  id: string;
  number: number;
  status: PoStatus;
  createdAt: string | Date;
  // CxP (tab "Por pagar") — el GET de lista devuelve todos los escalares.
  supplierInvoiceNumber: string | null;
  invoiceDueAt: string | Date | null;
  supplier: { id: string; name: string };
  items: { expectedCostCents: number; receivedCostCents: number }[];
  _count: { items: number };
};

type SupplierRef = { id: string; name: string };

type IngredientRef = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  active: boolean;
};

/** Fila de la lista de precios del proveedor (A0). */
type PriceListItem = {
  id: string;
  presentationLabel: string;
  contentQty: number;
  lastPriceCents: number | null;
  ingredient: IngredientRef;
};

type OrderDetail = {
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
  paymentNote: string | null;
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
    receivedQtyBase: number;
    receivedCostCents: number;
    ingredient: { id: string; name: string; measureKind: MeasureKind };
    supplierItem: {
      id: string;
      presentationLabel: string;
      contentQty: number;
    } | null;
  }[];
  // Recepciones del libro (movimientos purchase_in ligados a la OC).
  movements: ReceptionMovement[];
};

type ReceptionMovement = {
  id: string;
  qtyBase: number;
  valueCents: number;
  createdAt: string;
  ingredient: { id: string; name: string; measureKind: MeasureKind };
  createdBy: { id: string; name: string | null } | null;
};

type OrderItem = OrderDetail["items"][number];

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
  return { qty: String(base), unit: units[0].symbol };
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

// Errores del POST de creación → clave i18n (fallback errSaveFailed).
const API_CREATE_ERROR_KEYS: Record<string, string> = {
  supplier_not_found: "errSupplierNotFound",
  ingredient_not_found: "errIngredientNotFound",
  supplier_item_mismatch: "errSupplierItemMismatch",
  no_lines: "errNoLines",
  line_invalid: "errLineInvalid",
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

/* ───────────────────────────── Lista ───────────────────────────────── */

type Filter = "all" | PoStatus;
type Tab = "orders" | "unpaid";

export function ComprasClient({
  initialOrders,
  initialCursor,
  suppliers,
  currency,
}: {
  initialOrders: OrderSummary[];
  initialCursor: string | null;
  suppliers: SupplierRef[];
  currency: string;
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
  const [detailId, setDetailId] = useState<string | null>(null);

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
      <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
        {(
          [
            ["orders", t("tabOrders")],
            ["unpaid", t("tabUnpaid")],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              "min-h-[44px] px-5 text-xs font-medium transition-colors " +
              (tab === value
                ? "bg-ink text-bone"
                : "text-op-muted hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "unpaid" ? (
        <UnpaidTab currency={currency} onOpenDetail={setDetailId} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
          >
            {t("newOrder")}
          </button>

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
              const total = o.items.reduce(
                (sum, it) => sum + it.expectedCostCents,
                0,
              );
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
              className="w-full min-h-[44px] rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg disabled:opacity-40"
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
        <NewOrderSheet
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
    </div>
  );
}

/* ───────────────────────── Nueva orden (sheet) ─────────────────────── */

type DraftLine = {
  key: number;
  ingredientId: string;
  ingredientName: string;
  measureKind: MeasureKind;
  supplierItemId: string | null;
  presentationLabel: string | null;
  presentations: number | null;
  /** Derivado para display; el POST solo lo manda en líneas libres. */
  qtyBase: number;
  expectedCostCents: number;
};

type LineMode = "list" | "free";

let lineKeySeq = 0;

function NewOrderSheet({
  suppliers,
  currency,
  onClose,
  onCreated,
}: {
  suppliers: SupplierRef[];
  currency: string;
  onClose: () => void;
  onCreated: (orderId: string) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [supplier, setSupplier] = useState<SupplierRef | null>(null);
  const [supQ, setSupQ] = useState("");
  // Lista de precios del proveedor elegido + insumos (líneas libres); null
  // = cargando tras elegir proveedor.
  const [priceList, setPriceList] = useState<PriceListItem[] | null>(null);
  const [ingredients, setIngredients] = useState<IngredientRef[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [notes, setNotes] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Formulario de línea
  const [mode, setMode] = useState<LineMode>("list");
  const [pickedItem, setPickedItem] = useState<PriceListItem | null>(null);
  const [itemQ, setItemQ] = useState("");
  const [presentations, setPresentations] = useState("1");
  const [pickedIng, setPickedIng] = useState<IngredientRef | null>(null);
  const [ingQ, setIngQ] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [cost, setCost] = useState("");
  // El costo se precarga (n × último precio) hasta que el operador lo toca.
  const [costDirty, setCostDirty] = useState(false);
  const [lineErr, setLineErr] = useState<string | null>(null);

  const supMatches = useMemo(() => {
    const needle = fold(supQ.trim());
    return suppliers
      .filter((s) => !needle || fold(s.name).includes(needle))
      .slice(0, 8);
  }, [suppliers, supQ]);

  function pickSupplier(s: SupplierRef) {
    setSupplier(s);
    setPriceList(null);
    setIngredients(null);
    setLoadErr(false);
  }

  // El reset de priceList/ingredients pasa en pickSupplier (handler), no
  // acá — el effect solo sincroniza con la API (regla set-state-in-effect).
  useEffect(() => {
    if (!supplier) return;
    let cancelled = false;
    (async () => {
      try {
        const [rs, ri] = await Promise.all([
          fetch(`/api/operator/suppliers/${supplier.id}`),
          fetch("/api/operator/ingredients"),
        ]);
        if (!rs.ok || !ri.ok) throw new Error("load_failed");
        const js = await rs.json();
        const ji = await ri.json();
        if (cancelled) return;
        // Solo presentaciones de insumos activos — no se piden inactivos.
        setPriceList(
          ((js.supplier?.items ?? []) as PriceListItem[]).filter(
            (i) => i.ingredient.active,
          ),
        );
        setIngredients(
          ((ji.ingredients ?? []) as IngredientRef[]).filter((i) => i.active),
        );
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplier]);

  const itemMatches = useMemo(() => {
    const needle = fold(itemQ.trim());
    return (priceList ?? [])
      .filter(
        (i) =>
          !needle ||
          fold(`${i.ingredient.name} ${i.presentationLabel}`).includes(needle),
      )
      .slice(0, 8);
  }, [priceList, itemQ]);

  const ingMatches = useMemo(() => {
    const needle = fold(ingQ.trim());
    return (ingredients ?? [])
      .filter((i) => !needle || fold(i.name).includes(needle))
      .slice(0, 8);
  }, [ingredients, ingQ]);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + l.expectedCostCents, 0),
    [lines],
  );

  // Cuando el proveedor no tiene lista de precios, la única vía es la
  // línea libre — se fuerza el modo para no mostrar un combobox vacío.
  const effectiveMode: LineMode =
    priceList !== null && priceList.length === 0 ? "free" : mode;

  function resetLineForm() {
    setPickedItem(null);
    setItemQ("");
    setPresentations("1");
    setPickedIng(null);
    setIngQ("");
    setQty("");
    setUnit("");
    setCost("");
    setCostDirty(false);
    setLineErr(null);
  }

  function pickItem(item: PriceListItem) {
    setPickedItem(item);
    setPresentations("1");
    setCostDirty(false);
    setCost(item.lastPriceCents != null ? String(item.lastPriceCents / 100) : "");
  }

  function changePresentations(v: string) {
    setPresentations(v);
    if (!costDirty && pickedItem?.lastPriceCents != null) {
      const n = Number(v);
      setCost(
        Number.isInteger(n) && n >= 1
          ? String((n * pickedItem.lastPriceCents) / 100)
          : "",
      );
    }
  }

  function parseCost(): number | null {
    if (cost.trim() === "") return null;
    const p = Number(cost.replace(",", "."));
    if (!isFinite(p) || p < 0) return null;
    return pesosToCents(p);
  }

  function addLine() {
    setLineErr(null);
    const expectedCostCents = parseCost();
    if (expectedCostCents == null) {
      setLineErr(t("errCostInvalid"));
      return;
    }
    if (effectiveMode === "list") {
      if (!pickedItem) return;
      const n = Number(presentations);
      if (!Number.isInteger(n) || n < 1) {
        setLineErr(t("errLineInvalid"));
        return;
      }
      setLines((prev) => [
        ...prev,
        {
          key: ++lineKeySeq,
          ingredientId: pickedItem.ingredient.id,
          ingredientName: pickedItem.ingredient.name,
          measureKind: pickedItem.ingredient.measureKind,
          supplierItemId: pickedItem.id,
          presentationLabel: pickedItem.presentationLabel,
          presentations: n,
          qtyBase: n * pickedItem.contentQty,
          expectedCostCents,
        },
      ]);
    } else {
      if (!pickedIng) return;
      const qtyBase = toBaseQty(
        Number(qty.replace(",", ".")),
        pickedIng.measureKind,
        unit,
      );
      if (qtyBase == null) {
        setLineErr(t("errContentInvalid"));
        return;
      }
      setLines((prev) => [
        ...prev,
        {
          key: ++lineKeySeq,
          ingredientId: pickedIng.id,
          ingredientName: pickedIng.name,
          measureKind: pickedIng.measureKind,
          supplierItemId: null,
          presentationLabel: null,
          presentations: null,
          qtyBase,
          expectedCostCents,
        },
      ]);
    }
    resetLineForm();
  }

  async function submit() {
    if (!supplier || lines.length === 0) return;
    setErr(null);
    setBusy(true);
    const r = await fetch("/api/operator/purchase-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        supplierId: supplier.id,
        lines: lines.map((l) =>
          l.supplierItemId
            ? {
                ingredientId: l.ingredientId,
                supplierItemId: l.supplierItemId,
                presentations: l.presentations,
                expectedCostCents: l.expectedCostCents,
              }
            : {
                ingredientId: l.ingredientId,
                qtyBase: l.qtyBase,
                expectedCostCents: l.expectedCostCents,
              },
        ),
        notes: notes.trim() || null,
        expectedAt: expectedAt ? dateInputToIso(expectedAt) : null,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_CREATE_ERROR_KEYS[j.error as string];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    onCreated((j.order as { id: string }).id);
  }

  const lineAddDisabled =
    effectiveMode === "list"
      ? !pickedItem || presentations.trim() === "" || cost.trim() === ""
      : !pickedIng || qty.trim() === "" || cost.trim() === "";

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl">{t("newOrderTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <div className="space-y-3">
          <Field label={t("fieldSupplier")} required>
            {supplier ? (
              <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-surface text-sm flex items-center justify-between gap-2">
                <span className="truncate">{supplier.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSupplier(null);
                    setSupQ("");
                    setLines([]);
                    resetLineForm();
                  }}
                  className="text-[11px] font-medium text-op-muted hover:text-ink shrink-0"
                >
                  {t("changeSupplier")}
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="search"
                  value={supQ}
                  onChange={(e) => setSupQ(e.target.value)}
                  placeholder={t("supplierSearchPlaceholder")}
                  className={inputCls}
                />
                <div className="mt-1 rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
                  {supMatches.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-op-muted">
                      {t("noSupplierMatches")}
                    </div>
                  ) : (
                    supMatches.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => pickSupplier(s)}
                        className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0"
                      >
                        {s.name}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </Field>

          {supplier && (
            <>
              {loadErr ? (
                <div className="text-xs text-danger">{t("errLoadFailed")}</div>
              ) : priceList === null || ingredients === null ? (
                <div className="py-4 text-center text-sm text-op-muted">
                  {t("loading")}
                </div>
              ) : (
                <>
                  <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted pt-1">
                    {t("linesTitle")}
                  </div>

                  {/* Líneas agregadas */}
                  {lines.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-4 text-center text-sm text-op-muted">
                      {t("noLinesYet")}
                    </div>
                  ) : (
                    <div className="border border-op-border rounded-2xl overflow-hidden">
                      {lines.map((l) => (
                        <div
                          key={l.key}
                          className="flex items-center gap-2 px-3 py-2 border-b border-op-border last:border-b-0"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">
                              {l.ingredientName}
                            </div>
                            <div className="text-[11px] text-op-muted mt-0.5 truncate">
                              {[
                                l.presentationLabel != null
                                  ? `${l.presentations} × ${l.presentationLabel}`
                                  : null,
                                formatBaseQty(l.qtyBase, l.measureKind, locale),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          <div className="text-sm font-medium tabular-nums shrink-0">
                            {formatMoney(l.expectedCostCents, {
                              currency,
                              locale,
                            })}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setLines((prev) =>
                                prev.filter((x) => x.key !== l.key),
                              )
                            }
                            className="min-h-[44px] px-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 shrink-0"
                          >
                            {t("removeLine")}
                          </button>
                        </div>
                      ))}
                      <div className="flex items-center justify-between px-3 py-2 bg-op-bg/50">
                        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                          {t("orderTotalLabel")}
                        </span>
                        <span className="text-sm font-medium tabular-nums">
                          {formatMoney(total, { currency, locale })}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Formulario de línea nueva */}
                  <div className="rounded-2xl border border-op-border bg-op-bg/50 p-4 space-y-3">
                    {priceList.length === 0 ? (
                      <div className="text-[11px] text-op-muted">
                        {t("noPriceListHint")}
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {(
                          [
                            ["list", t("lineFromList")],
                            ["free", t("lineFree")],
                          ] as [LineMode, string][]
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => {
                              setMode(value);
                              resetLineForm();
                            }}
                            className={
                              "min-h-[44px] px-2 rounded-xl border text-sm font-medium transition-colors " +
                              (effectiveMode === value
                                ? "border-ink bg-ink text-bone"
                                : "border-op-border bg-op-bg hover:bg-op-surface")
                            }
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}

                    {effectiveMode === "list" ? (
                      <>
                        <Field label={t("fieldPriceListItem")} required>
                          {pickedItem ? (
                            <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-surface text-sm flex items-center justify-between gap-2">
                              <span className="truncate">
                                {[
                                  pickedItem.ingredient.name,
                                  pickedItem.presentationLabel,
                                  pickedItem.lastPriceCents != null
                                    ? formatMoney(pickedItem.lastPriceCents, {
                                        currency,
                                        locale,
                                      })
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setPickedItem(null);
                                  setItemQ("");
                                  setCost("");
                                  setCostDirty(false);
                                }}
                                className="text-[11px] font-medium text-op-muted hover:text-ink shrink-0"
                              >
                                {t("changePresentation")}
                              </button>
                            </div>
                          ) : (
                            <div>
                              <input
                                type="search"
                                value={itemQ}
                                onChange={(e) => setItemQ(e.target.value)}
                                placeholder={t("priceListSearchPlaceholder")}
                                className={inputCls}
                              />
                              <div className="mt-1 rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
                                {itemMatches.length === 0 ? (
                                  <div className="px-3 py-2 text-xs text-op-muted">
                                    {t("noPriceListMatches")}
                                  </div>
                                ) : (
                                  itemMatches.map((i) => (
                                    <button
                                      key={i.id}
                                      type="button"
                                      onClick={() => pickItem(i)}
                                      className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0"
                                    >
                                      <span className="truncate">
                                        {[
                                          i.ingredient.name,
                                          i.presentationLabel,
                                          i.lastPriceCents != null
                                            ? formatMoney(i.lastPriceCents, {
                                                currency,
                                                locale,
                                              })
                                            : null,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                          )}
                        </Field>

                        <Field label={t("fieldPresentationsCount")} required>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            value={presentations}
                            onChange={(e) =>
                              changePresentations(e.target.value)
                            }
                            disabled={!pickedItem}
                            className={inputCls + " disabled:opacity-40"}
                          />
                        </Field>
                      </>
                    ) : (
                      <>
                        <Field label={t("fieldIngredient")} required>
                          {pickedIng ? (
                            <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-surface text-sm flex items-center justify-between gap-2">
                              <span className="truncate">
                                {`${pickedIng.name} (${unitSymbols(pickedIng.measureKind)})`}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setPickedIng(null);
                                  setIngQ("");
                                  setQty("");
                                  setUnit("");
                                }}
                                className="text-[11px] font-medium text-op-muted hover:text-ink shrink-0"
                              >
                                {t("changeIngredient")}
                              </button>
                            </div>
                          ) : (
                            <div>
                              <input
                                type="search"
                                value={ingQ}
                                onChange={(e) => setIngQ(e.target.value)}
                                placeholder={t("ingredientSearchPlaceholder")}
                                className={inputCls}
                              />
                              <div className="mt-1 rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
                                {ingMatches.length === 0 ? (
                                  <div className="px-3 py-2 text-xs text-op-muted">
                                    {t("noIngredientMatches")}
                                  </div>
                                ) : (
                                  ingMatches.map((i) => (
                                    <button
                                      key={i.id}
                                      type="button"
                                      onClick={() => {
                                        setPickedIng(i);
                                        setUnit(
                                          BASE_UNIT_SYMBOL[i.measureKind],
                                        );
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
                            </div>
                          )}
                        </Field>

                        <Field label={t("fieldQty")} required>
                          <div className="flex gap-2">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              inputMode="decimal"
                              value={qty}
                              onChange={(e) => setQty(e.target.value)}
                              disabled={!pickedIng}
                              className={inputCls + " flex-1 disabled:opacity-40"}
                            />
                            <select
                              value={unit}
                              onChange={(e) => setUnit(e.target.value)}
                              disabled={
                                !pickedIng ||
                                DISPLAY_UNITS[pickedIng.measureKind].length < 2
                              }
                              className="min-h-[44px] w-24 px-3 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
                            >
                              {(pickedIng
                                ? DISPLAY_UNITS[pickedIng.measureKind]
                                : []
                              ).map((u) => (
                                <option key={u.symbol} value={u.symbol}>
                                  {u.symbol}
                                </option>
                              ))}
                            </select>
                          </div>
                        </Field>
                      </>
                    )}

                    <Field
                      label={`${t("fieldExpectedCost")} (${currency})`}
                      required
                      hint={
                        effectiveMode === "list"
                          ? t("expectedCostHint")
                          : undefined
                      }
                    >
                      <input
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        value={cost}
                        onChange={(e) => {
                          setCost(e.target.value);
                          setCostDirty(true);
                        }}
                        className={inputCls}
                      />
                    </Field>

                    {lineErr && (
                      <div className="text-xs text-danger">{lineErr}</div>
                    )}

                    <button
                      type="button"
                      onClick={addLine}
                      disabled={lineAddDisabled}
                      className="w-full min-h-[44px] rounded-full border border-op-border bg-op-bg text-sm font-medium hover:bg-op-surface disabled:opacity-40"
                    >
                      {t("addLine")}
                    </button>
                  </div>

                  <Field label={t("fieldExpectedAt")}>
                    <input
                      type="date"
                      value={expectedAt}
                      onChange={(e) => setExpectedAt(e.target.value)}
                      className={inputCls}
                    />
                  </Field>

                  <Field label={t("fieldNotes")}>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      maxLength={1000}
                      rows={2}
                      className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
                    />
                  </Field>
                </>
              )}
            </>
          )}

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !supplier || lines.length === 0}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("creating") : t("createOrder")}
            </button>
          </div>
        </div>
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

  const total = (order?.items ?? []).reduce(
    (sum, it) => sum + it.expectedCostCents,
    0,
  );

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
            formatMoney(it.expectedCostCents, { currency, locale }),
          )}</td></tr>`,
      )
      .join("");
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
      `<table><tbody>${rows}</tbody><tfoot><tr>` +
      `<td>${escapeHtml(t("orderTotalLabel"))}</td>` +
      `<td class="num">${escapeHtml(
        formatMoney(total, { currency, locale }),
      )}</td></tr></tfoot></table>` +
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
                    className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={busy}
                    className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
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
                          {formatMoney(it.expectedCostCents, {
                            currency,
                            locale,
                          })}
                        </div>
                        {/* Acumulado de recepciones — solo lectura (la
                            recepción llega en A2.4). */}
                        {it.receivedQtyBase > 0 && (
                          <div className="text-[11px] text-ok mt-0.5 tabular-nums">
                            {`${t("receivedLabel")}: ${formatBaseQty(
                              it.receivedQtyBase,
                              kind,
                              locale,
                            )} · ${formatMoney(it.receivedCostCents, {
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
              <div className="flex items-center justify-between px-3 py-2 bg-op-bg/50">
                <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                  {t("orderTotalLabel")}
                </span>
                <span className="text-sm font-medium tabular-nums">
                  {formatMoney(total, { currency, locale })}
                </span>
              </div>
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
                className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90 disabled:opacity-40 mt-4"
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
                    className="min-h-[44px] px-3 rounded-full border border-op-border bg-op-bg text-sm font-medium hover:bg-op-surface"
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
                      className="min-h-[44px] px-5 rounded-full border border-op-border bg-op-bg text-sm font-medium hover:bg-op-surface disabled:opacity-40"
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
};

// Errores del POST /receive → clave i18n (fallback errSaveFailed).
const API_RECEIVE_ERROR_KEYS: Record<string, string> = {
  wrong_status: "errWrongStatus",
  line_invalid: "errLineInvalid",
  nothing_to_receive: "errNothingToReceive",
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
    return String(
      Math.round((it.expectedCostCents * qtyBase) / it.qtyOrderedBase) / 100,
    );
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
      };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  async function submit() {
    setErr(null);
    const payload: { itemId: string; qtyBase: number; costCents: number }[] =
      [];
    for (const l of lines) {
      if (!l.include) continue;
      const it = itemsById.get(l.itemId);
      if (!it) continue;
      const qtyBase = toBaseQty(
        Number(l.qty.replace(",", ".")),
        it.ingredient.measureKind,
        l.unit,
      );
      const costPesos = Number(l.cost.replace(",", "."));
      const costOk =
        l.cost.trim() !== "" && isFinite(costPesos) && costPesos >= 0;
      if (qtyBase == null || !costOk) {
        setErr(t("errLineInvalid"));
        return;
      }
      payload.push({
        itemId: l.itemId,
        qtyBase,
        costCents: pesosToCents(costPesos),
      });
    }
    if (payload.length === 0) return;
    setBusy(true);
    const r = await fetch(
      `/api/operator/purchase-orders/${order.id}/receive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: payload }),
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
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            value={l.qty}
                            onChange={(e) =>
                              updateLine(l.itemId, { qty: e.target.value })
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
                      <Field label={`${t("fieldRealCost")} (${currency})`} required>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          inputMode="decimal"
                          value={l.cost}
                          onChange={(e) =>
                            updateLine(l.itemId, {
                              cost: e.target.value,
                              costDirty: true,
                            })
                          }
                          className={inputCls}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex items-center justify-end gap-3 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !anyIncluded || pending.length === 0}
            className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
          >
            {busy ? t("receiving") : t("receiveSubmit")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Por pagar (CxP, D5) ─────────────────────── */

/** Total recibido de la OC (suma del acumulado real por línea). */
function receivedTotal(o: OrderSummary): number {
  return o.items.reduce((sum, it) => sum + it.receivedCostCents, 0);
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

  const totalDue = (rows ?? []).reduce((sum, o) => sum + receivedTotal(o), 0);

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
          {t("unpaidEmpty")}
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
              const overdue =
                o.invoiceDueAt != null &&
                new Date(o.invoiceDueAt).getTime() < now;
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
                        {formatMoney(receivedTotal(o), { currency, locale })}
                      </div>
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
                      className="min-h-[36px] px-3 rounded-full border border-op-border bg-op-bg text-[11px] font-medium hover:bg-op-surface"
                    >
                      {t("markPaid")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {nextCursor && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full min-h-[44px] rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg disabled:opacity-40"
            >
              {loadingMore ? t("loading") : t("loadMore")}
            </button>
          )}
        </>
      )}

      {payFor && (
        <MarkPaidSheet
          order={payFor}
          currency={currency}
          onClose={() => setPayFor(null)}
          onPaid={(id) => {
            setPayFor(null);
            setRows((prev) => (prev ?? []).filter((r) => r.id !== id));
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

/** Confirmación de pago con nota opcional (PATCH mark_paid). */
function MarkPaidSheet({
  order,
  currency,
  onClose,
  onPaid,
}: {
  order: OrderSummary;
  currency: string;
  onClose: () => void;
  onPaid: (id: string) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setBusy(true);
    const r = await fetch(`/api/operator/purchase-orders/${order.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "mark_paid",
        paymentNote: note.trim() || null,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "wrong_status" ? t("errWrongStatus") : t("errSaveFailed"),
      );
      return;
    }
    onPaid(order.id);
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
          <h2 className="font-display text-2xl">{t("markPaidTitle")}</h2>
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
            formatMoney(receivedTotal(order), { currency, locale }),
          ].join(" · ")}
        </div>

        <Field label={t("fieldPaymentNote")} hint={t("paymentNoteHint")}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
          />
        </Field>

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex items-center justify-end gap-3 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
          >
            {busy ? t("saving") : t("confirmPaid")}
          </button>
        </div>
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
            className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── UI compartida ──────────────────────── */

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
