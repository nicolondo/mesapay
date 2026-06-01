"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function CancelItemButton({
  orderItemId,
  tenantSlug,
  itemName,
}: {
  orderItemId: string;
  tenantSlug: string;
  itemName: string;
}) {
  const router = useRouter();
  const t = useTranslations("order");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function doCancel() {
    setBusy(true);
    setErr(null);
    const res = await fetch(
      `/api/tenant/${tenantSlug}/order-items/${orderItemId}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!res.ok) {
      if (res.status === 409) {
        setErr(t("errCancelTaken"));
      } else {
        setErr(t("errCancelGeneric"));
      }
      router.refresh();
      return;
    }
    router.refresh();
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted">
          {t("confirmCancelItem", { item: itemName })}
        </span>
        <button
          type="button"
          onClick={doCancel}
          disabled={busy}
          className="h-7 px-2.5 rounded-full bg-danger text-paper text-[11px] font-medium disabled:opacity-60"
        >
          {busy ? "…" : t("yesCancel")}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="h-7 px-2.5 rounded-full border border-hairline text-[11px] text-ink-3"
        >
          {t("no")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[11px] text-muted-2 hover:text-danger underline underline-offset-2"
      >
        {t("cancelAction")}
      </button>
      {err && <span className="text-[11px] text-danger">{err}</span>}
    </div>
  );
}
