"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { useApiError } from "@/lib/useApiError";
import type { VoucherRedeemability } from "@/lib/vouchers/validate";

export type VoucherRow = {
  id: string;
  code: string;
  valueCents: number;
  balanceCents: number;
  status: "active" | "exhausted" | "cancelled" | "expired";
  redeemability: VoucherRedeemability;
  used: boolean;
  expiresAt: string | null;
};

/**
 * Acciones del lote (link de pago, reenviar correo, cancelar lote) y la
 * tabla de bonos con cancelación individual. Cada acción pega a su ruta
 * y refresca el server component: el estado vive en la DB.
 */
export function BatchDetailClient({
  batchId,
  mode,
  status,
  currency,
  paymentUrl,
  emailSentAt,
  anyUsed,
  vouchers,
}: {
  batchId: string;
  mode: "prepaid" | "credit";
  status: "issued" | "paid" | "cancelled";
  currency: string;
  paymentUrl: string | null;
  emailSentAt: string | null;
  anyUsed: boolean;
  vouchers: VoucherRow[];
}) {
  const t = useTranslations("opVouchers");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const apiError = useApiError();
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Los códigos propios del feature (used, paid, email_failed…) viven en
  // opVouchers; el resto (rate_limited, internal_error…) en apiErrors.
  const codeText = (j: { error?: unknown }, fallback: string) =>
    typeof j.error === "string" && t.has(j.error) ? t(j.error) : apiError(j, fallback);

  async function post(path: string, okText: string, errorText: string) {
    setBusy(path);
    setMsg(null);
    try {
      const r = await fetch(path, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ kind: "error", text: codeText(j, errorText) });
        return;
      }
      setMsg({ kind: "ok", text: okText });
      router.refresh();
    } catch {
      setMsg({ kind: "error", text: errorText });
    } finally {
      setBusy(null);
    }
  }

  // Entero sólo sin uso y (en prepago) sin pagar: un lote pagado es plata
  // recibida y se resuelve bono a bono. Mismo criterio que el server.
  const canCancelBatch = status === "issued" && !anyUsed;
  const cancelBlocked =
    status === "cancelled"
      ? null
      : anyUsed
        ? t("cancelBatchBlockedUsed")
        : mode === "prepaid" && status === "paid"
          ? t("cancelBatchBlockedPaid")
          : null;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
        {paymentUrl && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
              {t("linkLabel")}
            </span>
            <code className="text-xs bg-op-bg border border-op-border rounded px-2 py-1 break-all">
              {paymentUrl}
            </code>
            <button
              type="button"
              className="mp-btn mp-btn--secondary mp-btn--sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(paymentUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  /* sin clipboard: el usuario copia a mano */
                }
              }}
            >
              {copied ? t("copied") : t("copyLink")}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-op-muted">
            {emailSentAt
              ? t("emailSent", {
                  date: formatDate(emailSentAt, { locale, dateStyle: "medium", timeStyle: "short" }),
                })
              : t("emailNotSent")}
          </span>
          {status !== "cancelled" && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                post(
                  `/api/operator/vouchers/batches/${batchId}/resend-email`,
                  t("resent"),
                  t("resendError"),
                )
              }
              className="mp-btn mp-btn--secondary mp-btn--sm"
            >
              {busy?.endsWith("resend-email") ? t("resending") : t("resend")}
            </button>
          )}
          {status !== "cancelled" && (
            <button
              type="button"
              disabled={busy !== null || !canCancelBatch}
              title={cancelBlocked ?? undefined}
              onClick={() => {
                if (!confirm(t("cancelBatchConfirm", { count: vouchers.length }))) return;
                post(
                  `/api/operator/vouchers/batches/${batchId}/cancel`,
                  t("cancelled"),
                  t("actionError"),
                );
              }}
              className="mp-btn mp-btn--danger mp-btn--sm ml-auto"
            >
              {t("cancelBatch")}
            </button>
          )}
        </div>
        {cancelBlocked && status !== "cancelled" && (
          <p className="text-xs text-op-muted">{cancelBlocked}</p>
        )}
        {msg && (
          <p role="status" className={"text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")}>
            {msg.text}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl mb-3">{t("vouchersTitle")}</h2>
        <div className="overflow-x-auto rounded-2xl border border-op-border bg-op-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-[0.12em] uppercase text-op-muted">
                <th className="px-4 py-3">{t("colCode")}</th>
                <th className="px-4 py-3 text-right">{t("colValue")}</th>
                <th className="px-4 py-3 text-right">{t("colBalanceV")}</th>
                <th className="px-4 py-3">{t("colStatusV")}</th>
                <th className="px-4 py-3">{t("colExpires")}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {vouchers.map((v) => (
                <tr key={v.id} className="border-t border-op-border">
                  <td className="px-4 py-3 font-mono tracking-[0.06em]">{v.code}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(v.valueCents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(v.balanceCents)}</td>
                  <td className="px-4 py-3">
                    <VoucherStatus row={v} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {v.expiresAt
                      ? formatDate(v.expiresAt, { locale, dateStyle: "medium", timeStyle: undefined })
                      : t("expiryNone")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {v.status === "active" && !v.used && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (!confirm(t("cancelVoucherConfirm", { code: v.code }))) return;
                          post(
                            `/api/operator/vouchers/${v.id}/cancel`,
                            t("voucherCancelled", { code: v.code }),
                            t("actionError"),
                          );
                        }}
                        className="text-xs text-danger underline"
                      >
                        {t("cancelVoucher")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function VoucherStatus({ row }: { row: VoucherRow }) {
  const t = useTranslations("opVouchers");
  let label: string;
  let tint: string;
  if (row.status === "cancelled") {
    label = t("vStatus_cancelled");
    tint = "bg-danger/10 text-danger";
  } else if (row.redeemability === "batch_unpaid") {
    label = t("vStatusUnpaid");
    tint = "bg-[#C98A2E]/20 text-[#8F6828]";
  } else if (row.redeemability === "expired") {
    label = t("vStatus_expired");
    tint = "bg-paper text-op-muted";
  } else if (row.redeemability === "exhausted") {
    label = t("vStatus_exhausted");
    tint = "bg-paper text-op-muted";
  } else if (row.balanceCents < row.valueCents) {
    label = t("vStatusPartial");
    tint = "bg-ok/15 text-ok";
  } else {
    label = t("vStatus_active");
    tint = "bg-ok/15 text-ok";
  }
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tint}`}>
      {label}
    </span>
  );
}
