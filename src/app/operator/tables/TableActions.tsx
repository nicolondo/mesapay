"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function TableActions({
  orderId,
  status,
}: {
  orderId: string;
  status: string;
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

  const canMarkServed = status !== "served" && status !== "cancelled";

  return (
    <div className="mt-3 flex gap-2">
      {canMarkServed && (
        <button
          onClick={() => act("served")}
          disabled={!!busy}
          className="flex-1 h-8 rounded-lg bg-ok text-bone text-xs font-medium disabled:opacity-60"
        >
          {busy === "served" ? "…" : "Marcar servido"}
        </button>
      )}
      <button
        onClick={() => act("cancelled")}
        disabled={!!busy}
        className="h-8 px-3 rounded-lg border border-danger/40 text-danger text-xs disabled:opacity-60"
      >
        {busy === "cancelled" ? "…" : "Cancelar"}
      </button>
    </div>
  );
}
