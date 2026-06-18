"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pantalla que ve el mesero cuando intenta cobrar sin tener turno
 * personal abierto (shiftPolicy="by_waiter"). Le explica el bloqueo y
 * le ofrece abrir el turno declarando su base — al abrir, refrescamos
 * y la página ya muestra el flujo de cobro.
 *
 * Texto en español hardcodeado igual que el resto de la superficie del
 * mesero (no migrada a i18n).
 */
export function MeseroNeedsShift() {
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [pesos, setPesos] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const baseCents = (parseInt(pesos.replace(/\D/g, ""), 10) || 0) * 100;

  async function openShift() {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/mesero/shift/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingCashCents: baseCents }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.message ?? j.error ?? "No pudimos abrir el turno");
      return;
    }
    // Turno abierto → la página vuelve a renderizar el flujo de cobro.
    router.refresh();
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-paper p-6 text-center space-y-4">
        <div className="text-3xl" aria-hidden>
          🔒
        </div>
        <div>
          <h1 className="font-display text-2xl">No tenés turno abierto</h1>
          <p className="text-sm text-muted mt-2">
            Para cobrar necesitás tener tu turno abierto, así tu caja queda
            cuadrada. ¿Lo abrís ahora?
          </p>
        </div>

        {opening ? (
          <div className="space-y-3 text-left">
            <div>
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1.5">
                Base inicial (efectivo para vueltos)
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-hairline bg-ivory px-3 h-12">
                <span className="text-muted font-display text-lg">$</span>
                <input
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  value={pesos ? Number(pesos).toLocaleString("es-CO") : ""}
                  onChange={(e) => setPesos(e.target.value.replace(/\D/g, ""))}
                  placeholder="0"
                  className="flex-1 bg-transparent outline-none font-display text-xl tabular min-w-0"
                />
              </div>
              <p className="text-[11px] text-muted mt-1">
                Si no manejás base, dejalo en $0.
              </p>
            </div>
            {err && <div className="text-xs text-danger">{err}</div>}
            <button
              type="button"
              onClick={openShift}
              disabled={busy}
              className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium disabled:opacity-50"
            >
              {busy ? "Abriendo…" : "Abrir turno y cobrar"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpening(true)}
            className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium"
          >
            Abrir turno
          </button>
        )}

        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm text-muted"
        >
          Volver
        </button>
      </div>
    </div>
  );
}
