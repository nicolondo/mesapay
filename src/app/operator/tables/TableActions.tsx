"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-table action row on /operator/tables (and /operator/orders/[id]).
 *
 * The intentionally small surface is:
 *   - Cobrar la cuenta: opens the pay page in waiter mode
 *   - Cancelar: only while the kitchen hasn't plated anything yet
 *
 * "Marcar servido" used to live here too as a coarse "the whole order
 * was delivered" override, but it duplicated the per-item "Entregado"
 * tracking on /operator/serve. Marking the whole order served in one
 * click loses individual delivery timestamps and invited misuse — so
 * the serving workflow is now exclusively on the Salón board.
 */
export function TableActions({
  orderId,
  tenantSlug,
  status,
  outstandingCents,
}: {
  orderId: string;
  tenantSlug: string;
  status: string;
  // What's left to pay (subtotal - approved food paid). When zero,
  // there's nothing to charge — hide the Cobrar CTA.
  outstandingCents: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function cancel() {
    const ok = window.confirm("¿Cancelar esta orden? No se podrá revertir.");
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/operator/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    setBusy(false);
    if (!res.ok) {
      alert("No se pudo cancelar la orden.");
      return;
    }
    startTx(() => router.refresh());
  }

  // Cancelling only makes sense while the food is still being made.
  // Once the kitchen has plated it (ready) or the waiter dropped it
  // off (served), the cost is sunk and cancellation would just create
  // accounting noise.
  const canCancel = status === "placed" || status === "in_kitchen";
  // Charging makes sense any time there's still something to collect
  // — typically when the table is served, but a waiter may want to
  // pre-charge or settle mid-meal too.
  const canCharge =
    outstandingCents > 0 && status !== "paid" && status !== "cancelled";

  if (!canCancel && !canCharge) return null;

  return (
    <div className="mt-3 flex gap-2 flex-wrap">
      {canCharge && (
        <a
          href={`/t/${tenantSlug}/pay/${orderId}?op=1`}
          target="_blank"
          rel="noreferrer"
          className="flex-1 min-w-[110px] h-8 inline-flex items-center justify-center rounded-lg bg-ink text-bone text-xs font-medium"
        >
          Cobrar la cuenta
        </a>
      )}
      {canCancel && (
        <button
          onClick={cancel}
          disabled={busy}
          className="h-8 px-3 rounded-lg border border-danger/40 text-danger text-xs disabled:opacity-60"
        >
          {busy ? "…" : "Cancelar"}
        </button>
      )}
    </div>
  );
}
