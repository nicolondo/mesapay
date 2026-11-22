"use client";

// Estado del cobro EN SERIE (modo staff) — el pegamento entre la lógica pura
// de `lib/payments/serialCharge.ts`, el localStorage por cuenta y la verdad
// del servidor que llega por props (los pagos de la orden, re-renderizados en
// cada `router.refresh()`), para que `PayClient` no engorde con esto.
//
// Qué hace:
//   · Restaura el plan guardado al montar (si el mesero cerró la pestaña a
//     mitad de un cobro dividido, al reabrir «Cobrar» se continúa).
//   · Reconcilia contra los pagos aprobados/pendientes del servidor y emite
//     el evento para la tarjeta de avance: parte aprobada, parte rechazada
//     (reintentar igual), o saldo cambiado por un pago ajeno.
//   · Persiste cada cambio; con la cuenta en cero borra el plan.
//
// Sólo vive en modo staff: el flujo del comensal nunca lo monta.

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  createSerialPlan,
  parseSerialPlan,
  reconcileSerialPlan,
  serialStorageKey,
  withApprovedNow,
  withChargeLaunched,
  withSplitCount,
  type SerialEvent,
  type SerialMethod,
  type SerialMode,
  type SerialPlan,
} from "@/lib/payments/serialCharge";

type ApprovedPayment = { id: string; amountCents: number; tipCents: number };

export type SerialCharge = {
  plan: SerialPlan | null;
  /** Lo último que pasó (para la tarjeta de avance). Se descarta a mano. */
  event: SerialEvent | null;
  dismissEvent: () => void;
  /** El staff cambió "entre cuántos" con el plan ya andando. */
  setSplitCount: (splitCount: number) => void;
  /** Se lanzó un cobro cuyo resultado llega después (datáfono, Bre-B…). */
  chargeLaunched: (launch: {
    mode: SerialMode | null;
    splitCount: number;
    method: SerialMethod;
    paymentId: string;
    guest?: string | null;
  }) => void;
  /** Un cobro aprobado EN EL ACTO (efectivo del staff, Bre-B a la vista). */
  chargeApproved: (settle: {
    mode: SerialMode | null;
    splitCount: number;
    method: SerialMethod;
    paymentId: string;
    amountCents: number;
    paid: boolean;
    guest?: string | null;
  }) => void;
  chargeDeclined: (paymentId: string) => void;
  clear: () => void;
};

