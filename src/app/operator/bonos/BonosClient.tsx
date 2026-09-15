"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { CustomerPicker } from "@/components/billingCustomers/CustomerPicker";
import { billingDocument, type BillingCustomerRecord } from "@/components/billingCustomers/types";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { useApiError } from "@/lib/useApiError";

export type BatchRow = {
  id: string;
  mode: "prepaid" | "credit";
  status: "issued" | "paid" | "cancelled";
  quantity: number;
  unitValueCents: number;
  totalCents: number;
  balanceCents: number;
  activeCount: number;
  expiresAt: string | null;
  issuedAt: string;
  emailSentAt: string | null;
  customerName: string;
};

type Settings = {
  mode: "prepaid" | "credit";
  defaultValueCents: number;
  defaultExpiryDays: number | null;
};

const MAX_QUANTITY = 500;

const inputCls =
  "h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const labelCls = "block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1";

/**
 * Formulario de emisión + lista de lotes. La empresa se elige con el
 * mismo buscador de clientes de facturación que usa el cobro en caja
 * (CustomerPicker); si no existe, se crea en Clientes y se vuelve.
 */
export function BonosClient({
  currency,
  settings,
  batches,
}: {
  currency: string;
  settings: Settings;
  batches: BatchRow[];
}) {
  const t = useTranslations("opVouchers");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const apiError = useApiError();
  const money = (cents: number) => formatMoney(cents, { currency, locale });

  const [customer, setCustomer] = useState<BillingCustomerRecord | null>(null);
  const [quantity, setQuantity] = useState("10");
  const [value, setValue] = useState(
    settings.defaultValueCents > 0 ? String(Math.round(settings.defaultValueCents / 100)) : "",
  );
  const [days, setDays] = useState(settings.defaultExpiryDays ? String(settings.defaultExpiryDays) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string; batchId?: string } | null>(null);

  const qty = Number(quantity || "0");
  const unitCents = Math.round(Number(value || "0") * 100);
  const daysNumber = days === "" ? null : Number(days);
  const qtyValid = Number.isInteger(qty) && qty >= 1 && qty <= MAX_QUANTITY;
  const valueValid = unitCents >= 100;
  const daysValid = daysNumber === null || (Number.isInteger(daysNumber) && daysNumber >= 1);
  const canIssue = !!customer && qtyValid && valueValid && daysValid && !busy;

  async function issue() {
    if (!customer) return setMsg({ kind: "error", text: t("errCustomerRequired") });
    if (!qtyValid) return setMsg({ kind: "error", text: t("errQuantity", { max: MAX_QUANTITY }) });
    if (!valueValid) return setMsg({ kind: "error", text: t("errValue") });
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/operator/vouchers/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          billingCustomerId: customer.id,
          quantity: qty,
          unitValueCents: unitCents,
          expiryDays: daysNumber,
          note: note.trim() || null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // customer_not_found vive en opVouchers; el resto en apiErrors.
        const text =
          typeof j.error === "string" && t.has(j.error) ? t(j.error) : apiError(j, t("issueError"));
        setMsg({ kind: "error", text });
        return;
      }
      setMsg({
        kind: "ok",
        text: j.emailed
          ? t("issuedOk", { count: qty, customer: customer.customerName })
          : t("issuedNoEmail", { count: qty, customer: customer.customerName }),
        batchId: j.batch?.id,
      });
      setCustomer(null);
      setNote("");
      router.refresh();
    } catch {
      setMsg({ kind: "error", text: t("issueError") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="font-display text-xl">{t("issueTitle")}</h2>
          <span className="text-xs text-op-muted">
            {t("currentModeHint", {
              mode: settings.mode === "prepaid" ? t("modePrepaid") : t("modeCredit"),
            })}{" "}
            <Link href="/operator/settings/bonos" className="text-terracotta underline">
              {t("settingsLink")}
            </Link>
          </span>
        </div>

        {customer ? (
          <div className="rounded-xl border border-op-border bg-op-bg p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{customer.customerName}</div>
              <div className="text-xs text-op-muted truncate">
                {customer.docType} {billingDocument(customer)} · {customer.email}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCustomer(null)}
              className="mp-btn mp-btn--secondary mp-btn--sm shrink-0"
            >
              {t("changeCustomer")}
            </button>
          </div>
        ) : (
          <div>
            <CustomerPicker onSelect={setCustomer} />
            <p className="text-xs text-op-muted mt-2">
              {t("createCustomerHint")}{" "}
              <Link href="/operator/clientes" className="text-terracotta underline">
                {t("createCustomerLink")}
              </Link>
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={labelCls}>{t("quantityLabel")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_QUANTITY}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/\D/g, "").slice(0, 3))}
              className={inputCls + " w-24 tabular-nums"}
            />
          </label>
          <label className="block">
            <span className={labelCls}>{t("unitValueLabel")}</span>
            <MoneyInput
              value={value}
              onChange={setValue}
              ariaLabel={t("unitValueLabel")}
              className={inputCls + " w-40 tabular-nums"}
            />
          </label>
          <label className="block">
            <span className={labelCls}>{t("expiryDaysLabel")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              value={days}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder={t("expiryNone")}
              className={inputCls + " w-32 tabular-nums"}
            />
          </label>
          <div className="ml-auto text-right">
            <div className={labelCls}>{t("totalLabel")}</div>
            <div className="font-display text-2xl tabular-nums">
              {money(qtyValid && valueValid ? qty * unitCents : 0)}
            </div>
          </div>
        </div>
        <label className="block">
          <span className={labelCls}>{t("noteLabel")}</span>
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("notePlaceholder")}
            className={inputCls + " w-full"}
          />
        </label>
        <div className="flex items-center justify-end gap-3 flex-wrap">
          {msg && (
            <span
              role="status"
              className={"text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")}
            >
              {msg.text}{" "}
              {msg.batchId && (
                <Link href={`/operator/bonos/${msg.batchId}`} className="underline">
                  {t("viewBatch")}
                </Link>
              )}
            </span>
          )}
          <button
            type="button"
            onClick={issue}
            disabled={!canIssue}
            className="mp-btn mp-btn--primary"
          >
            {busy ? t("issuing") : t("issue", { count: qtyValid ? qty : 0 })}
          </button>
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl mb-3">{t("batchesTitle")}</h2>
        {batches.length === 0 ? (
          <div className="mp-empty-state">
            <h2>{t("empty")}</h2>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-op-border bg-op-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[10px] tracking-[0.12em] uppercase text-op-muted">
                  <th className="px-4 py-3">{t("colDate")}</th>
                  <th className="px-4 py-3">{t("colCustomer")}</th>
                  <th className="px-4 py-3 text-right">{t("colVouchers")}</th>
                  <th className="px-4 py-3 text-right">{t("colUnit")}</th>
                  <th className="px-4 py-3 text-right">{t("colTotal")}</th>
                  <th className="px-4 py-3 text-right">{t("colBalance")}</th>
                  <th className="px-4 py-3">{t("colMode")}</th>
                  <th className="px-4 py-3">{t("colStatus")}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-op-border">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDate(b.issuedAt, { locale, dateStyle: "medium", timeStyle: undefined })}
                    </td>
                    <td className="px-4 py-3">{b.customerName}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {b.activeCount}/{b.quantity}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(b.unitValueCents)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(b.totalCents)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(b.balanceCents)}</td>
                    <td className="px-4 py-3">
                      {b.mode === "prepaid" ? t("modePrepaid") : t("modeCredit")}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge mode={b.mode} status={b.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/operator/bonos/${b.id}`} className="text-terracotta underline">
                        {t("viewBatch")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function StatusBadge({
  mode,
  status,
}: {
  mode: "prepaid" | "credit";
  status: "issued" | "paid" | "cancelled";
}) {
  const t = useTranslations("opVouchers");
  const pendingPayment = mode === "prepaid" && status === "issued";
  const label = pendingPayment ? t("statusPendingPayment") : t(`status_${status}`);
  const tint =
    status === "cancelled"
      ? "bg-danger/10 text-danger"
      : pendingPayment
        ? "bg-[#C98A2E]/20 text-[#8F6828]"
        : "bg-ok/15 text-ok";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tint}`}>
      {label}
    </span>
  );
}
