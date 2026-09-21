"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  loadProfiles,
  saveProfile,
  removeProfile,
  type InvoiceProfile,
} from "@/lib/invoiceProfiles";
import { Field, Select } from "./InvoiceFields";
import { CustomerPicker } from "@/components/billingCustomers/CustomerPicker";
import { billingDocument } from "@/components/billingCustomers/types";
import type { DocType, InvoiceRequestSummary } from "./types";

/**
 * Factura PERSONALIZADA: nombre o razón social, documento y correo. No se
 * pide dirección, ciudad ni departamento: la factura electrónica sale sin el
 * bloque de dirección del adquiriente, igual que la de consumidor final.
 * Los datos van al restaurante (`/operator/facturas`), que emite la factura
 * electrónica desde su propio proveedor (Siigo, Alegra, …).
 *
 * Se abre en dos momentos:
 *  - `beforePayment` (checkout): la orden todavía no está paga. Los datos se
 *    guardan igual y la factura sale sola cuando se confirme el cobro — el
 *    backend responde `deferred: true` y acá mostramos ese mensaje en vez del
 *    botón de imprimir.
 *  - después de pagar (/done): la factura imprimible se genera al instante.
 *
 * Claves i18n en el namespace `done` (ver nota en SimpleInvoiceSheet).
 */