export function useSerialCharge({
  orderId,
  enabled,
  alreadyPaid,
  approvedPayments,
  pendingPaymentIds,
  onRestored,
  onPartApproved,
}: {
  orderId: string;
  /** Sólo el cobro del staff (operatorMode y no link de pago). */
  enabled: boolean;
  alreadyPaid: boolean;
  approvedPayments: ApprovedPayment[];
  pendingPaymentIds: string[];
  /** Plan guardado restaurado al montar: para retomar modo y partes. */
  onRestored?: (plan: SerialPlan) => void;
  /** Una parte quedó cobrada: la pantalla re-ofrece la propina del siguiente. */
  onPartApproved?: (event: Extract<SerialEvent, { kind: "approved" }>) => void;
}): SerialCharge {
  const [plan, setPlanState] = useState<SerialPlan | null>(null);
  const [event, setEvent] = useState<SerialEvent | null>(null);
  const restored = useRef(false);
  // El plan vigente y los pagos del servidor, frescos para la reconciliación
  // sin re-disparar efectos (los efectos se gobiernan por las claves abajo).
  const planRef = useRef<SerialPlan | null>(null);
  const paymentsRef = useRef({ approvedPayments, pendingPaymentIds });
  // Callbacks frescos sin re-disparar efectos.
  const onRestoredRef = useRef(onRestored);
  const onPartApprovedRef = useRef(onPartApproved);
  useEffect(() => {
    onRestoredRef.current = onRestored;
    onPartApprovedRef.current = onPartApproved;
  });

  const persist = useCallback(
    (next: SerialPlan | null) => {
      planRef.current = next;
      setPlanState(next);
      try {
        if (next) localStorage.setItem(serialStorageKey(orderId), JSON.stringify(next));
        else localStorage.removeItem(serialStorageKey(orderId));
      } catch {
        // Sin persistencia el plan vive igual en memoria; el saldo siempre
        // es del servidor.
      }
    },
    [orderId],
  );

  /**
   * Reconciliar el plan vigente contra la verdad del servidor. Corre SOLO
   * cuando llegan datos reales (al montar y en cada cambio de los pagos por
   * props) — nunca contra props viejas justo después de lanzar un cobro: el
   * pago recién creado todavía no figura como pendiente y se tomaría por
   * rechazado.
   */
  const reconcile = useCallback(() => {
    const current = planRef.current;
    if (!enabled || !current) return;
    const { plan: next, events } = reconcileSerialPlan(
      current,
      paymentsRef.current.approvedPayments,
      paymentsRef.current.pendingPaymentIds,
    );
    if (next === current && events.length === 0) return;
    // La parte aprobada manda sobre el aviso de saldo: el monto de la
    // siguiente parte ya sale del saldo real de todos modos.
    const main =
      events.find((e) => e.kind === "approved") ??
      events.find((e) => e.kind === "declined") ??
      events[0] ?? null;
    startTransition(() => {
      persist(next);
      if (main) setEvent(main);
    });
    if (main?.kind === "approved") onPartApprovedRef.current?.(main);
  }, [enabled, persist]);

  // Restaurar el plan guardado (una vez, al montar, sólo del lado cliente) y
  // reconciliarlo de inmediato contra lo que el servidor acaba de mandar.
  useEffect(() => {
    if (!enabled || restored.current) return;
    restored.current = true;
    if (alreadyPaid) {
      try { localStorage.removeItem(serialStorageKey(orderId)); } catch { /* opcional */ }
      return;
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(serialStorageKey(orderId));
    } catch {
      return;
    }
    const parsed = parseSerialPlan(saved);
    if (!parsed) return;
    startTransition(() => persist(parsed));
    if (parsed.partsDone > 0 || parsed.inFlight) onRestoredRef.current?.(parsed);
    reconcile();
  }, [enabled, alreadyPaid, orderId, persist, reconcile]);

  // Verdad del servidor nueva (tras un router.refresh() o al volver de la
  // espera del datáfono): refrescar las refs y reconciliar.
  const approvedKey = approvedPayments.map((p) => p.id).join(",");
  const pendingKey = pendingPaymentIds.join(",");
  useEffect(() => {
    paymentsRef.current = { approvedPayments, pendingPaymentIds };
    if (!enabled) return;
    if (alreadyPaid) {
      if (planRef.current) startTransition(() => persist(null));
      return;
    }
    reconcile();
    // Las claves representan a las listas; el resto va por refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, alreadyPaid, approvedKey, pendingKey, reconcile, persist]);

  const ensurePlan = useCallback(
    (mode: SerialMode, splitCount: number): SerialPlan => {
      const current = planRef.current;
      if (current && current.mode === mode) return current;
      // Un plan nuevo arranca contando lo ya aprobado como "de antes".
      return createSerialPlan(
        mode,
        splitCount,
        paymentsRef.current.approvedPayments.map((p) => p.id),
      );
    },
    [],
  );

  const chargeLaunched = useCallback<SerialCharge["chargeLaunched"]>(
    (launch) => {
      if (!enabled || !launch.mode) return;
      const base = ensurePlan(launch.mode, launch.splitCount);
      persist(
        withChargeLaunched(withSplitCount(base, launch.splitCount), launch),
      );
      setEvent(null);
    },
    [enabled, ensurePlan, persist],
  );

  const chargeApproved = useCallback<SerialCharge["chargeApproved"]>(
    (settle) => {
      if (!enabled) return;
      if (settle.paid) {
        // Cuenta en cero: el flujo se va a "listo", el plan ya no sirve.
        persist(null);
        setEvent(null);
        return;
      }
      if (!settle.mode) return;
      const base = ensurePlan(settle.mode, settle.splitCount);
      const { plan: next, event: approved } = withApprovedNow(
        withSplitCount(base, settle.splitCount),
        settle,
      );
      persist(next);
      setEvent(approved);
      if (approved.kind === "approved") onPartApprovedRef.current?.(approved);
    },
    [enabled, ensurePlan, persist],
  );

  const setSplitCount = useCallback(
    (splitCount: number) => {
      if (!planRef.current) return;
      persist(withSplitCount(planRef.current, splitCount));
    },
    [persist],
  );

  const clear = useCallback(() => {
    persist(null);
    setEvent(null);
  }, [persist]);

  const dismissEvent = useCallback(() => setEvent(null), []);

  const chargeDeclined = useCallback((paymentId: string) => {
    const current = planRef.current;
    const flight = current?.inFlight;
    if (!current || !flight || flight.paymentId !== paymentId) return;
    persist({ ...current, inFlight: null });
    setEvent({ kind: "declined", method: flight.method, guest: flight.guest });
  }, [persist]);

  return { chargeDeclined, plan, event, dismissEvent, setSplitCount, chargeLaunched, chargeApproved, clear };
}
