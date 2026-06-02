"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

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
  const tr = useTranslations("reservar");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function cancel() {
    if (!confirm(tr("confirmCancel"))) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(
      `/api/tenant/${tenantSlug}/reservations/${code}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!res.ok) {
      setErr(tr("errCancel"));
      return;
    }
    router.refresh();
  }

  if (alreadyCancelled) {
    return (
      <p className="text-sm text-muted text-center">
        {tr("notActive")}
      </p>
    );
  }

  if (!cancelable) {
    return (
      <p className="text-xs text-muted text-center">
        {tr("contactRestaurant")}
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
        {busy ? tr("cancelling") : tr("cancelReservation")}
      </button>
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </div>
  );
}
