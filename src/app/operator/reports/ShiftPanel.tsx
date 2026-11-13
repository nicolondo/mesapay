"use client";

import { displayOrderCode } from "@/lib/orderCode";
import { MoneyInput } from "@/components/MoneyInput";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";
import type { CashSnapshot } from "@/lib/cashBox";
import type { SoldOutItem } from "@/lib/menuSoldOut";
import { ShiftConsumptionTax } from "@/components/ShiftConsumptionTax";
import { TipReturnsBox, fmtSignedCOP, type TipReturnLineView } from "@/components/TipReturns";
import { SoldOutDialog } from "./SoldOutDialog";

const METHOD_KEY: Record<string, string> = {
  // Efectivo: el histórico (demo_cash) y el actual (cash) se rotulan igual.
  demo_cash: "methodCash",
  cash: "methodCash",
  demo_card: "methodDemoCard",
  wompi_card: "methodWompiCard",
  wompi_pse: "methodWompiPse",
  wompi_nequi: "methodWompiNequi",
  kushki_apple_pay: "methodKushkiApplePay",
  kushki_card_terminal: "methodKushkiCardTerminal",
  // Faltaban: el turno abierto mostraba los códigos crudos
  // («kushki_card», «external_terminal»). Mismas claves que la sección del
  // día en reports/page.tsx.
  kushki_card: "methodKushkiCard",
  kushki_pse: "methodKushkiPse",
  kushki_bre_b: "methodKushkiBreB",
  kushki_google_pay: "methodKushkiGooglePay",
  external_terminal: "methodExternalTerminal",
  voucher: "methodVoucher",
  customer_credit: "methodCustomerCredit",
};

/** Estado de una cuenta abierta → clave de opReports (antes salía crudo: «placed»). */
const ORDER_STATUS_KEY: Record<string, string> = {
  placed: "openOrderPlaced",
  in_kitchen: "openOrderInKitchen",
  ready: "openOrderReady",
  served: "openOrderServed",
  paying: "openOrderPaying",
};

type Metrics = {
  payments: number;
  ordersClosed: number;
  grossCents: number;
  tipCents: number;
  /** Propinas devueltas por anulación durante el turno (lib/creditNoteTipReturns). */
  tipReturns?: TipReturnLineView[];
  tipReturnedCents?: number;
  tipNetCents?: number;
  cashCents: number;
  consumptionTaxCents: number;
  taxPendingPayments: number;
  byMethod: { method: string; count: number; sumCents: number }[];
};

type OpenOrder = {
  id: string;
  shortCode: string;
  /** Factura emitida antes de cobrar ("FESM-42"): facturada, sin pagar. */
  invoiceDocumentNumber?: string | null;
  status: string;
  subtotalCents: number;
  totalCents: number;
  tableLabel: string;
};

export type ShiftPanelProps = {
  initial:
    | { open: false }
    | {
        open: true;
        shift: { id: string; openedAt: string; openingCashCents: number };
        metrics: Metrics;
        openOrders: OpenOrder[];
        expectedCashCents: number;
      };
};

