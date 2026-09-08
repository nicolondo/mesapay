"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP, pesosToCents } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import {
  lineTaxOnTopCents,
  salesTaxRates,
  MAX_FREE_LINE_QTY,
  MAX_FREE_LINE_TOTAL_CENTS,
} from "@/lib/salesTax";

type ItemDetail = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  preparationStartedAt: string | null;
  servedAt: string | null;
  expediteRequestedAt: string | null;
  guestName: string | null;
  notes: string | null;
};

/**
 * Línea libre: algo que se cobra en esta cuenta y NO sale del menú — catering
 * de un evento, alquiler del salón, una consultoría. No pertenece a ninguna
 * ronda porque no es un pedido a cocina, y su impuesto (propio, explícito) se
 * SUMA ENCIMA del precio, que es como se cotiza un servicio.
 */
type FreeLine = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  taxKind: string | null;
  taxPct: number | null;
  notes: string | null;
};

type Round = {
  id: string;
  seq: number;
  // OrderStatus enum incluye más valores que estos pero solo
  // filtramos por "cancelled" para esconderlas; el resto fluyen.
  status: string;
  placedAt: string;
  items: ItemDetail[];
};

/**
 * Detalle de mesa visto por el mesero — sheet bottom-up con cada plato,
 * su estado actual ("Por preparar / Preparando / Listo / Servido") y el
 * tiempo en cocina si aplica. Botón "🔥 Apurar" por item en preparación
 * pinta un badge en el kitchen board.
 *
 * Se monta en cada tarjeta de mesa de /operator/tables (que el mesero
 * ve via re-export /mesero/mesas). La data se fetcheaba ya en el server
 * page pero estaba comprimida en counts; acá pedimos a un endpoint
 * lightweight que devuelve los items expandidos cuando el sheet abre.
 */
type FreeTable = {
  id: string;
  number: number;
  label: string | null;
};

// Todas las otras mesas (libres y ocupadas) — destino posible para
// mover UN plato. A diferencia del move de pedido entero, el plato SÍ
// puede unirse a una mesa ocupada (se suma a su cuenta abierta).
type AllTable = {
  id: string;
  number: number;
  label: string | null;
  occupied: boolean;
};

