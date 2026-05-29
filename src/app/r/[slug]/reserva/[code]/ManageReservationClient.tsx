"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ManageReservationClient({
  tenantSlug,
  code,
  cancelable,
  alreadyCancelled,
}: {
  tenantSlug: string;
  code: string;
  cancelable: boolean;
  alreadyCancelled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function cancel() {
    if (!confirm("¿Seguro que querés cancelar tu reserva?")) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(
      `/api/tenant/${tenantSlug}/reservations/${code}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!res.ok) {
      setErr("No pudimos cancelar. Intentá de nuevo o llamá al restaurante.");
      return;
    }
    router.refresh();
  }

  if (alreadyCancelled) {
    return (
      <p className="text-sm text-muted text-center">
        Esta reserva ya no está activa.
      </p>
    );
  }

  if (!cancelable) {
    return (
      <p className="text-xs text-muted text-center">
        Para cambios, comunicate directamente con el restaurante.
      </p>
    );
  }

  return (
    <div className="text-center">
      <button
        type="button"
        onClick={cancel}
        disabled={busy}
        className="h-11 px-6 rounded-full border border-danger/40 text-danger text-sm font-medium disabled:opacity-50"
      >
        {busy ? "Cancelando…" : "Cancelar mi reserva"}
      </button>
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </div>
  );
}
