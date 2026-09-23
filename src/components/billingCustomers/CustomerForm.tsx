"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { pesosToCents } from "@/lib/format";
import { discountBpsToPctText, discountPctTextToBps, type BillingCustomerRecord } from "./types";

const inputClass = "w-full min-w-0 rounded-xl border border-hairline bg-ivory px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-terracotta/40";

/**
 * Alta/edición de un cliente de facturación: identidad, correo y teléfono,
 * más el crédito (permitir cobrar a crédito, tope y plazo) y el descuento
 * comercial fijo. No pide dirección ni municipio — la factura electrónica
 * nominativa sale sin el bloque de dirección del adquiriente, igual que la
 * de consumidor final, así que no hay para qué cargarlos.
 *
 * Tampoco pide el dígito de verificación: la identificación es SÓLO el
 * número. Para un NIT el DV lo calcula el servidor (`billingCustomerSchema`)
 * y lo guarda aparte para la DIAN; si el operador igual lo escribe
 * ("901944469-1") se acepta y, si no corresponde, el error cae sobre el
 * número con un mensaje claro.
 */
export function CustomerForm({ initial, onSaved, onCancel }: {
  initial: BillingCustomerRecord | null;
  onSaved: (customer: BillingCustomerRecord) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("billingCustomers");
  const formId = useId();
  const [values, setValues] = useState({
    customerName: initial?.customerName ?? "", docType: initial?.docType ?? "CC",
    docNumber: initial?.docNumber ?? "",
    email: initial?.email ?? "", phone: initial?.phone ?? "",
  });
  const [creditEnabled, setCreditEnabled] = useState(initial?.creditEnabled ?? false);
  // El tope se edita en pesos (MoneyInput trabaja en unidades mayores); vacío = sin tope.
  const [creditLimit, setCreditLimit] = useState(initial?.creditLimitCents != null ? String(initial.creditLimitCents / 100) : "");
  const [creditTermsDays, setCreditTermsDays] = useState(String(initial?.creditTermsDays ?? 30));
  const [discountEnabled, setDiscountEnabled] = useState(initial?.discountEnabled ?? false);
  const [discountPct, setDiscountPct] = useState(initial?.discountBps ? discountBpsToPctText(initial.discountBps) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, unknown>>({});
  function change(field: keyof typeof values, value: string) {
    setValues(previous => ({ ...previous, [field]: value }));
    setFieldErrors(previous => ({ ...previous, [field]: undefined }));
  }
  const discountBps = discountPctTextToBps(discountPct);
  const discountInvalid = discountEnabled && (discountBps === null || discountBps <= 0 || discountBps > 5000);
  const termsDays = Number(creditTermsDays);
  const termsInvalid = creditEnabled && (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > 3650);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (discountInvalid || termsInvalid) {
      setFieldErrors({ ...(discountInvalid ? { discountPct: true } : {}), ...(termsInvalid ? { creditTermsDays: true } : {}) });
      setError(t("invalid"));
      return;
    }
    setBusy(true); setError(""); setFieldErrors({});
    try {
      const limitPesos = Number(creditLimit);
      const response = await fetch(initial ? `/api/operator/billing-customers/${initial.id}` : "/api/operator/billing-customers", {
        method: initial ? "PATCH" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Sólo el número: el DV del NIT lo calcula el servidor.
          ...values,
          creditEnabled,
          creditLimitCents: creditLimit.trim() && Number.isFinite(limitPesos) && limitPesos > 0 ? pesosToCents(limitPesos) : null,
          creditTermsDays: Number.isInteger(termsDays) ? termsDays : 30,
          discountEnabled,
          discountBps: discountBps ?? 0,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.customer) {
        setFieldErrors(data.fieldErrors ?? {});
        setError(t(data.error === "duplicate_document" ? "duplicateDocument" : data.error === "invalid" ? "invalid" : response.status === 403 || response.status === 401 ? "forbidden" : "saveError"));
        return;
      }
      onSaved(data.customer);
    } catch { setError(t("saveError")); }
    finally { setBusy(false); }
  }
  function field(key: Exclude<keyof typeof values, "docType">, options: { type?: string; required?: boolean; maxLength?: number; inputMode?: "text" | "numeric" | "tel"; hint?: string } = {}) {
    const messages = fieldErrors[key];
    const invalid = Boolean(messages);
    // El DV equivocado dentro del número merece su propio mensaje: "revisa
    // este dato" no le dice al operador que sobra (o está mal) el dígito.
    const dvMismatch = Array.isArray(messages) && messages.includes("invalid_verification_digit");
    return <div key={key} className={key === "customerName" ? "sm:col-span-2" : ""}>
      <label htmlFor={`${formId}-${key}`} className="block text-sm text-muted mb-1.5">{t(key)}</label>
      <input id={`${formId}-${key}`} name={key} value={values[key]} onChange={e => change(key, e.target.value)} type={options.type ?? "text"} required={options.required ?? true} maxLength={options.maxLength ?? 160} inputMode={options.inputMode} className={inputClass} aria-invalid={invalid} aria-describedby={invalid ? `${formId}-${key}-error` : undefined} />
      {invalid && <p id={`${formId}-${key}-error`} className="text-xs text-danger mt-1">{t(dvMismatch ? "dvMismatch" : "checkField")}</p>}
      {options.hint && <p className="text-xs text-muted mt-1">{options.hint}</p>}
    </div>;
  }
  return <form onSubmit={submit} className="rounded-2xl border border-hairline bg-paper p-5 sm:p-6" aria-label={t(initial ? "editTitle" : "createTitle")}>
    <h3 className="font-display text-2xl mb-1">{t(initial ? "editTitle" : "createTitle")}</h3>
    <p className="text-sm text-muted mb-5">{t("formHint")}</p>
    <fieldset disabled={busy} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {field("customerName")}
      <div>
        <label htmlFor={`${formId}-docType`} className="block text-sm text-muted mb-1.5">{t("docType")}</label>
        <select id={`${formId}-docType`} value={values.docType} onChange={e => change("docType", e.target.value)} className={inputClass}>
          {(["CC", "NIT", "CE", "PA"] as const).map(type => <option key={type} value={type}>{t(`documentTypes.${type}`)}</option>)}
        </select>
      </div>
      {field("docNumber", { maxLength: 40, inputMode: values.docType === "CC" ? "numeric" : "text", hint: values.docType === "NIT" ? t("docNumberHintNit") : undefined })}
      {field("email", { type: "email" })}
      {field("phone", { type: "tel", required: false, maxLength: 32 })}
    </fieldset>

    <fieldset disabled={busy} className="mt-6 rounded-xl border border-hairline bg-ivory p-4">
      <legend className="px-1 text-sm font-medium">{t("creditSection")}</legend>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={creditEnabled} onChange={e => setCreditEnabled(e.target.checked)} className="mt-1 h-4 w-4 accent-terracotta" />
        <span><span className="block font-medium">{t("creditEnabled")}</span><span className="block text-xs text-muted mt-0.5">{t("creditEnabledHint")}</span></span>
      </label>
      {creditEnabled && <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        <div>
          <label htmlFor={`${formId}-creditLimit`} className="block text-sm text-muted mb-1.5">{t("creditLimit")}</label>
          <MoneyInput id={`${formId}-creditLimit`} value={creditLimit} onChange={setCreditLimit} className={inputClass} placeholder={t("creditLimitPlaceholder")} />
          <p className="mt-1 text-xs text-muted">{t("creditLimitHint")}</p>
        </div>
        <div>
          <label htmlFor={`${formId}-creditTermsDays`} className="block text-sm text-muted mb-1.5">{t("creditTermsDays")}</label>
          <input id={`${formId}-creditTermsDays`} type="number" min={0} max={3650} step={1} value={creditTermsDays} onChange={e => { setCreditTermsDays(e.target.value); setFieldErrors(p => ({ ...p, creditTermsDays: undefined })); }} className={inputClass} aria-invalid={Boolean(fieldErrors.creditTermsDays)} />
          {Boolean(fieldErrors.creditTermsDays) && <p className="text-xs text-danger mt-1">{t("checkField")}</p>}
        </div>
      </div>}
    </fieldset>

    <fieldset disabled={busy} className="mt-4 rounded-xl border border-hairline bg-ivory p-4">
      <legend className="px-1 text-sm font-medium">{t("discountSection")}</legend>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={discountEnabled} onChange={e => setDiscountEnabled(e.target.checked)} className="mt-1 h-4 w-4 accent-terracotta" />
        <span><span className="block font-medium">{t("discountEnabled")}</span><span className="block text-xs text-muted mt-0.5">{t("discountHint")}</span></span>
      </label>
      {discountEnabled && <div className="mt-4 max-w-xs">
        <label htmlFor={`${formId}-discountPct`} className="block text-sm text-muted mb-1.5">{t("discountPct")}</label>
        <div className="flex items-center gap-2">
          <input id={`${formId}-discountPct`} type="text" inputMode="decimal" value={discountPct} onChange={e => { setDiscountPct(e.target.value); setFieldErrors(p => ({ ...p, discountPct: undefined })); }} className={inputClass} placeholder="10" aria-invalid={Boolean(fieldErrors.discountPct)} />
          <span className="text-sm text-muted">%</span>
        </div>
        {Boolean(fieldErrors.discountPct) && <p className="text-xs text-danger mt-1">{t("discountInvalid")}</p>}
      </div>}
    </fieldset>

    {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap justify-end gap-3 mt-6">
      <button type="button" onClick={onCancel} disabled={busy} className="rounded-full border border-hairline px-5 py-2.5 text-sm disabled:opacity-50">{t("cancel")}</button>
      <button type="submit" disabled={busy} className="rounded-full bg-ink text-bone px-5 py-2.5 text-sm font-medium disabled:opacity-50">{t(busy ? "saving" : initial ? "saveChanges" : "save")}</button>
    </div>
  </form>;
}
