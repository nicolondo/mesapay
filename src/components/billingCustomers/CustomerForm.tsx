"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { MunicipioAutocomplete } from "@/components/MunicipioAutocomplete";
import type { BillingCustomerRecord } from "./types";

const inputClass = "w-full min-w-0 rounded-xl border border-hairline bg-ivory px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-terracotta/40";

export function CustomerForm({ initial, onSaved, onCancel }: {
  initial: BillingCustomerRecord | null;
  onSaved: (customer: BillingCustomerRecord) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("billingCustomers");
  const formId = useId();
  const [values, setValues] = useState({
    customerName: initial?.customerName ?? "", docType: initial?.docType ?? "CC",
    docNumber: initial?.docNumber ?? "", verificationDigit: initial?.verificationDigit ?? "",
    email: initial?.email ?? "", phone: initial?.phone ?? "", address: initial?.address ?? "",
  });
  const [municipio, setMunicipio] = useState(initial ? {
    code: initial.municipalityCode, label: `${initial.city}, ${initial.department}`, deptName: initial.department,
  } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, unknown>>({});
  function change(field: keyof typeof values, value: string) {
    setValues(previous => ({ ...previous, [field]: value }));
    setFieldErrors(previous => ({ ...previous, [field]: undefined }));
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!municipio) { setError(t("municipalityRequired")); return; }
    setBusy(true); setError(""); setFieldErrors({});
    try {
      const response = await fetch(initial ? `/api/operator/billing-customers/${initial.id}` : "/api/operator/billing-customers", {
        method: initial ? "PATCH" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, verificationDigit: values.docType === "NIT" ? values.verificationDigit : null, municipalityCode: municipio.code }),
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
  function field(key: Exclude<keyof typeof values, "docType">, options: { type?: string; required?: boolean; maxLength?: number; inputMode?: "text" | "numeric" | "tel" } = {}) {
    const invalid = Boolean(fieldErrors[key]);
    return <div key={key} className={key === "customerName" || key === "address" ? "sm:col-span-2" : ""}>
      <label htmlFor={`${formId}-${key}`} className="block text-sm text-muted mb-1.5">{t(key)}</label>
      <input id={`${formId}-${key}`} name={key} value={values[key]} onChange={e => change(key, e.target.value)} type={options.type ?? "text"} required={options.required ?? true} maxLength={options.maxLength ?? 160} inputMode={options.inputMode} className={inputClass} aria-invalid={invalid} aria-describedby={invalid ? `${formId}-${key}-error` : undefined} />
      {invalid && <p id={`${formId}-${key}-error`} className="text-xs text-danger mt-1">{t("checkField")}</p>}
    </div>;
  }
  return <form onSubmit={submit} className="rounded-2xl border border-hairline bg-paper p-5 sm:p-6" aria-label={t(initial ? "editTitle" : "createTitle")}>
    <h3 className="font-display text-2xl mb-1">{t(initial ? "editTitle" : "createTitle")}</h3>
    <p className="text-sm text-muted mb-5">{t("formHint")}</p>
    <fieldset disabled={busy} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {field("customerName")}
      <div>
        <label htmlFor={`${formId}-docType`} className="block text-sm text-muted mb-1.5">{t("docType")}</label>
        <select id={`${formId}-docType`} value={values.docType} onChange={e => { change("docType", e.target.value); change("verificationDigit", ""); }} className={inputClass}>
          {(["CC", "NIT", "CE", "PA"] as const).map(type => <option key={type} value={type}>{t(`documentTypes.${type}`)}</option>)}
        </select>
      </div>
      {field("docNumber", { maxLength: 40, inputMode: values.docType === "CC" ? "numeric" : "text" })}
      {values.docType === "NIT" && <div className="sm:col-span-2">
        <div className="max-w-xs">{field("verificationDigit", { required: false, maxLength: 1, inputMode: "numeric" })}</div>
        <p className="mt-1 text-xs text-muted">{t("dvHint")}</p>
      </div>}
      {field("email", { type: "email" })}
      {field("phone", { type: "tel", required: false, maxLength: 32 })}
      {field("address", { maxLength: 240 })}
      <div>
        <label htmlFor={`${formId}-municipio`} className="block text-sm text-muted mb-1.5">{t("municipality")}</label>
        <MunicipioAutocomplete id={`${formId}-municipio`} value={municipio} onChange={setMunicipio} disabled={busy} required showCode={false} inputClassName={inputClass} />
      </div>
      <div>
        <label htmlFor={`${formId}-department`} className="block text-sm text-muted mb-1.5">{t("department")}</label>
        <input id={`${formId}-department`} value={municipio?.deptName ?? ""} readOnly className={`${inputClass} text-muted`} />
      </div>
    </fieldset>
    {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap justify-end gap-3 mt-6">
      <button type="button" onClick={onCancel} disabled={busy} className="rounded-full border border-hairline px-5 py-2.5 text-sm disabled:opacity-50">{t("cancel")}</button>
      <button type="submit" disabled={busy} className="rounded-full bg-ink text-bone px-5 py-2.5 text-sm font-medium disabled:opacity-50">{t(busy ? "saving" : initial ? "saveChanges" : "save")}</button>
    </div>
  </form>;
}