export function ShiftPanel({ initial }: ShiftPanelProps) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [openSheet, setOpenSheet] = useState<"open" | "close" | null>(null);

  // Platos agotados del turno: la lista se carga cada vez que hay un turno
  // abierto (también si lo abrió automáticamente un mesero) y alimenta el
  // recordatorio del panel. Cuando el operador acaba de abrir el turno a
  // mano, además se abre el aviso de una (promptSoldOutRef).
  const shiftId = state.open ? state.shift.id : null;
  // La lista va atada al turno que la cargó: si el turno cambia (o se
  // cierra) deja de contar sola, sin limpiar estado en el efecto.
  const [soldOut, setSoldOut] = useState<{
    shiftId: string;
    items: SoldOutItem[];
    dismissed: boolean;
  } | null>(null);
  const [soldOutOpen, setSoldOutOpen] = useState(false);
  const promptSoldOutRef = useRef(false);
  const soldOutCurrent = soldOut && soldOut.shiftId === shiftId ? soldOut : null;
  const soldOutItems = soldOutCurrent?.items ?? [];

  useEffect(() => {
    if (!shiftId) return;
    let alive = true;
    fetchSoldOut().then((items) => {
      if (!alive) return;
      setSoldOut({
        shiftId,
        items,
        dismissed: isSoldOutReminderDismissed(shiftId),
      });
      if (promptSoldOutRef.current) {
        promptSoldOutRef.current = false;
        if (items.length > 0) setSoldOutOpen(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [shiftId]);

  const soldOutDialog = soldOutOpen && (
    <SoldOutDialog
      items={soldOutItems}
      onAvailable={(id) =>
        setSoldOut((prev) =>
          prev && { ...prev, items: prev.items.filter((i) => i.id !== id) },
        )
      }
      onClose={(changed) => {
        setSoldOutOpen(false);
        if (changed > 0) router.refresh();
      }}
    />
  );

  // Light polling so the live numbers stay fresh while the operator looks
  // at the page. Every 30s is plenty for a Z-report panel.
  useEffect(() => {
    if (!state.open) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/operator/shifts/current", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        setState(data.open ? data : { open: false });
      } catch {
        // network blip — ignore, next tick retries
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [state.open]);

  const refresh = async () => {
    const r = await fetch("/api/operator/shifts/current", { cache: "no-store" });
    if (r.ok) {
      const data = await r.json();
      setState(data.open ? data : { open: false });
    }
    router.refresh();
  };

  if (!state.open) {
    return (
      <>
        <ClosedBanner onAbrir={() => setOpenSheet("open")} />
        {openSheet === "open" && (
          <OpenShiftSheet
            onClose={() => setOpenSheet(null)}
            onDone={async () => {
              promptSoldOutRef.current = true;
              await refresh();
            }}
          />
        )}
        {soldOutDialog}
      </>
    );
  }

  return (
    <>
      <OpenPanel
        state={state}
        onCerrar={() => setOpenSheet("close")}
        soldOutCount={soldOutCurrent?.dismissed ? 0 : soldOutItems.length}
        onReviewSoldOut={() => setSoldOutOpen(true)}
        onDismissSoldOut={() => {
          dismissSoldOutReminder(state.shift.id);
          setSoldOut((prev) => prev && { ...prev, dismissed: true });
        }}
      />
      {openSheet === "close" && (
        <CloseShiftSheet
          state={state}
          onClose={() => setOpenSheet(null)}
          onDone={refresh}
        />
      )}
      {soldOutDialog}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Platos agotados: lectura de la lista y descarte del recordatorio.

async function fetchSoldOut(): Promise<SoldOutItem[]> {
  try {
    const r = await fetch("/api/operator/menu-items/sold-out", { cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as { items?: SoldOutItem[] };
    return j.items ?? [];
  } catch {
    // Sin red no hay aviso; el próximo turno lo vuelve a intentar.
    return [];
  }
}

// El descarte del recordatorio es por turno y por dispositivo (localStorage,
// nunca en DB): al turno siguiente vuelve a aparecer si siguen agotados.
const SOLD_OUT_DISMISS_KEY = "mesapay.soldOutReminder";

function isSoldOutReminderDismissed(shiftId: string): boolean {
  try {
    return localStorage.getItem(`${SOLD_OUT_DISMISS_KEY}.${shiftId}`) === "1";
  } catch {
    return false;
  }
}

function dismissSoldOutReminder(shiftId: string) {
  try {
    localStorage.setItem(`${SOLD_OUT_DISMISS_KEY}.${shiftId}`, "1");
  } catch {
    // Modo privado o almacenamiento lleno: el recordatorio sólo se oculta
    // en esta sesión.
  }
}

// ────────────────────────────────────────────────────────────────────────
// Closed (no open shift) — invite the operator to abrir turno.

function ClosedBanner({ onAbrir }: { onAbrir: () => void }) {
  const t = useTranslations("opReports");
  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-5 mb-4 flex flex-wrap items-center gap-4 justify-between">
      <div>
        <div className="font-display text-xl">{t("noShiftTitle")}</div>
        <p className="text-sm text-op-muted mt-1 max-w-md">
          {t("noShiftBody")}
        </p>
      </div>
      <button
        type="button"
        onClick={onAbrir}
        className="mp-btn mp-btn--primary mp-btn--sm"
      >
        {t("openShift")}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Open shift summary panel.

function OpenPanel({
  state,
  onCerrar,
  soldOutCount,
  onReviewSoldOut,
  onDismissSoldOut,
}: {
  state: Extract<ShiftPanelProps["initial"], { open: true }>;
  onCerrar: () => void;
  /** Platos agotados a recordar (0 = sin tarjeta: no hay o ya se descartó). */
  soldOutCount: number;
  onReviewSoldOut: () => void;
  onDismissSoldOut: () => void;
}) {
  const t = useTranslations("opReports");
  const tTips = useTranslations("tipReturns");
  const since = useMemo(
    () => relativeTime(state.shift.openedAt, t),
    [state.shift.openedAt, t],
  );
  const canClose = state.openOrders.length === 0;
  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-5 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("shiftOpen")}
          </div>
          <div className="font-display text-2xl mt-1">{since}</div>
          <div className="text-[12px] text-op-muted mt-0.5">
            {t("openingFund", { amount: fmtCOP(state.shift.openingCashCents) })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCerrar}
            disabled={!canClose}
            className="mp-btn mp-btn--primary mp-btn--sm"
            title={canClose ? "" : t("resolveOpenFirst")}
          >
            {t("closeShift")}
          </button>
        </div>
      </div>

      {/* Recordatorio de platos agotados: cubre el turno abierto sin clic
          (autoOpened por un mesero) y al operador que cerró el aviso con
          «Dejar así». Se descarta por turno. */}
      {soldOutCount > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium text-amber-900">
              {t("soldOutReminderTitle", { count: soldOutCount })}
            </div>
            <div className="text-[12px] text-amber-900/80">
              {t("soldOutReminderBody")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDismissSoldOut}
              className="mp-btn mp-btn--ghost mp-btn--sm"
            >
              {t("soldOutDismiss")}
            </button>
            <button
              type="button"
              onClick={onReviewSoldOut}
              className="mp-btn mp-btn--secondary mp-btn--sm"
            >
              {t("soldOutReview")}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={t("statCharged")} value={fmtCOP(state.metrics.grossCents)} hint={t("statChargedHint", { count: state.metrics.payments })} />
        <Stat
          label={t("statTipsLower")}
          value={fmtSignedCOP(state.metrics.tipNetCents ?? state.metrics.tipCents)}
          hint={
            (state.metrics.tipReturnedCents ?? 0) > 0
              ? tTips("statHint", {
                  collected: fmtCOP(state.metrics.tipCents),
                  returned: fmtCOP(state.metrics.tipReturnedCents ?? 0),
                })
              : undefined
          }
        />
        <Stat label={t("statCashExpected")} value={fmtCOP(state.expectedCashCents)} hint={t("statCashExpectedHint")} />
        <Stat label={t("statClosedBills")} value={String(state.metrics.ordersClosed)} />
      </div>

      <TipReturnsBox lines={state.metrics.tipReturns ?? []} collectedCents={state.metrics.tipCents} className="mt-3" />

      <ShiftConsumptionTax {...state.metrics} className="mt-3" />

      {state.metrics.byMethod.length > 0 && (
        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
          {state.metrics.byMethod.map((b) => (
            // En el celular (2 columnas angostas) el monto va debajo del
            // método: en la misma línea se desbordaba de la tarjeta.
            <div
              key={b.method}
              className="min-w-0 border border-op-border rounded-xl px-3 py-2 flex flex-col gap-0.5 md:flex-row md:items-center md:justify-between"
            >
              <span className="min-w-0 truncate">
                {METHOD_KEY[b.method] ? t(METHOD_KEY[b.method]) : b.method}
                <span className="text-op-muted text-[11px]"> · {b.count}</span>
              </span>
              <span className="font-mono tabular">{fmtCOP(b.sumCents)}</span>
            </div>
          ))}
        </div>
      )}

      {state.openOrders.length > 0 && (
        <div className="mt-5 border border-op-border rounded-xl p-4 bg-op-surface">
          <div className="font-display text-base mb-1">
            {t("openBillsCount", { count: state.openOrders.length })}
          </div>
          <p className="text-[12px] text-op-muted mb-3">
            {t("resolveOpenBills")}
          </p>
          <ul className="divide-y divide-op-border">
            {state.openOrders.map((o) => (
              <li
                key={o.id}
                className="py-2 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{o.tableLabel}</div>
                  <div className="text-[11px] text-op-muted font-mono">
                    {displayOrderCode(o.shortCode)} ·{" "}
                    {ORDER_STATUS_KEY[o.status] ? t(ORDER_STATUS_KEY[o.status]) : o.status}
                  </div>
                  {o.invoiceDocumentNumber && (
                    <div className="text-[11px] text-[#8F6828]">
                      {t("openBillInvoiced", { number: o.invoiceDocumentNumber })}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="font-mono tabular text-sm">{fmtCOP(o.totalCents)}</div>
                  <Link
                    href={`/operator/orders/${o.id}`}
                    className="text-[12px] text-terracotta hover:underline"
                  >
                    {t("goCollect")}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-op-border rounded-xl p-3">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-xl mt-0.5 tabular">{value}</div>
      {hint && <div className="text-[10px] text-op-muted mt-0.5">{hint}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sheets.

function OpenShiftSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const t = useTranslations("opReports");
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/operator/shifts/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openingCashCents: amount }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? t("errCannotOpen"));
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop>
      <SheetTitle title={t("openShift")} subtitle={t("openShiftSheetSubtitle")} />
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("initialCashLabel")}
        </span>
        <CashInput value={amount} onChange={setAmount} autoFocus />
        <span className="block text-[11px] text-op-muted mt-1">
          {t("initialCashHint")}
        </span>
      </label>
      {error && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <SheetActions
        onCancel={onClose}
        onConfirm={submit}
        busy={busy}
        confirmLabel={t("openShift")}
      />
    </Backdrop>
  );
}

function CloseShiftSheet({
  state,
  onClose,
  onDone,
}: {
  state: Extract<ShiftPanelProps["initial"], { open: true }>;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const t = useTranslations("opReports");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Snapshot de caja para mostrar las cajas de meseros abiertos y poder
  // liquidarlas en el mismo cierre. Se trae al abrir el sheet.
  const [snap, setSnap] = useState<CashSnapshot | null>(null);
  const [alsoMeseros, setAlsoMeseros] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/operator/cash/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j) setSnap(j as CashSnapshot);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const meseros = snap?.meseros ?? [];
  const hasOpenMeseros = meseros.length > 0;
  const willCloseMeseros = hasOpenMeseros && alsoMeseros;
  // Si liquidamos a los meseros, su efectivo vuelve al cajón → el
  // esperado es el consolidado; si no, el saldo de la caja general.
  const expected =
    willCloseMeseros && snap
      ? snap.consolidatedCents
      : state.expectedCashCents;

  // `declaredRaw` null = el operador aún no escribió → mostramos el
  // esperado como default (y se actualiza solo si cambia el esperado:
  // carga del snapshot o toggle de liquidar meseros). Apenas escribe,
  // su valor manda.
  const [declaredRaw, setDeclaredRaw] = useState<number | null>(null);
  const declared = declaredRaw ?? expected;
  const diff = declared - expected;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/operator/shifts/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          declaredCashCents: declared,
          notes: notes.trim() || undefined,
          closeMeseroShifts: willCloseMeseros,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error ?? t("errCannotClose"));
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const diffValue =
    diff === 0
      ? t("differenceExact")
      : diff > 0
        ? t("differenceOver", { amount: fmtCOP(Math.abs(diff)) })
        : t("differenceShort", { amount: fmtCOP(Math.abs(diff)) });

  return (
    <Backdrop>
      <SheetTitle title={t("closeShift")} subtitle={t("closeShiftSheetSubtitle")} />

      <ShiftConsumptionTax {...state.metrics} className="mb-4" />

      <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
        <div className="border border-op-border rounded-xl p-3">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("initialFund")}
          </div>
          <div className="font-display text-lg tabular">
            {fmtCOP(state.shift.openingCashCents)}
          </div>
        </div>
        <div className="border border-op-border rounded-xl p-3">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("cashCollected")}
          </div>
          <div className="font-display text-lg tabular">
            {fmtCOP(state.metrics.cashCents)}
          </div>
        </div>
        <div className="border border-op-border rounded-xl p-3 col-span-2 bg-op-surface">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
            {t("cashExpectedInDrawer")}
          </div>
          <div className="font-display text-2xl tabular">
            {fmtCOP(expected)}
          </div>
        </div>
      </div>

      {/* Cierre general: liquidar las cajas de los meseros con turno
          abierto en el mismo cierre. */}
      {hasOpenMeseros && (
        <div className="rounded-xl border border-op-border p-3 mb-4 space-y-2">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={alsoMeseros}
              onChange={(e) => setAlsoMeseros(e.target.checked)}
              className="h-4 w-4 mt-0.5 accent-ink"
            />
            <span>
              <span className="text-sm font-medium">
                {t("closeMeserosToggle")}
              </span>
              <span className="block text-[11px] text-op-muted mt-0.5">
                {t("closeMeserosHint")}
              </span>
            </span>
          </label>
          <ul className="divide-y divide-op-border">
            {meseros.map((m) => (
              <li
                key={m.shiftId}
                className="py-1.5 flex items-center justify-between gap-3 text-sm"
              >
                <span className="truncate">{m.name}</span>
                <span className="font-mono tabular shrink-0">
                  {fmtCOP(m.mustReturnCents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="block mb-3">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("cashCountedPhysically")}
        </span>
        {/* key={expected} remonta el input cuando cambia el esperado
            (carga del snapshot / toggle de meseros) para que el valor
            prellenado siga al esperado. No cambia al tipear (expected
            es estable), así no interrumpe la edición. */}
        <CashInput
          key={expected}
          value={declared}
          onChange={setDeclaredRaw}
          autoFocus
        />
      </label>

      <div
        className={
          "rounded-xl px-3 py-3 mb-3 text-sm font-medium " +
          (diff === 0
            ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
            : diff > 0
              ? "bg-amber-50 border border-amber-200 text-amber-900"
              : "bg-red-50 border border-red-200 text-red-900")
        }
      >
        {t("differenceLabel", { value: diffValue })}
      </div>

      <label className="block mb-1">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("notesLabel")}
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder={diff !== 0 ? t("notesPlaceholder") : ""}
          className="w-full mt-1 rounded-lg border border-op-border bg-op-surface px-3 py-2 text-sm"
        />
      </label>

      {error && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <SheetActions
        onCancel={onClose}
        onConfirm={submit}
        busy={busy}
        confirmLabel={t("confirmClose")}
      />
    </Backdrop>
  );
}

function CashInput({
  value,
  onChange,
  autoFocus,
}: {
  value: number;
  onChange: (cents: number) => void;
  autoFocus?: boolean;
}) {
  // Plain integer pesos field. Cents are uncommon for cash drawer
  // arqueo in CO so we treat the input as whole pesos and multiply by
  // 100. We store the user's keystrokes as digits-only internally,
  // but render them with es-CO thousand separators ("397.337") so a
  // cajero counting $397.337 actually sees the number formatted the
  // way they wrote it on paper.
  const [digits, setDigits] = useState(
    value > 0 ? String(Math.round(value / 100)) : "",
  );
  return (
    <MoneyInput
      autoFocus={autoFocus}
      value={digits}
      onChange={(raw) => {
        // Strip the formatting (dots, commas, spaces) before
        // remembering the raw value.
        const clean = raw.replace(/[^0-9]/g, "");
        setDigits(clean);
        onChange(clean ? Number(clean) * 100 : 0);
      }}
      placeholder="0"
      className="w-full mt-1 rounded-lg border border-op-border bg-op-surface px-3 py-2 text-2xl font-display tabular"
    />
  );
}

function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <div
      // Sin cierre al tocar afuera: un clic perdido borraba el arqueo digitado.
      className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center p-4"
    >
      <div
        className="bg-bone rounded-2xl w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function SheetTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <div className="font-display text-2xl">{title}</div>
      {subtitle && <div className="text-sm text-op-muted">{subtitle}</div>}
    </div>
  );
}

function SheetActions({
  onCancel,
  onConfirm,
  busy,
  confirmLabel,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  confirmLabel: string;
}) {
  const t = useTranslations("opReports");
  return (
    <div className="flex justify-end gap-2 mt-5">
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="mp-btn mp-btn--ghost mp-btn--sm"
      >
        {t("cancel")}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="mp-btn mp-btn--primary mp-btn--sm"
      >
        {busy ? t("busy") : confirmLabel}
      </button>
    </div>
  );
}

function relativeTime(
  iso: string,
  t: ReturnType<typeof useTranslations<"opReports">>,
) {
  const opened = new Date(iso).getTime();
  const ms = Date.now() - opened;
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return t("relativeMin", { mins });
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0
    ? t("relativeHour", { hours })
    : t("relativeHourMin", { hours, rem });
}
