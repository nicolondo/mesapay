"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

const ERROR_KEYS: Record<string, string> = {
  advance_used: "errAdvanceUsed",
  applied_in_closed_month: "errClosedMonth",
  month_closed: "errMonthClosed",
  already_voided: "errAlreadyVoided",
};

/** Anular el comprobante (con motivo). No lo borra: el motor asienta el reverso. */
export function VoidVoucher({ id }: { id: string }) {
  const t = useTranslations("opSupplierPayment");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mp-btn mp-btn--ghost mp-btn--sm text-danger">
        {t("voidButton")}
      </button>
    );
  }
  return (
    <div className="w-full sm:w-96 rounded-2xl border border-danger/25 bg-danger/5 p-3 space-y-2">
      <p className="text-sm font-medium text-danger">{t("voidTitle")}</p>
      <p className="text-[12px]">{t("voidBody")}</p>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
        placeholder={t("voidReason")}
        aria-label={t("voidReason")}
        className="w-full min-h-[40px] px-3 rounded-xl border border-op-border bg-op-bg text-sm"
      />
      {err && <p className="text-xs text-danger">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="mp-btn mp-btn--ghost mp-btn--sm">
          {t("cancel")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            const r = await fetch(`/api/operator/supplier-payments/${encodeURIComponent(id)}/void`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: reason.trim() || null }),
            });
            setBusy(false);
            if (!r.ok) {
              const j = await r.json().catch(() => null);
              setErr(t(ERROR_KEYS[j?.error as string] ?? "errSave"));
              return;
            }
            router.refresh();
          }}
          className="mp-btn mp-btn--primary mp-btn--sm bg-danger! border-danger!"
        >
          {t("voidConfirm")}
        </button>
      </div>
    </div>
  );
}
