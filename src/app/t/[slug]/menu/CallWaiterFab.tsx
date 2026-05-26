"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * FAB compacto para llamar al mesero desde la carta. Versión chica
 * del CallWaiterButton de /order/[orderId] — pensado para vivir en
 * el header sticky junto al pill del shortCode, sin robar espacio
 * al menú.
 *
 * Estados:
 *   idle      → ícono campana en outline
 *   busy      → ícono + ring pulsante mientras espera la respuesta
 *   called    → terracotta sólido con check overlay (15s)
 *   cooldown  → idle pero deshabilitado por 30s post-called para
 *               evitar spam (el cliente ya llamó, no hace falta
 *               re-tap inmediato)
 *
 * Sólo se renderea cuando hay activeOrder — calls pre-orden quedan
 * para una iteración futura (requiere agregar Table.waiterCalledAt
 * + cambiar las queries de Salón).
 */
export function CallWaiterFab({
  tenantSlug,
  orderId,
  initialNeedsWaiter,
}: {
  tenantSlug: string;
  orderId: string;
  initialNeedsWaiter: boolean;
}) {
  const router = useRouter();
  const [optimisticCalled, setOptimisticCalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  const called = initialNeedsWaiter || optimisticCalled;

  // Cuando el server confirma needsWaiter=false (el mesero hizo ack),
  // resetear el optimistic flag para volver a permitir nuevos llamados.
  useEffect(() => {
    if (!initialNeedsWaiter && optimisticCalled) {
      setOptimisticCalled(false);
    }
  }, [initialNeedsWaiter, optimisticCalled]);

  async function call() {
    if (called || busy) return;
    setBusy(true);
    setErr(null);
    setOptimisticCalled(true);
    try {
      navigator.vibrate?.([40, 30, 40]);
    } catch {}
    const res = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/call-waiter`,
      { method: "POST" },
    );
    setBusy(false);
    if (!res.ok) {
      setOptimisticCalled(false);
      setErr("No pudimos llamar al mesero.");
      // Limpiar el error después de 3s para no dejarlo pegado.
      setTimeout(() => setErr(null), 3000);
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={call}
        disabled={busy || called}
        title={
          called
            ? "Mesero llamado — vamos en camino"
            : "Llamar al mesero"
        }
        aria-label={
          called ? "Mesero llamado" : "Llamar al mesero"
        }
        className={
          "w-9 h-9 rounded-full inline-flex items-center justify-center transition-colors active:scale-95 " +
          (called
            ? "bg-terracotta text-paper"
            : busy
              ? "border border-terracotta/40 bg-terracotta/10 text-terracotta animate-pulse"
              : "border border-hairline bg-paper text-op-muted hover:text-terracotta hover:border-terracotta/40")
        }
      >
        <BellIcon />
      </button>
      {/* Toast de error sutil al lado del botón. No interrumpe la
          navegación; auto-clears en 3s. */}
      {err && (
        <div
          role="status"
          className="absolute right-0 top-full mt-1 whitespace-nowrap text-[10px] text-danger bg-paper border border-danger/30 px-2 py-1 rounded-md shadow-sm"
        >
          {err}
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