export function TableDetailSheet({
  orderId,
  shortCode,
  tableLabel,
  tableNumber,
  tableId,
  initialRounds,
  freeTables,
  allTables,
  open: externalOpen,
  onOpenChange,
  hideTrigger,
  orderStatus,
  outstandingCents,
  subtotalCents,
  grossSubtotalCents,
  discountCents = 0,
  discountPct = null,
  customer = null,
  tenantSlug,
  qrToken,
  isMeseroView,
  country,
  chargeLocked,
}: {
  orderId: string;
  shortCode: string;
  tableLabel: string;
  tableNumber: number;
  // Mesa donde vive la orden — sirve para el botón "Agregar platos"
  // en modo mesero (ruta interna /mesero/pedir/[id]).
  tableId: string;
  initialRounds: Round[];
  // Mesas libres del restaurante (sin orden abierta) para el sheet
  // de "Mover a otra mesa". Server pre-llena. Si no hay ninguna
  // (todas ocupadas) se esconde el botón.
  freeTables: FreeTable[];
  // TODAS las otras mesas del restaurante (libres y ocupadas), sin la
  // mesa actual. Necesarias para "Mover un plato" — el plato puede
  // unirse a una mesa ocupada. Si está vacío se esconde el botón.
  allTables: AllTable[];
  // Modo controlled: si el padre pasa `open` + `onOpenChange`, el
  // sheet sigue el estado externo. Útil para que la grilla compacta
  // de Mesas dispare el sheet al tap del tile. Si no se pasan,
  // funciona como antes (renderea su propio botón trigger).
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  // Opcional: cuando el padre maneja el trigger por afuera (ej:
  // tap en el tile), pasamos `hideTrigger` para esconder el link
  // interno "Ver detalle del pedido →".
  hideTrigger?: boolean;
  // Estado de la orden + monto pendiente. Necesarios para mostrar
  // el botón "Cobrar la cuenta" (sólo si outstanding > 0) y para el
  // botón "Cancelar" (sólo si placed/in_kitchen). Cuando no se
  // pasan (back-compat con triggers viejos), el sheet no muestra
  // estas acciones.
  orderStatus?: string;
  outstandingCents?: number;
  /** Cobrable: el subtotal ya con el descuento del comensal restado. */
  subtotalCents?: number;
  /** Subtotal antes del descuento — solo para el desglose. */
  grossSubtotalCents?: number;
  discountCents?: number;
  discountPct?: number | null;
  // Comensal identificado en la cuenta. Al identificarlo se aplica su
  // descuento (si el restaurante le pactó uno); el mesero puede quitar el
  // descuento sin perder la identidad.
  customer?: {
    id: string;
    name: string | null;
    email: string;
    cedula: string | null;
  } | null;
  // Para el botón "Cobrar la cuenta" + el link de agregar platos
  // en modo operator/admin (abre tab nueva del menú público).
  tenantSlug?: string;
  qrToken?: string;
  isMeseroView?: boolean;
  // País del comercio (ISO-2) — decide las tarifas de impuesto que se ofrecen
  // al agregar una línea libre. null cae en las de Colombia, igual que el
  // resto de la app (`purchaseTaxRates`).
  country?: string | null;
  // "Solo el administrador cobra" activo y quien mira es un mesero.
  // Cambiamos "Cobrar la cuenta" por "Pedir la cuenta": el mesero avisa
  // a caja en vez de chocar contra un 403 del servidor.
  chargeLocked?: boolean;
}) {
  const tr = useTranslations("opTables");
  const [internalOpen, setInternalOpen] = useState(false);
  const [identifyQuery, setIdentifyQuery] = useState("");
  const [identifyBusy, setIdentifyBusy] = useState(false);
  const [identifyErr, setIdentifyErr] = useState<string | null>(null);
  const controlled = externalOpen !== undefined;
  const open = controlled ? externalOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };

  // Back-button integration: cuando abrimos el sheet pusheamos una
  // entry al history del browser. Si el usuario aprieta back (o
  // swipe-back en iOS / hardware back en Android), popstate dispara
  // y cerramos el sheet en vez de navegar fuera de la página.
  //
  // Si el sheet se cierra por otro medio (✕, tap backdrop, cancelar
  // orden), el effect cleanup llama history.back() para retirar la
  // entry que pusheamos — así el back-button del usuario no queda
  // "consumiendo" un step de más cuando navega después.
  //
  // El `closingFromPopRef` evita el loop: cuando el cierre vino DEL
  // back-button, no hay que llamar back() de nuevo.
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const closingFromPopRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;
    const marker = `mp-sheet-${orderId}-${Date.now()}`;
    window.history.pushState({ mesapaySheet: marker }, "");
    closingFromPopRef.current = false;
    const onPop = () => {
      closingFromPopRef.current = true;
      setOpenRef.current(false);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Si cerramos por otro medio (no back-button), retiramos la
      // entry del history. Sólo si todavía está en el top del stack
      // — defensa contra navegaciones cruzadas.
      if (
        !closingFromPopRef.current &&
        (window.history.state as { mesapaySheet?: string } | null)
          ?.mesapaySheet === marker
      ) {
        window.history.back();
      }
    };
  }, [open, orderId]);

  const [rounds, setRounds] = useState<Round[]>(initialRounds);
  // Las líneas libres no viajan en los tiles del server (no son platos): las
  // trae el mismo poll del detalle, que corre apenas abre el sheet.
  const [freeLines, setFreeLines] = useState<FreeLine[]>([]);
  const [showFreeLineSheet, setShowFreeLineSheet] = useState(false);
  const [pendingExpedite, setPendingExpedite] = useState<Set<string>>(
    new Set(),
  );
  // Item id pending cancel/comp — abre el sub-sheet de motivo.
  // `kind` decide el copy (Cancelar vs No cobrar) y los presets de
  // motivo. Se infiere del estado del item (servedAt o no) cuando se
  // abre el sheet.
  const [cancelTarget, setCancelTarget] = useState<{
    itemId: string;
    name: string;
    kind: "cancel" | "comp";
  } | null>(null);
  const [showMoveSheet, setShowMoveSheet] = useState(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  // Mover UN plato — target abre el picker de mesas para ese ítem;
  // moveItemErr surface el error del endpoint dentro del picker.
  const [moveItemTarget, setMoveItemTarget] = useState<{
    itemId: string;
    name: string;
  } | null>(null);
  const [moveItemErr, setMoveItemErr] = useState<string | null>(null);
  // Cancelar la orden completa — sólo aplica cuando la cocina no
  // ha plateado nada (status placed/in_kitchen). Una vez cancelada
  // cerramos el sheet y refrescamos.
  const [cancelOrderBusy, setCancelOrderBusy] = useState(false);
  // "Pedir la cuenta" (sólo con el cobro bloqueado para el mesero):
  // busy mientras vuela el POST, asked cuando ya avisamos a caja.
  const [billBusy, setBillBusy] = useState(false);
  const [billAsked, setBillAsked] = useState(false);
  const router = useRouter();
  const [, startTx] = useTransition();

  /**
   * El mesero avisa a caja que la mesa quiere pagar. Dispara el aviso de
   * pantalla completa del administrador (evento order.bill_requested).
   */
  async function requestBill() {
    if (!tenantSlug || billBusy) return;
    setBillBusy(true);
    const res = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/request-bill`,
      { method: "POST" },
    );
    setBillBusy(false);
    if (res.ok) setBillAsked(true);
  }

  async function cancelOrder() {
    if (!window.confirm(tr("confirmCancelOrder"))) {
      return;
    }
    setCancelOrderBusy(true);
    const res = await fetch(`/api/operator/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    setCancelOrderBusy(false);
    if (!res.ok) {
      // El backend rechaza si cocina ya empezó — surface el motivo
      // específico en vez de un alert genérico.
      const body = await res.json().catch(() => null);
      const msg =
        body?.message ??
        (body?.error === "kitchen_started"
          ? tr("cancelOrderKitchenStarted")
          : tr("cancelOrderFailed"));
      window.alert(msg);
      return;
    }
    setOpen(false);
    startTx(() => router.refresh());
  }

  // Refresca el detalle cada 15s mientras está abierto — los estados
  // de cocina cambian y queremos que el mesero vea ETA actualizada
  // sin tener que cerrar/reabrir.
  useEffect(() => {
    if (!open) return;
    const tick = async () => {
      try {
        const r = await fetch(`/api/operator/orders/${orderId}/detail`);
        if (!r.ok) return;
        const j = (await r.json()) as {
          rounds: Round[];
          freeLines?: FreeLine[];
        };
        setRounds(j.rounds);
        setFreeLines(j.freeLines ?? []);
      } catch {}
    };
    void tick();
    const h = setInterval(tick, 15_000);
    return () => clearInterval(h);
  }, [open, orderId]);

  async function moveOrderToTable(targetTableId: string) {
    setMoveErr(null);
    const r = await fetch(`/api/operator/orders/${orderId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetTableId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMoveErr(j.message ?? j.error ?? tr("moveFailed"));
      return;
    }
    // Cerramos todo y forzamos el refresh de la grid: el SSE solo no
    // alcanza (la mesa ORIGEN queda libre y no siempre revalida), así que
    // pedimos el re-render del server como en los demás handlers.
    setShowMoveSheet(false);
    setOpen(false);
    startTx(() => router.refresh());
  }

  // Mapa de códigos de error del endpoint de mover-plato a copy i18n. El
  // endpoint devuelve SOLO códigos (nunca texto): la copy vive acá para que
  // el mesero la lea en su idioma.
  function moveItemErrorMessage(code: string | undefined): string {
    switch (code) {
      case "item_cancelled":
        return tr("moveItemCancelled");
      case "order_closed":
        return tr("moveItemOrderClosed");
      case "order_paying":
        return tr("moveItemOrderPaying");
      case "target_order_closed":
        return tr("moveItemTargetClosed");
      case "target_order_paying":
        return tr("moveItemTargetPaying");
      case "same_table":
        return tr("moveItemSameTable");
      case "target_out_of_scope":
        return tr("moveItemOutOfScope");
      default:
        return tr("moveItemFailed");
    }
  }

  async function moveItemToTable(itemId: string, targetTableId: string) {
    setMoveItemErr(null);
    const r = await fetch(`/api/operator/order-items/${itemId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetTableId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMoveItemErr(moveItemErrorMessage(j.error));
      return;
    }
    // El plato se fue a otra mesa; cerramos picker + sheet y forzamos
    // el re-render del server (misma razón que moveOrderToTable: la
    // grid de ambas mesas debe reflejar el cambio).
    setMoveItemTarget(null);
    setOpen(false);
    startTx(() => router.refresh());
  }

  async function cancelItem(
    itemId: string,
    reason: string,
    kind: "cancel" | "comp",
  ) {
    const r = await fetch(`/api/operator/order-items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cancel: { reason, kind } }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      const msg =
        body?.message ??
        (kind === "comp"
          ? tr("compItemFailed")
          : tr("cancelItemFailed"));
      alert(msg);
      return;
    }
    // Quitar el item localmente para feedback inmediato. El poll
    // siguiente trae la verdad del server (subtotal recalculado).
    setRounds((prev) =>
      prev
        .map((rd) => ({
          ...rd,
          items: rd.items.filter((it) => it.id !== itemId),
        }))
        .filter((rd) => rd.items.length > 0),
    );
    // El id puede ser el de una línea libre — vive fuera de las rondas.
    setFreeLines((prev) => prev.filter((l) => l.id !== itemId));
    setCancelTarget(null);
    // El total de la cuenta cambió: la grilla de mesas lo muestra en el tile.
    startTx(() => router.refresh());
  }

  /**
   * Agrega una línea libre a la cuenta. El backend recalcula subtotal,
   * impuesto y total con la función canónica; acá sólo refrescamos.
   */
  async function addFreeLine(input: {
    name: string;
    qty: number;
    unitPriceCents: number;
    taxKind: "none" | "inc" | "iva";
    taxPct: number;
  }): Promise<string | null> {
    const r = await fetch(`/api/operator/order-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId, ...input }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return freeLineErrorMessage(j.error);
    }
    setShowFreeLineSheet(false);
    // Traer la línea recién creada + el total nuevo del server.
    try {
      const d = await fetch(`/api/operator/orders/${orderId}/detail`);
      if (d.ok) {
        const j = (await d.json()) as { freeLines?: FreeLine[] };
        setFreeLines(j.freeLines ?? []);
      }
    } catch {}
    startTx(() => router.refresh());
    return null;
  }

  /** Códigos del endpoint de líneas libres → copy traducido. */
  function freeLineErrorMessage(code: unknown): string {
    switch (code) {
      case "order_paying":
        return tr("freeLineErrorPaying");
      case "order_closed":
        return tr("freeLineErrorClosed");
      case "invalid_tax_rate":
        return tr("freeLineErrorTaxRate");
      case "line_too_large":
        return tr("freeLineErrorTooLarge");
      case "order_too_large":
        return tr("freeLineErrorOrderTooLarge");
      default:
        return tr("freeLineErrorGeneric");
    }
  }

  async function expedite(itemId: string) {
    setPendingExpedite((s) => new Set(s).add(itemId));
    try {
      const r = await fetch(`/api/operator/order-items/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expedite: true }),
      });
      if (r.ok) {
        // Optimistically marcar el item como expedited localmente.
        const stamp = new Date().toISOString();
        setRounds((prev) =>
          prev.map((rd) => ({
            ...rd,
            items: rd.items.map((it) =>
              it.id === itemId ? { ...it, expediteRequestedAt: stamp } : it,
            ),
          })),
        );
      }
    } finally {
      setPendingExpedite((s) => {
        const next = new Set(s);
        next.delete(itemId);
        return next;
      });
    }
  }

  /**
   * Identificar al comensal en la cuenta por cédula o correo. Si tiene un
   * descuento vigente EN ESTE restaurante, el servidor lo aplica.
   */
  async function identifyCustomer(e: React.FormEvent) {
    e.preventDefault();
    setIdentifyBusy(true);
    setIdentifyErr(null);
    try {
      const res = await fetch(`/api/operator/orders/${orderId}/identify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: identifyQuery.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setIdentifyErr(
          j.error === "not_found"
            ? tr("customerNotFound")
            : tr("customerIdentifyError"),
        );
        return;
      }
      setIdentifyQuery("");
      router.refresh();
    } catch {
      setIdentifyErr(tr("customerIdentifyError"));
    } finally {
      setIdentifyBusy(false);
    }
  }

  /** Quitar el descuento de ESTA cuenta, sin perder quién es el comensal. */
  async function dropDiscount() {
    setIdentifyBusy(true);
    setIdentifyErr(null);
    try {
      const res = await fetch(`/api/operator/orders/${orderId}/discount`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setIdentifyErr(tr("customerIdentifyError"));
        return;
      }
      router.refresh();
    } catch {
      setIdentifyErr(tr("customerIdentifyError"));
    } finally {
      setIdentifyBusy(false);
    }
  }

  // Aplanamos rondas pero conservamos el seq como header — útil para
  // mostrar "Ronda 2" cuando el cliente pidió segunda vuelta.
  const visibleRounds = rounds.filter((r) => r.status !== "cancelled");

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 w-full text-xs text-op-muted hover:text-op-text underline-offset-2 hover:underline text-left"
        >
          {tr("viewOrderDetail")}
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full md:max-w-lg bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
                  {tableLabel}
                  {" · "}
                  {shortCode}
                </div>
                <h2 className="font-display text-2xl mt-1">
                  {tr("orderStatusTitle")}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted text-sm shrink-0"
                aria-label={tr("close")}
              >
                {"✕"}
              </button>
            </div>

            {/* Resumen del cobro + acciones principales. "Agregar
                platos" siempre visible (acción frecuente); "Cobrar
                la cuenta" sólo si queda algo por cobrar; "Cancelar"
                sólo si la cocina no ha plateado. */}
            {(subtotalCents != null || outstandingCents != null) && (
              <div className="rounded-xl border border-hairline bg-op-bg p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                    {outstandingCents && outstandingCents > 0
                      ? tr("summaryPending")
                      : tr("summaryTotal")}
                  </div>
                  <div className="font-display text-2xl tabular leading-tight">
                    {fmtCOP(
                      outstandingCents != null
                        ? outstandingCents
                        : subtotalCents ?? 0,
                    )}
                  </div>
                  {outstandingCents != null &&
                    outstandingCents > 0 &&
                    subtotalCents != null &&
                    subtotalCents !== outstandingCents && (
                      <div className="font-mono text-[10px] text-op-muted mt-0.5">
                        {tr("summaryOfTotal", { amount: fmtCOP(subtotalCents) })}
                      </div>
                    )}
                  {discountCents > 0 && (
                    <div className="font-mono text-[10px] text-terracotta mt-0.5">
                      {discountPct
                        ? tr("discountApplied", { pct: discountPct })
                        : tr("discountAppliedNoPct")}{" "}
                      {"− " + fmtCOP(discountCents)}
                      {grossSubtotalCents != null && (
                        <>
                          {" · "}
                          {tr("discountBefore", {
                            amount: fmtCOP(grossSubtotalCents),
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Comensal identificado + su descuento. Identificarlo es lo
                que aplica el beneficio; quitar el descuento NO borra la
                identidad (el consumo del cliente se sigue registrando). */}
            {orderStatus !== "paid" && orderStatus !== "cancelled" && (
              <div className="rounded-xl border border-hairline bg-op-bg p-3">
                <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
                  {tr("customerTitle")}
                </div>

                {customer ? (
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {customer.name ?? customer.email}
                      </div>
                      <div className="font-mono text-[10px] text-op-muted truncate">
                        {customer.cedula ?? customer.email}
                      </div>
                    </div>
                    {discountCents > 0 && (
                      <button
                        type="button"
                        onClick={dropDiscount}
                        disabled={identifyBusy}
                        className="h-9 px-3 rounded-full border border-danger/40 text-xs text-danger disabled:opacity-60"
                      >
                        {tr("discountRemove")}
                      </button>
                    )}
                  </div>
                ) : (
                  <form onSubmit={identifyCustomer} className="flex gap-2 flex-wrap">
                    <input
                      type="text"
                      value={identifyQuery}
                      onChange={(e) => setIdentifyQuery(e.target.value)}
                      placeholder={tr("customerPlaceholder")}
                      className="flex-1 min-w-[160px] h-9 px-3 rounded-lg border border-op-border bg-op-surface text-sm focus:outline-none focus:border-terracotta"
                    />
                    <button
                      type="submit"
                      disabled={identifyBusy || identifyQuery.trim().length === 0}
                      className="h-9 px-3 rounded-full bg-ink text-bone text-xs font-medium disabled:opacity-60"
                    >
                      {identifyBusy ? tr("customerIdentifying") : tr("customerIdentify")}
                    </button>
                  </form>
                )}

                {identifyErr && (
                  <div className="text-danger text-xs mt-2">{identifyErr}</div>
                )}
              </div>
            )}

            {/* Acciones: todas full-width, h-11, rounded-full. Ritmo
                visual uniforme. Ink para la primaria (Agregar),
                terracotta para Cobrar (acción de plata, distinta
                de la primaria), outline para Mover, outline-danger
                para Cancelar. Sólo se muestran cuando hace sentido:
                  - Agregar: siempre que podamos armar la URL
                  - Cobrar: outstanding > 0 + orden no paga/cancelada
                  - Mover: hay mesas libres a donde mover
                  - Cancelar: cocina todavía no plateó (placed/in_kitchen) */}
            {(() => {
              const canCharge =
                outstandingCents != null &&
                outstandingCents > 0 &&
                orderStatus !== "paid" &&
                orderStatus !== "cancelled" &&
                !!tenantSlug;
              // Cancelar cuenta entera SOLO si NINGÚN ítem ha
              // pasado de "placed". Si cocina ya empezó algún
              // plato hay desperdicio sin tracking — el mesero
              // debe cancelar/no cobrar plato por plato con motivo.
              // El backend también enforce'a esto.
              const allItemsStillPlaced = rounds
                .filter((r) => r.status !== "cancelled")
                .flatMap((r) => r.items)
                .every((i) => i.kitchenStatus === "placed");
              const hasAnyLiveItem = rounds
                .filter((r) => r.status !== "cancelled")
                .some((r) => r.items.length > 0);
              const canCancelOrder =
                hasAnyLiveItem &&
                allItemsStillPlaced &&
                orderStatus !== "paid" &&
                orderStatus !== "cancelled";
              const canAdd =
                isMeseroView || (tenantSlug && qrToken);
              const canMove = freeTables.length > 0;
              // Línea libre: mientras la cuenta siga abierta. En cobro no —
              // el comensal ya está viendo un total que dejaría de ser cierto
              // (el backend también lo rechaza).
              const canAddFreeLine =
                orderStatus !== "paid" &&
                orderStatus !== "cancelled" &&
                orderStatus !== "paying";
              if (
                !canAdd &&
                !canCharge &&
                !canMove &&
                !canCancelOrder &&
                !canAddFreeLine
              )
                return null;
              return (
                <div className="space-y-2">
                  {canAdd && (
                    <Link
                      href={
                        isMeseroView
                          ? `/mesero/pedir/${tableId}`
                          : `/t/${tenantSlug}/menu?table=${qrToken}&op=1`
                      }
                      {...(isMeseroView
                        ? {}
                        : { target: "_blank", rel: "noreferrer" })}
                      className="w-full h-11 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center justify-center gap-1.5 hover:bg-ink/90"
                    >
                      <span aria-hidden className="text-base leading-none">
                        {"+"}
                      </span>
                      <span>{tr("addDishes")}</span>
                    </Link>
                  )}
                  {canAddFreeLine && (
                    <button
                      type="button"
                      onClick={() => setShowFreeLineSheet(true)}
                      className="mp-btn mp-btn--secondary mp-btn--block"
                    >
                      {tr("addFreeLine")}
                    </button>
                  )}
                  {/* Con "solo el administrador cobra", el mesero NO ve
                      Cobrar: ve "Pedir la cuenta", que avisa a caja. El
                      servidor bloquea igual el cobro (chargeGuard.ts) —
                      esto es para que no lo intente y choque contra un
                      403. */}
                  {canCharge && chargeLocked && (
                    <button
                      type="button"
                      onClick={requestBill}
                      disabled={billBusy || billAsked}
                      className="w-full h-11 rounded-full bg-terracotta text-bone text-sm font-medium inline-flex items-center justify-center hover:brightness-95 disabled:opacity-70"
                    >
                      {billAsked
                        ? tr("billRequested")
                        : billBusy
                          ? tr("billRequesting")
                          : tr("requestBill")}
                    </button>
                  )}
                  {canCharge &&
                    !chargeLocked &&
                    (isMeseroView ? (
                      // En la PWA del mesero navegamos in-app (scope
                      // /mesero/) — un <a target="_blank"> hacia /t/* no
                      // hace nada en standalone iOS. Mismo patrón que
                      // "Agregar platos" → /mesero/pedir/[tableId].
                      <Link
                        href={`/mesero/cobrar/${orderId}`}
                        className="w-full h-11 rounded-full bg-terracotta text-bone text-sm font-medium inline-flex items-center justify-center hover:brightness-95"
                      >
                        {tr("chargeBill")}
                      </Link>
                    ) : (
                      <a
                        href={`/t/${tenantSlug}/pay/${orderId}?op=1`}
                        target="_blank"
                        rel="noreferrer"
                        className="w-full h-11 rounded-full bg-terracotta text-bone text-sm font-medium inline-flex items-center justify-center hover:brightness-95"
                      >
                        {tr("chargeBill")}
                      </a>
                    ))}
                  {canMove && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoveErr(null);
                        setShowMoveSheet(true);
                      }}
                      className="mp-btn mp-btn--secondary mp-btn--block"
                    >
                      {tr("moveToTable")}
                    </button>
                  )}
                  {canCancelOrder && (
                    <button
                      type="button"
                      onClick={cancelOrder}
                      disabled={cancelOrderBusy}
                      className="mp-btn mp-btn--danger mp-btn--block"
                    >
                      {cancelOrderBusy
                        ? tr("cancelBillBusy")
                        : tr("cancelBill")}
                    </button>
                  )}
                </div>
              );
            })()}

            {visibleRounds.length === 0 && freeLines.length === 0 && (
              <div className="text-sm text-op-muted">
                {tr("noActiveDishes")}
              </div>
            )}

            {visibleRounds.map((round) => (
              <section key={round.id} className="space-y-2">
                {visibleRounds.length > 1 && (
                  <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
                    {tr("round", { seq: round.seq })}
                  </div>
                )}
                <ul className="space-y-2">
                  {round.items.map((it) => {
                    const elapsed = it.preparationStartedAt
                      ? minutesSince(it.preparationStartedAt)
                      : null;
                    const readyElapsed = it.servedAt
                      ? null
                      : it.kitchenStatus === "ready" && it.preparationStartedAt
                        ? minutesSince(it.preparationStartedAt)
                        : null;
                    const canExpedite =
                      !it.servedAt &&
                      it.kitchenStatus !== "ready" &&
                      !it.expediteRequestedAt;
                    return (
                      <li
                        key={it.id}
                        className="rounded-xl border border-hairline bg-op-surface p-3"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono tabular text-muted shrink-0">
                            {it.qty}
                            {"×"}
                          </span>
                          <span className="flex-1 text-sm font-medium">
                            {it.name}
                          </span>
                          {/* Lo que aporta la línea a la cuenta. Sin esto el
                              sheet mostraba el pendiente total y ningún
                              precio por plato, así que revisar una cuenta
                              contra la mesa obligaba a abrir la carta. Las
                              líneas libres de más abajo ya lo mostraban. */}
                          <span className="font-mono tabular text-sm shrink-0">
                            {fmtCOP(it.priceCents * it.qty)}
                          </span>
                          <StatusPill
                            status={
                              it.servedAt
                                ? "served"
                                : (it.kitchenStatus as
                                    | "placed"
                                    | "in_kitchen"
                                    | "ready")
                            }
                          />
                        </div>
                        {/* El unitario sólo cuando difiere del total de la
                            línea: con qty 1 el número de arriba YA es el
                            unitario y repetirlo es ruido. */}
                        {it.qty > 1 && (
                          <div className="mt-0.5 font-mono tabular text-[11px] text-op-muted">
                            {tr("unitEach", { amount: fmtCOP(it.priceCents) })}
                          </div>
                        )}
                        {(it.notes || it.guestName) && (
                          <div className="mt-1 text-xs text-op-muted flex gap-2 flex-wrap">
                            {it.guestName && (
                              <span className="font-mono tracking-wider uppercase text-[10px]">
                                {it.guestName}
                              </span>
                            )}
                            {it.notes && (
                              <span>
                                {"“"}
                                {it.notes}
                                {"”"}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          {/* El estado vive solo en el pill de la
                              derecha (StatusPill arriba). Acá solo
                              mostramos el elapsed time cuando aporta
                              info — duplicar "Preparando" / "Por
                              preparar" gastaba espacio sin valor. */}
                          <div className="text-[11px] text-op-muted">
                            {!it.servedAt &&
                              it.kitchenStatus === "in_kitchen" &&
                              elapsed != null &&
                              elapsed > 0 && (
                                <span>{tr("elapsedAgo", { mins: elapsed })}</span>
                              )}
                            {!it.servedAt &&
                              it.kitchenStatus === "ready" &&
                              readyElapsed != null &&
                              readyElapsed > 0 && (
                                <span>
                                  {tr("readyAgo", { mins: readyElapsed })}
                                </span>
                              )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {/* Mover — reasigna ESTE plato a otra
                                mesa. Dos casos reales: el mesero lo
                                cargó en la mesa equivocada, o el
                                comensal se cambió de mesa a mitad de
                                la comida. El segundo caso ocurre con
                                el plato YA ENTREGADO, así que el botón
                                también se muestra para los servidos —
                                el plato conserva su estado y no vuelve
                                a entrar a cocina. El plato puede
                                unirse a una mesa ocupada. */}
                            {allTables.length > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setMoveItemErr(null);
                                  setMoveItemTarget({
                                    itemId: it.id,
                                    name: it.name,
                                  });
                                }}
                                className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text hover:bg-op-bg px-2 py-1 rounded-full"
                              >
                                {tr("moveItem")}
                              </button>
                            )}
                            {/* Cancelar — solo si el item está en
                                "placed" (todavía no entró a cocina).
                                Una vez que cocina lo empieza, la
                                cancelación tiene que pasar por la
                                cocina (rinde cuenta de insumos /
                                tiempo) — no desde la app del mesero.
                                Ready / servido tampoco se cancelan
                                desde acá. */}
                            {/* Cancelar vs No cobrar — el botón
                                depende del estado del plato:
                                  - !servedAt → "Cancelar" (kind=cancel).
                                    El cliente nunca lo recibió.
                                  - servedAt → "No cobrar" (kind=comp).
                                    El cliente lo recibió (queja, frío,
                                    cortesía, walkout).
                                Ambos sacan del subtotal pero el reporte
                                admin filtra por kind para distinguir
                                desperdicio vs queja. */}
                            {!it.servedAt ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setCancelTarget({
                                    itemId: it.id,
                                    name: it.name,
                                    kind: "cancel",
                                  })
                                }
                                className="font-mono text-[10px] tracking-wider uppercase text-danger hover:bg-danger/10 px-2 py-1 rounded-full"
                              >
                                {tr("cancelItem")}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  setCancelTarget({
                                    itemId: it.id,
                                    name: it.name,
                                    kind: "comp",
                                  })
                                }
                                className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:bg-terracotta/10 px-2 py-1 rounded-full"
                              >
                                {tr("compItem")}
                              </button>
                            )}
                            {it.expediteRequestedAt ? (
                              <span className="font-mono text-[10px] tracking-wider uppercase text-terracotta bg-terracotta/15 px-2 py-0.5 rounded-full">
                                {tr("expedited")}
                              </span>
                            ) : canExpedite ? (
                              <button
                                type="button"
                                onClick={() => expedite(it.id)}
                                disabled={pendingExpedite.has(it.id)}
                                className="font-mono text-[10px] tracking-wider uppercase border border-terracotta/40 text-terracotta hover:bg-terracotta/10 px-2 py-1 rounded-full disabled:opacity-40"
                              >
                                {pendingExpedite.has(it.id)
                                  ? tr("expediting")
                                  : tr("expedite")}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            {/* Líneas libres: van aparte de las rondas porque no son platos
                — nadie las prepara ni las entrega. Se muestra el impuesto de
                cada una porque se SUMA al precio, y sin verlo el total de la
                cuenta no cuadra con lo que el mesero digitó. */}
            {freeLines.length > 0 && (
              <section className="space-y-2">
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
                  {tr("freeLinesTitle")}
                </div>
                <ul className="space-y-2">
                  {freeLines.map((l) => {
                    const lineCents = l.priceCents * l.qty;
                    // Misma función que usa el backend para cobrar: si el
                    // sheet hiciera su propia cuenta, tarde o temprano
                    // mostraría un número distinto al que se factura.
                    const taxCents = lineTaxOnTopCents({
                      amountCents: lineCents,
                      taxKind: l.taxKind,
                      taxPct: l.taxPct,
                    });
                    return (
                      <li
                        key={l.id}
                        className="rounded-xl border border-hairline bg-op-surface p-3"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono tabular text-muted shrink-0">
                            {l.qty}
                            {"×"}
                          </span>
                          <span className="flex-1 text-sm font-medium">
                            {l.name}
                          </span>
                          <span className="font-mono tabular text-sm shrink-0">
                            {fmtCOP(lineCents)}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                            {taxCents > 0
                              ? tr("freeLineTaxSummary", {
                                  kind:
                                    l.taxKind === "inc"
                                      ? tr("taxKindInc")
                                      : tr("taxKindIva"),
                                  pct: l.taxPct ?? 0,
                                  amount: fmtCOP(taxCents),
                                })
                              : tr("freeLineNoTax")}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setCancelTarget({
                                itemId: l.id,
                                name: l.name,
                                // Una línea libre nunca "se sirvió": quitarla
                                // es cancelarla, no una cortesía de cocina.
                                kind: "cancel",
                              })
                            }
                            className="font-mono text-[10px] tracking-wider uppercase text-danger hover:bg-danger/10 px-2 py-1 rounded-full shrink-0"
                          >
                            {tr("cancelItem")}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <p className="text-[10px] text-op-muted">
              {tr("autoRefreshNote")}
            </p>
          </div>
        </div>
      )}

      {cancelTarget && (
        <CancelItemSheet
          itemName={cancelTarget.name}
          kind={cancelTarget.kind}
          onClose={() => setCancelTarget(null)}
          onConfirm={(reason) =>
            cancelItem(cancelTarget.itemId, reason, cancelTarget.kind)
          }
        />
      )}

      {showMoveSheet && (
        <MoveTableSheet
          sourceTableNumber={tableNumber}
          freeTables={freeTables}
          err={moveErr}
          onClose={() => setShowMoveSheet(false)}
          onPick={(tid) => moveOrderToTable(tid)}
        />
      )}

      {showFreeLineSheet && (
        <FreeLineSheet
          country={country ?? null}
          onClose={() => setShowFreeLineSheet(false)}
          onSubmit={addFreeLine}
        />
      )}

      {moveItemTarget && (
        <MoveItemSheet
          itemName={moveItemTarget.name}
          allTables={allTables}
          err={moveItemErr}
          onClose={() => setMoveItemTarget(null)}
          onPick={(tid) => moveItemToTable(moveItemTarget.itemId, tid)}
        />
      )}
    </>
  );
}

function MoveTableSheet({
  sourceTableNumber,
  freeTables,
  err,
  onClose,
  onPick,
}: {
  sourceTableNumber: number;
  freeTables: FreeTable[];
  err: string | null;
  onClose: () => void;
  onPick: (targetTableId: string) => void | Promise<void>;
}) {
  const tr = useTranslations("opTables");
  const [busy, setBusy] = useState(false);
  async function pick(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onPick(id);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/50 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {tr("moveFromTable", { number: sourceTableNumber })}
            </div>
            <h2 className="font-display text-2xl mt-1">
              {tr("movePickTitle")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={tr("close")}
          >
            {"✕"}
          </button>
        </div>

        <p className="text-xs text-muted">{tr("moveHint")}</p>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2">
          {freeTables.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t.id)}
              disabled={busy}
              className="h-14 rounded-xl bg-op-surface border border-hairline hover:border-ink/40 disabled:opacity-50 flex flex-col items-center justify-center"
              title={t.label ?? undefined}
            >
              <div className="font-display text-lg tabular leading-none">
                {t.number}
              </div>
              {t.label && (
                <div className="text-[10px] text-op-muted mt-0.5 truncate max-w-full px-1">
                  {t.label}
                </div>
              )}
            </button>
          ))}
        </div>

        {err && <div className="text-xs text-danger">{err}</div>}
      </div>
    </div>
  );
}

/**
 * Picker para mover UN plato a otra mesa. A diferencia de
 * MoveTableSheet (mueve el pedido entero, solo a mesas libres), acá
 * listamos TODAS las otras mesas y marcamos si están ocupadas — el
 * plato se sumará a esa cuenta abierta — o libres — se abre cuenta
 * nueva. El encabezado muestra el nombre del plato que se mueve.
 */
function MoveItemSheet({
  itemName,
  allTables,
  err,
  onClose,
  onPick,
}: {
  itemName: string;
  allTables: AllTable[];
  err: string | null;
  onClose: () => void;
  onPick: (targetTableId: string) => void | Promise<void>;
}) {
  const tr = useTranslations("opTables");
  const [busy, setBusy] = useState(false);
  async function pick(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onPick(id);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/50 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {tr("moveItemFromDish")}
            </div>
            <h2 className="font-display text-2xl mt-1">{itemName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={tr("close")}
          >
            {"✕"}
          </button>
        </div>

        <p className="text-xs text-muted">{tr("moveItemHint")}</p>

        {allTables.length === 0 ? (
          <div className="text-sm text-op-muted">{tr("moveItemNoTables")}</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2">
            {allTables.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pick(t.id)}
                disabled={busy}
                className={
                  "h-16 rounded-xl border disabled:opacity-50 flex flex-col items-center justify-center px-1 " +
                  (t.occupied
                    ? "bg-terracotta/10 border-terracotta/40 hover:border-terracotta/70"
                    : "bg-op-surface border-hairline hover:border-ink/40")
                }
                title={t.label ?? undefined}
              >
                <div className="font-display text-lg tabular leading-none">
                  {t.number}
                </div>
                {t.label && (
                  <div className="text-[10px] text-op-muted mt-0.5 truncate max-w-full px-1">
                    {t.label}
                  </div>
                )}
                <div
                  className={
                    "font-mono text-[8px] tracking-wider uppercase mt-0.5 " +
                    (t.occupied ? "text-terracotta" : "text-op-muted")
                  }
                >
                  {t.occupied
                    ? tr("moveItemTableOccupied")
                    : tr("moveItemTableFree")}
                </div>
              </button>
            ))}
          </div>
        )}

        {err && <div className="text-xs text-danger">{err}</div>}
      </div>
    </div>
  );
}

/**
 * Formulario de LÍNEA LIBRE: nombre, cantidad, precio unitario e impuesto.
 *
 * El impuesto se elige por tipo (ninguno / impoconsumo / IVA) y tarifa, y las
 * tarifas ofrecidas salen del país del comercio. Eso es justamente lo que hace
 * falta para facturar una consultoría o un catering con IVA 19% desde un
 * restaurante que en la carta cobra impoconsumo del 8%.
 *
 * El precio se digita con `MoneyInput` (type="text" + inputMode, pesos enteros
 * con separadores de miles). Un `<input type="number">` no sirve acá: con
 * separador decimal el navegador devuelve "" y el valor se pierde.
 */
function FreeLineSheet({
  country,
  onClose,
  onSubmit,
}: {
  country: string | null;
  onClose: () => void;
  /** Devuelve un mensaje de error ya traducido, o null si guardó bien. */
  onSubmit: (input: {
    name: string;
    qty: number;
    unitPriceCents: number;
    taxKind: "none" | "inc" | "iva";
    taxPct: number;
  }) => Promise<string | null>;
}) {
  const tr = useTranslations("opTables");
  const [name, setName] = useState("");
  const [qtyRaw, setQtyRaw] = useState("1");
  const [priceDigits, setPriceDigits] = useState("");
  const [taxKind, setTaxKind] = useState<"none" | "inc" | "iva">("none");
  const [taxPct, setTaxPct] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rates = salesTaxRates(taxKind, country);
  const qty = qtyRaw === "" ? 0 : Number(qtyRaw);
  const unitPriceCents = pesosToCents(Number(priceDigits || "0"));
  const lineCents = unitPriceCents * qty;
  const taxCents = lineTaxOnTopCents({
    amountCents: lineCents,
    taxKind,
    taxPct,
  });

  function changeKind(k: "none" | "inc" | "iva") {
    setErr(null);
    setTaxKind(k);
    // La tarifa se resetea a la general del país (la última de la lista): 19%
    // de IVA en Colombia, 16% en México, 8% de impoconsumo. Dejar la anterior
    // al cambiar de tipo produciría combinaciones que el backend rechaza.
    const next = salesTaxRates(k, country);
    setTaxPct(next[next.length - 1] ?? 0);
  }

  const trimmed = name.trim();
  const canSubmit =
    trimmed.length >= 2 &&
    qty >= 1 &&
    qty <= MAX_FREE_LINE_QTY &&
    lineCents > 0 &&
    lineCents <= MAX_FREE_LINE_TOTAL_CENTS &&
    !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const msg = await onSubmit({
        name: trimmed,
        qty,
        unitPriceCents,
        taxKind,
        taxPct,
      });
      if (msg) setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/50 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {tr("freeLinesTitle")}
            </div>
            <h2 className="font-display text-2xl mt-1">{tr("addFreeLine")}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={tr("close")}
          >
            {"✕"}
          </button>
        </div>

        <p className="text-xs text-muted">{tr("freeLineHint")}</p>

        <label className="block">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-1">
            {tr("freeLineName")}
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setErr(null);
              setName(e.target.value.slice(0, 120));
            }}
            placeholder={tr("freeLineNamePlaceholder")}
            className="w-full min-h-[44px] px-3 rounded-lg border border-hairline bg-paper text-sm focus:outline-none focus:border-ink/40"
          />
        </label>

        <div className="grid grid-cols-[80px_1fr] gap-3">
          <label className="block">
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-1">
              {tr("freeLineQty")}
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={qtyRaw}
              onChange={(e) => {
                setErr(null);
                setQtyRaw(e.target.value.replace(/\D/g, "").slice(0, 3));
              }}
              className="w-full min-h-[44px] px-3 rounded-lg border border-hairline bg-paper text-sm tabular focus:outline-none focus:border-ink/40"
            />
          </label>
          <label className="block">
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-1">
              {tr("freeLineUnitPrice")}
            </div>
            <MoneyInput
              value={priceDigits}
              onChange={(digits) => {
                setErr(null);
                setPriceDigits(digits);
              }}
              ariaLabel={tr("freeLineUnitPrice")}
              className="w-full min-h-[44px] px-3 rounded-lg border border-hairline bg-paper text-sm tabular focus:outline-none focus:border-ink/40"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-1">
              {tr("freeLineTaxKind")}
            </div>
            <select
              value={taxKind}
              onChange={(e) =>
                changeKind(e.target.value as "none" | "inc" | "iva")
              }
              className="w-full min-h-[44px] px-3 rounded-lg border border-hairline bg-paper text-sm focus:outline-none focus:border-ink/40"
            >
              <option value="none">{tr("taxKindNone")}</option>
              <option value="inc">{tr("taxKindInc")}</option>
              <option value="iva">{tr("taxKindIva")}</option>
            </select>
          </label>
          <label className="block">
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-1">
              {tr("freeLineTaxPct")}
            </div>
            <select
              value={String(taxPct)}
              disabled={taxKind === "none"}
              onChange={(e) => {
                setErr(null);
                setTaxPct(Number(e.target.value));
              }}
              className="w-full min-h-[44px] px-3 rounded-lg border border-hairline bg-paper text-sm disabled:opacity-40 focus:outline-none focus:border-ink/40"
            >
              {rates.map((p) => (
                <option key={p} value={String(p)}>
                  {tr("freeLinePctOption", { pct: p })}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Vista previa: el impuesto se SUMA, así que el mesero tiene que ver
            a cuánto queda la línea antes de agregarla a la cuenta. */}
        <div className="rounded-xl border border-hairline bg-op-bg p-3 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-op-muted">{tr("freeLinePreviewBase")}</span>
            <span className="font-mono tabular">{fmtCOP(lineCents)}</span>
          </div>
          {taxCents > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-op-muted">
                {tr("freeLinePreviewTax", {
                  kind: taxKind === "inc" ? tr("taxKindInc") : tr("taxKindIva"),
                  pct: taxPct,
                })}
              </span>
              <span className="font-mono tabular">{fmtCOP(taxCents)}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-sm font-medium pt-1 border-t border-hairline">
            <span>{tr("freeLinePreviewTotal")}</span>
            <span className="font-mono tabular">
              {fmtCOP(lineCents + taxCents)}
            </span>
          </div>
        </div>

        {err && <div className="text-xs text-danger">{err}</div>}

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="mp-btn mp-btn--block"
        >
          {busy ? tr("freeLineSubmitBusy") : tr("freeLineSubmit")}
        </button>
      </div>
    </div>
  );
}

// Presets de motivo segun kind. Tap a un preset llena el textarea —
// el mesero puede editarlo o tipear libre. Guardamos las CLAVES i18n
// y resolvemos a texto traducido dentro del componente.
const CANCEL_PRESET_KEYS = [
  "presetCancelChangedMind",
  "presetCancelTooSlow",
  "presetCancelOrderError",
  "presetCancelMissingIngredient",
];

const COMP_PRESET_KEYS = [
  "presetCompDisliked",
  "presetCompColdBad",
  "presetCompWrongDish",
  "presetCompCourtesy",
  "presetCompWalkout",
];

function CancelItemSheet({
  itemName,
  kind,
  onClose,
  onConfirm,
}: {
  itemName: string;
  // Decide el copy del sheet + presets + color del CTA + audit kind.
  kind: "cancel" | "comp";
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const tr = useTranslations("opTables");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= 3 && !busy;

  const isComp = kind === "comp";
  const title = isComp ? tr("compSheetTitle") : tr("cancelSheetTitle");
  const subtitle = isComp
    ? tr("compSheetSubtitle")
    : tr("cancelSheetSubtitle");
  const presets = (isComp ? COMP_PRESET_KEYS : CANCEL_PRESET_KEYS).map((k) =>
    tr(k),
  );
  const ctaIdle = isComp ? tr("compCtaIdle") : tr("cancelCtaIdle");
  const ctaBusy = isComp ? tr("compCtaBusy") : tr("cancelCtaBusy");
  const ctaClass = isComp
    ? "mp-btn--accent"
    : "mp-btn--danger-solid";

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/50 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {title}
            </div>
            <h2 className="font-display text-2xl mt-1">{itemName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={tr("close")}
          >
            {"✕"}
          </button>
        </div>

        <p className="text-xs text-muted">{subtitle}</p>

        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {tr("reasonLabel")}
          </div>
          <div className="flex flex-wrap gap-2 mb-2">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setReason(p)}
                className={
                  "h-8 px-3 rounded-full text-[11px] font-medium border transition-colors " +
                  (reason === p
                    ? "bg-ink text-bone border-ink"
                    : "bg-paper border-hairline text-ink hover:border-ink")
                }
              >
                {p}
              </button>
            ))}
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={tr("reasonPlaceholder")}
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-hairline bg-paper text-sm resize-none"
          />
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className={"mp-btn mp-btn--block " + ctaClass}
        >
          {busy ? ctaBusy : ctaIdle}
        </button>
      </div>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: "placed" | "in_kitchen" | "ready" | "served";
}) {
  const tr = useTranslations("opTables");
  const map: Record<typeof status, { label: string; cls: string }> = {
    placed: { label: tr("statusPlaced"), cls: "bg-op-bg text-op-muted" },
    in_kitchen: {
      label: tr("statusInKitchen"),
      cls: "bg-[#C98A2E]/15 text-[#8F6828]",
    },
    ready: { label: tr("statusReady"), cls: "bg-ok/15 text-ok" },
    served: { label: tr("statusServed"), cls: "bg-op-bg text-op-muted" },
  };
  const m = map[status];
  return (
    <span
      className={
        "shrink-0 font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-full " +
        m.cls
      }
    >
      {m.label}
    </span>
  );
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}
