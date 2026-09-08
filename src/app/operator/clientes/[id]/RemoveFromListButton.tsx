"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * "Quitar de mis clientes" — deshace un agregado a mano.
 *
 * Solo se renderiza cuando el vínculo explícito es el ÚNICO motivo por el
 * que esta persona está en la lista. Si además consumió acá o tiene un
 * descuento pactado, quitarla no la sacaría de la lista y el botón sería
 * una promesa falsa: ninguna pantalla puede borrar facturas ni acuerdos
 * comerciales.
 *
 * El endpoint no recibe restaurantId: lo toma de la sesión.
 */
export function RemoveFromListButton({ customerId }: { customerId: string }) {
  const t = useTranslations("opCustomers");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/operator/customers/${customerId}/link`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setErr(t("errGeneric"));
        return;
      }
      startTx(() => {
        router.push("/operator/clientes");
        router.refresh();
      });
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="h-9 px-4 rounded-full border border-hairline text-xs font-medium disabled:opacity-60"
      >
        {busy ? t("saving") : t("removeFromList")}
      </button>
      {err && <div className="text-danger text-xs mt-2">{err}</div>}
    </div>
  );
}
