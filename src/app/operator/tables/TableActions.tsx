"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

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
  const [busy, setBusy] = useState<"served" | "cancelled" | null>(null);
  const [, startTx] = useTransition();

  async function act(next: "served" | "cancelled") {
    if (next === "cancelled") {
      const ok = window.confirm("¿Cancelar esta orden? No se podrá revertir.");
      if (!ok) return;
    }
    setBusy(next);
    const res = await fetch(`/api/operator/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(null);
    if (!res.ok) {
      alert("No se pudo actualizar la orden.");
      return;
    }
    startTx(() => router.refresh());
  }

  // "Marcar servido" is a table-level override that flips the whole
  // order to served — only meaningful once the kitchen has actually
  // finished everything (status=ready). Showing it on placed /
  // in_kitchen invited the operator to claim food was on the table
  // before it had been cooked. For partial deliveries (some items
  // ready, others still cooking), the per-item "Entregado" button on
  // /operator/serve is the right tool.
  const canMarkServed = status === "ready";
  // Cancelling only makes sense while the food is still being made.
  // Once the kitchen has plated it (ready) or the waiter dropped it
  // off (served), the cost is sunk and cancellation would just create
  // accounting noise. We hide the button in those states.
  const canCancel = status === "placed" || status === "in_kitchen";
  // Charging makes sense any time there's still something to collect
  // — typically when the table is served, but a waiter may want to
  // pre-charge or settle mid-meal too.
  const canCharge =
    outstandingCents > 0 &&
    status !== "paid" &&
    status !== "cancelled";

  return (
    <div className="mt-3 flex gap-2 flex-wrap">
      {canMarkServed && (
        <button
          onClick={() => act("served")}
          disabled={!!busy}
          className="flex-1 min-w-[110px] h-8 rounded-lg bg-ok text-bone text-xs font-medium disabled:opacity-60"
        >
          {busy === "served" ? "…" : "Marcar servido"}
        </button>
      )}
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
          onClick={() => act("cancelled")}
          disabled={!!busy}
          className="h-8 px-3 rounded-lg border border-danger/40 text-danger text-xs disabled:opacity-60"
        >
          {busy === "cancelled" ? "…" : "Cancelar"}
        </button>
      )}
    </div>
  );
}