export function InvoiceFormSheet({
  tenantSlug,
  orderId,
  initial,
  prefillEmail = null,
  beforePayment = false,
  operatorMode = false,
  onClose,
  onSaved,
}: {
  tenantSlug: string;
  orderId: string;
  /** Solicitud previa de esta misma cuenta, para corregir datos. */
  initial: InvoiceRequestSummary | null;
  prefillEmail?: string | null;
  /** La orden todavía no está paga (se está pidiendo desde el checkout). */
  beforePayment?: boolean;
  operatorMode?: boolean;
  onClose: () => void;
  /** Datos guardados — el caller pinta el resumen / refresca la pantalla. */
  onSaved?: (summary: InvoiceRequestSummary) => void;
}) {
  const t = useTranslations("done");
  const [customerName, setCustomerName] = useState(initial?.customerName ?? "");
  const [docType, setDocType] = useState<DocType>(initial?.docType ?? "CC");
  const [docNumber, setDocNumber] = useState(initial?.docNumber ?? "");
  // Correo: el de una solicitud previa manda; si no, el que tipeó al pagar.
  const [email, setEmail] = useState(initial?.email ?? prefillEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Tras enviar: o la factura imprimible ya generada, o el aviso de que sale
  // cuando se confirme el pago.
  const [done, setDone] = useState<
    { deferred: true; email: string } | { deferred: false; invoiceUrl: string } | null
  >(null);
  // Saved profiles from previous orders on this device (any restaurant).
  // localStorage-only; nothing crosses to the server until the diner picks
  // one and submits it.
  const [profiles, setProfiles] = useState<InvoiceProfile[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  // Load saved profiles on mount. Default to showing the picker if there
  // are any and the form isn't already pre-filled from a prior request on
  // this same order.
  // localStorage sólo existe en el browser: leerlo durante el render rompería
  // la hidratación, así que el efecto-al-montar es el patrón correcto acá
  // (la regla apunta a cascadas de render, no a este caso).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const ps = operatorMode ? [] : loadProfiles();
    setProfiles(ps);
    if (ps.length > 0 && !initial) setShowSaved(true);
  }, [initial, operatorMode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function applyProfile(p: InvoiceProfile) {
    setCustomerName(p.customerName);
    setDocType(p.docType);
    setDocNumber(p.docNumber);
    setEmail(p.email);
    setShowSaved(false);
  }

  function dropProfile(id: string) {
    removeProfile(id);
    setProfiles(loadProfiles());
  }

  const canSubmit =
    !busy &&
    customerName.trim().length >= 2 &&
    docNumber.trim().length >= 4 &&
    /.+@.+\..+/.test(email);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    const payload = {
      customerName: customerName.trim(),
      docType,
      docNumber: docNumber.trim(),
      email: email.trim(),
    };
    const res = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/invoice-request`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      setBusy(false);
      const j = await res.json().catch(() => ({}));
      setErr(humanError(j, t));
      return;
    }
    const j = (await res.json().catch(() => ({}))) as {
      invoiceUrl?: string;
      deferred?: boolean;
    };
    setBusy(false);
    // Remember on this device so the next restaurant gets one-tap fill.
    // Wrapped in try so a storage failure (private mode, full quota) doesn't
    // hide the success state from the user.
    try {
      if (!operatorMode) saveProfile(payload);
    } catch {
      /* ignore */
    }
    onSaved?.({ status: "pending", ...payload });
    if (j.deferred) {
      setDone({ deferred: true, email: payload.email });
    } else if (j.invoiceUrl) {
      setDone({ deferred: false, invoiceUrl: j.invoiceUrl });
    } else {
      onClose();
    }
  }

  // Datos guardados. Dos finales posibles: la factura imprimible ya emitida
  // (cuenta pagada) o el aviso de que sale al confirmarse el cobro.
  if (done) {
    return (
      <div
        className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
        onClick={onClose}
      >
        <div
          className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
                {t("invFormLabel")}
              </div>
              <h2 className="font-display text-2xl mt-1">
                {done.deferred
                  ? t("invDeferredTitle")
                  : t("invGeneratedReady")}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted text-sm shrink-0"
              aria-label={t("close")}
            >
              {"✕"}
            </button>
          </div>
          {done.deferred ? (
            <p className="text-sm text-ink/80">
              {t.rich(operatorMode ? "invDeferredBodyOp" : "invDeferredBody", {
                email: done.email,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          ) : (
            <>
              <p className="text-sm text-ink/80">
                {t("invPersonalizedReadyBody")}
              </p>
              <a
                href={`${done.invoiceUrl}?print=1`}
                target="_blank"
                rel="noreferrer"
                className="block text-center w-full h-12 leading-[3rem] rounded-2xl bg-ink text-bone text-sm font-medium"
              >
                {t("invPrintInvoice")}
              </a>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-full h-10 rounded-2xl border border-hairline text-sm"
          >
            {t("close")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-paper rounded-t-3xl md:rounded-3xl border border-hairline max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-hairline flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
              {t("invFormLabel")}
            </div>
            <h2 className="font-display text-2xl mt-1">
              {t(operatorMode ? "invClientData" : "invYourData")}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        </div>
        <div className="p-5 space-y-4">
          {operatorMode && <CustomerPicker onSelect={customer => {
            setCustomerName(customer.customerName);
            setDocType(customer.docType);
            setDocNumber(billingDocument(customer));
            setEmail(customer.email);
          }} />}
          {showSaved && profiles.length > 0 && (
            <div className="rounded-xl border border-hairline bg-ivory p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                  {t("invSavedOnDevice")}
                </div>
                <button
                  type="button"
                  onClick={() => setShowSaved(false)}
                  className="text-[11px] text-muted hover:text-ink"
                >
                  {t("invWriteNew")}
                </button>
              </div>
              <ul className="space-y-1.5">
                {profiles.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 bg-paper border border-hairline rounded-lg p-2"
                  >
                    <button
                      type="button"
                      onClick={() => applyProfile(p)}
                      className="flex-1 min-w-0 text-left flex items-center gap-2"
                    >
                      <span className="w-8 h-8 rounded-full bg-terracotta text-bone inline-flex items-center justify-center font-display text-sm shrink-0">
                        {p.customerName.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">
                          {p.customerName}
                        </span>
                        <span className="block text-[11px] text-muted truncate">
                          {p.docType} {p.docNumber}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          confirm(t("invForgetConfirm", { name: p.customerName }))
                        )
                          dropProfile(p.id);
                      }}
                      className="text-[11px] text-muted hover:text-danger shrink-0 px-1"
                      aria-label={t("invForget")}
                      title={t("invForgetTitle")}
                    >
                      {"✕"}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-[10px] text-muted-2 mt-2">{t("invSavedHint")}</p>
            </div>
          )}
          {!showSaved && profiles.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSaved(true)}
              className="text-[12px] text-terracotta hover:underline"
            >
              {t("invUseSaved", { count: profiles.length })}
            </button>
          )}

          <Field
            label={t("invName")}
            value={customerName}
            onChange={setCustomerName}
            placeholder={t("invNamePlaceholder")}
          />
          <div className="grid grid-cols-3 gap-2">
            <Select
              label={t("invType")}
              value={docType}
              onChange={(v) => setDocType(v as DocType)}
              options={[
                ["CC", "CC"],
                ["CE", "CE"],
                ["NIT", "NIT"],
                ["PA", t("invPassport")],
              ]}
              className="col-span-1"
            />
            <Field
              className="col-span-2"
              label={t("invDocNumber")}
              value={docNumber}
              onChange={setDocNumber}
              type="text"
              inputMode="numeric"
            />
          </div>
          <Field
            label={t("invEmailLabel")}
            value={email}
            onChange={setEmail}
            type="email"
            placeholder={t("invEmailPlaceholder2")}
            hint={t("invEmailHint")}
          />
          {err && <div className="text-sm text-danger">{err}</div>}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="w-full h-12 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
          >
            {busy
              ? beforePayment
                ? t("invSaving")
                : t("invSending")
              : beforePayment
                ? t("invRequestInvoice")
                : t("invSendToRestaurant")}
          </button>
          <p className="text-[11px] text-muted-2 text-center">
            {t("invPrivacy")}
          </p>
        </div>
      </div>
    </div>
  );
}

function humanError(
  j: { error?: string },
  t: ReturnType<typeof useTranslations>,
): string {
  switch (j.error) {
    case "already_generated":
      return t("invErrAlreadyGenerated");
    case "order_not_found":
      return t("invErrNotFound");
    case "invalid":
      return t("invErrInvalid");
    default:
      return t("invErrGeneric");
  }
}
