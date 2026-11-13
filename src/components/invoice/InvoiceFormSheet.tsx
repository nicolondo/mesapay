"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  loadProfiles,
  saveProfile,
  removeProfile,
  type InvoiceProfile,
} from "@/lib/invoiceProfiles";
import { Field, Select } from "./InvoiceFields";
import { ExtraEmailsField } from "./ExtraEmailsField";
import { CustomerPicker } from "@/components/billingCustomers/CustomerPicker";
import { billingDocument, type BillingCustomerRecord } from "@/components/billingCustomers/types";
import type { DocType, InvoiceRequestSummary } from "./types";
import { StaffPrintButton } from "@/components/print/StaffPrintButton";
import {
  invoicePrintHref,
  type StaffPrintAccess,
} from "@/lib/print/staffPrint";
import { MAX_INVOICE_EMAILS } from "@/lib/invoiceEmails";

/**
 * Factura PERSONALIZADA: nombre o razón social, documento y correo. No se
 * pide dirección, ciudad ni departamento: la factura electrónica sale sin el
 * bloque de dirección del adquiriente, igual que la de consumidor final.
 * El documento es SÓLO el número, sin dígito de verificación: el servidor lo
 * normaliza (y a la DIAN le llega el DV calculado); el resumen que queda en
 * pantalla es el que el servidor guardó, no lo tecleado.
 *
 * PRIMERO EL DOCUMENTO ("Recordar mis datos", src/lib/invoiceCustomerMemory.ts):
 *  1. `doc`: tipo y número. Se busca en los clientes guardados de ESTE
 *     comercio.
 *  2. Comensal y encontrado → `found`: sólo ve su nombre y correo
 *     ENMASCARADOS para reconocerlos, con "Usar estos datos" (la factura se
 *     arma en el servidor con un token de un solo uso; nada de los datos
 *     completos llega al celular) o "Cambiar mis datos".
 *     Personal y encontrado → `form` con TODO cargado para revisar/corregir.
 *  3. No encontrado → `form`, como siempre.
 * En el formulario, la casilla "Recordar mis datos" (marcada por defecto,
 * fácil de desmarcar) con el enlace a la política de privacidad. El
 * personal además puede agregar correos adicionales (la factura sale a
 * todos; ver src/lib/invoiceEmails.ts).
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

type Step = "doc" | "found" | "form";

/** Lo que el comensal ve de un cliente guardado: enmascarado. */
type SavedMatch = { token: string; name: string; email: string };

type Done =
  | { kind: "deferred"; email: string }
  | { kind: "ready"; invoiceUrl: string }
  /** Con datos guardados: ya salió al correo guardado (el comensal no ve la factura). */
  | { kind: "sent"; email: string };

export function InvoiceFormSheet({
  tenantSlug,
  orderId,
  initial,
  prefillEmail = null,
  beforePayment = false,
  operatorMode = false,
  staffPrint = null,
  closeOnSave = false,
  onClose,
  onSaved,
}: {
  /**
   * Quien mira es STAFF (verificado por el server): "Imprimir factura" sale
   * por el agente, como las comandas. null (el comensal): abre la vista.
   */
  staffPrint?: StaffPrintAccess | null;
  /**
   * Cerrar apenas se guarda, sin la pantalla de "listo". Lo usa la factura
   * ANTES de cobrar (`PreInvoiceAction`): los datos son del cliente de la
   * factura que se va a emitir ya, no una solicitud que "llega al pagar".
   */
  closeOnSave?: boolean;
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
  const router = useRouter();
  const rememberId = useId();
  // Una solicitud previa con datos a la vista abre directo el formulario
  // para corregir. Una ENMASCARADA (armada con datos guardados) no se
  // precarga: se vuelve a empezar por el documento.
  const editable = initial && !initial.masked ? initial : null;
  const [step, setStep] = useState<Step>(editable ? "form" : "doc");
  const [customerName, setCustomerName] = useState(editable?.customerName ?? "");
  // Cliente de facturación elegido en el selector o encontrado por
  // documento (staff). Se manda con la solicitud para ligar la cuenta al
  // cliente y aplicar su descuento; si el mesero retoca el documento a
  // mano, deja de ser "ese" cliente.
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(null);
  const [loadedSaved, setLoadedSaved] = useState(false);
  const [docType, setDocType] = useState<DocType>(initial?.docType ?? "CC");
  const [docNumber, setDocNumber] = useState(initial?.docNumber ?? "");
  // Correo: el de una solicitud previa manda; si no, el que tipeó al pagar.
  const [email, setEmail] = useState(editable?.email ?? (initial?.masked ? "" : (prefillEmail ?? "")));
  const [ccEmails, setCcEmails] = useState<string[]>(editable?.ccEmails ?? []);
  const [ccInvalidIndex, setCcInvalidIndex] = useState<number | null>(null);
  // "Recordar mis datos": marcada por defecto, visible y fácil de desmarcar.
  const [remember, setRemember] = useState(true);
  const [match, setMatch] = useState<SavedMatch | null>(null);
  const [restaurantName, setRestaurantName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Tras enviar: la factura imprimible ya generada, el aviso de que sale
  // cuando se confirme el pago, o (datos guardados) que ya salió al correo.
  const [done, setDone] = useState<Done | null>(null);
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
    setErr(null);
    setStep("form");
  }

  function dropProfile(id: string) {
    removeProfile(id);
    setProfiles(loadProfiles());
  }

  function applyCustomer(customer: BillingCustomerRecord) {
    setCustomerName(customer.customerName);
    setDocType(customer.docType);
    setDocNumber(billingDocument(customer));
    setEmail(customer.email);
    setCcEmails(customer.ccEmails ?? []);
    setPickedCustomerId(customer.id);
    setLoadedSaved(true);
    setErr(null);
    setStep("form");
  }

  const canLookup = !busy && docNumber.trim().length >= 4;
  const canSubmit =
    !busy &&
    customerName.trim().length >= 2 &&
    docNumber.trim().length >= 4 &&
    /.+@.+\..+/.test(email);

  /** Paso 1: buscar el documento en los clientes guardados de este comercio. */
  async function lookup() {
    if (!canLookup) return;
    setBusy(true);
    setErr(null);
    setMatch(null);
    const body = JSON.stringify({ docType, docNumber: docNumber.trim() });
    try {
      if (operatorMode) {
        // El personal ve el registro completo (mismos permisos que Clientes).
        const res = await fetch("/api/operator/billing-customers/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const j = (await res.json().catch(() => ({}))) as { customer?: BillingCustomerRecord | null; code?: string };
        if (res.status === 400 && j.code) {
          setErr(humanError(j, t));
          return;
        }
        if (res.ok && j.customer) {
          applyCustomer(j.customer);
          return;
        }
        // No está guardado (o este rol no ve Clientes): formulario de siempre.
        setStep("form");
        return;
      }
      const res = await fetch(
        `/api/tenant/${tenantSlug}/orders/${orderId}/invoice-customer`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
      );
      const j = (await res.json().catch(() => ({}))) as {
        match?: SavedMatch | null;
        restaurantName?: string;
        error?: string;
        code?: string;
      };
      if (j.restaurantName) setRestaurantName(j.restaurantName);
      if (res.status === 400 && j.code) {
        setErr(humanError(j, t));
        return;
      }
      if (res.ok && j.match) {
        setMatch(j.match);
        setStep("found");
        return;
      }
      if (res.status === 429) setErr(t("invErrLookupLimited"));
      setStep("form");
    } catch {
      setStep("form");
    } finally {
      setBusy(false);
    }
  }

  /** Lo que el servidor guardó: identificación normalizada y, con datos guardados, enmascarada. */
  type SavedResponse = {
    invoiceUrl?: string | null;
    deferred?: boolean;
    sentToSaved?: boolean;
    request?: Partial<InvoiceRequestSummary>;
    discount?: { applied: boolean; changed?: boolean } | null;
    error?: string;
    code?: string;
    index?: number;
  };

  async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; j: SavedResponse }> {
    const res = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/invoice-request`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const j = (await res.json().catch(() => ({}))) as SavedResponse;
    return { ok: res.ok, status: res.status, j };
  }

  /** "Usar estos datos" (comensal): el servidor arma la factura con el registro guardado. */
  async function applySaved() {
    if (!match || busy) return;
    setBusy(true);
    setErr(null);
    const { ok, j } = await post({ savedCustomerToken: match.token, docType, docNumber: docNumber.trim() });
    setBusy(false);
    if (!ok) {
      if (j.error === "saved_customer_expired") {
        // Token vencido o ya usado: se vuelve a buscar por documento.
        setMatch(null);
        setStep("doc");
        setErr(t("invErrSavedExpired"));
        return;
      }
      if (j.error === "saved_customer_invalid") {
        setMatch(null);
        setStep("form");
        setErr(t("invErrSavedInvalid"));
        return;
      }
      setErr(humanError(j, t));
      return;
    }
    const summary: InvoiceRequestSummary = {
      status: "pending",
      customerName: j.request?.customerName ?? match.name,
      docType,
      docNumber: j.request?.docNumber ?? docNumber.trim(),
      email: j.request?.email ?? match.email,
      masked: true,
    };
    onSaved?.(summary);
    if (closeOnSave) {
      onClose();
      return;
    }
    if (j.deferred) setDone({ kind: "deferred", email: summary.email });
    else if (j.sentToSaved) setDone({ kind: "sent", email: summary.email });
    else onClose();
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    setCcInvalidIndex(null);
    const payload = {
      customerName: customerName.trim(),
      docType,
      docNumber: docNumber.trim(),
      email: email.trim(),
    };
    const { ok, j } = await post({
      ...payload,
      rememberCustomer: remember,
      // Los correos adicionales los maneja el personal; el comensal no los
      // ve ni los manda (y así no se tocan los que ya estuvieran guardados).
      ...(operatorMode ? { ccEmails: ccEmails.map((e) => e.trim()).filter(Boolean) } : {}),
      ...(operatorMode && pickedCustomerId ? { billingCustomerId: pickedCustomerId } : {}),
    });
    if (!ok) {
      setBusy(false);
      if (j.code === "invalid_email" && typeof j.index === "number") setCcInvalidIndex(j.index);
      setErr(humanError(j, t));
      return;
    }
    setBusy(false);
    // El descuento del cliente cambió lo cobrable: la pantalla de cobro
    // (server component) tiene que releer los totales.
    if (j.discount?.applied && j.discount.changed) router.refresh();
    // Remember on this device so the next restaurant gets one-tap fill —
    // salvo que haya pedido NO recordar sus datos. Wrapped in try so a
    // storage failure (private mode, full quota) doesn't hide the success
    // state from the user.
    try {
      if (!operatorMode && remember) saveProfile(payload);
    } catch {
      /* ignore */
    }
    // Lo que el servidor guardó (identificación normalizada) manda sobre lo
    // tecleado.
    onSaved?.({
      status: "pending",
      customerName: j.request?.customerName ?? payload.customerName,
      docType: j.request?.docType ?? payload.docType,
      docNumber: j.request?.docNumber ?? payload.docNumber,
      email: j.request?.email ?? payload.email,
      ccEmails: j.request?.ccEmails ?? [],
    });
    if (closeOnSave) {
      onClose();
      return;
    }
    if (j.deferred) {
      setDone({ kind: "deferred", email: payload.email });
    } else if (j.invoiceUrl) {
      setDone({ kind: "ready", invoiceUrl: j.invoiceUrl });
    } else {
      onClose();
    }
  }

  // Datos guardados. Tres finales posibles: la factura imprimible ya emitida
  // (cuenta pagada), el aviso de que sale al confirmarse el cobro, o (datos
  // guardados) que ya salió al correo guardado.
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
                {done.kind === "deferred"
                  ? t("invDeferredTitle")
                  : done.kind === "sent"
                    ? t("invSentTitle")
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
          {done.kind === "deferred" ? (
            <p className="text-sm text-ink/80">
              {t.rich(operatorMode ? "invDeferredBodyOp" : "invDeferredBody", {
                email: done.email,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          ) : done.kind === "sent" ? (
            <p className="text-sm text-ink/80">
              {t.rich("invSentBody", {
                email: done.email,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          ) : (
            <>
              <p className="text-sm text-ink/80">
                {t("invPersonalizedReadyBody")}
              </p>
              {staffPrint ? (
                <div className="space-y-1">
                  <StaffPrintButton
                    doc={{
                      kind: "invoice",
                      orderId,
                      href: invoicePrintHref({ invoiceUrl: done.invoiceUrl }),
                    }}
                    label={t("invPrintInvoice")}
                    canConfigurePrinters={staffPrint.canConfigurePrinters}
                    className="block text-center w-full h-12 rounded-2xl bg-ink text-bone text-sm font-medium disabled:opacity-60"
                    statusClassName="block text-xs leading-snug"
                  />
                </div>
              ) : (
                // El comensal: abre la vista para imprimirla en SU equipo.
                // Nunca encola en el local (ver `staffPrint.ts`).
                <a
                  href={`${done.invoiceUrl}?print=1`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-center w-full h-12 leading-[3rem] rounded-2xl bg-ink text-bone text-sm font-medium"
                >
                  {t("invPrintInvoice")}
                </a>
              )}
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

  const docFields = (
    <div className="grid grid-cols-3 gap-2">
      <Select
        label={t("invType")}
        value={docType}
        onChange={(v) => { setDocType(v as DocType); setPickedCustomerId(null); setLoadedSaved(false); }}
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
        onChange={(v) => { setDocNumber(v); setPickedCustomerId(null); setLoadedSaved(false); }}
        type="text"
        inputMode={docType === "CC" ? "numeric" : "text"}
        hint={docType === "NIT" ? t("invNitHint") : undefined}
      />
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      // El staff (`operatorMode`) digita los datos por el cliente: ahí tocar
      // afuera NO cierra, porque un clic perdido los borraba. Al comensal le
      // sigue cerrando como siempre.
      onClick={operatorMode ? undefined : onClose}
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
              {step === "found"
                ? t("invFoundTitle")
                : t(operatorMode ? "invClientData" : "invYourData")}
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

        {step === "doc" && (
          <form
            className="p-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup();
            }}
          >
            {operatorMode && <CustomerPicker onSelect={applyCustomer} />}
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
            <p className="text-sm text-muted">
              {t(operatorMode ? "invDocFirstIntroOp" : "invDocFirstIntro")}
            </p>
            {docFields}
            {err && <div role="alert" className="text-sm text-danger">{err}</div>}
            <button
              type="submit"
              disabled={!canLookup}
              className="w-full h-12 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
            >
              {busy ? t("invSearching") : t("invContinue")}
            </button>
          </form>
        )}

        {step === "found" && match && (
          <div className="p-5 space-y-4">
            <p className="text-sm text-muted">{t("invFoundBody")}</p>
            <div className="rounded-xl border border-hairline bg-ivory p-4">
              <div className="text-base font-medium break-words">{match.name}</div>
              <div className="text-sm text-muted mt-1 break-words">
                {docType} {docNumber.trim()}
              </div>
              <div className="text-sm text-muted break-words">{match.email}</div>
            </div>
            {err && <div role="alert" className="text-sm text-danger">{err}</div>}
            <button
              type="button"
              onClick={() => void applySaved()}
              disabled={busy}
              className="w-full h-12 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
            >
              {busy ? t("invSaving") : t("invUseTheseData")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMatch(null);
                setErr(null);
                setStep("form");
              }}
              disabled={busy}
              className="w-full h-11 rounded-full border border-hairline text-sm font-medium"
            >
              {t("invChangeMyData")}
            </button>
            <p className="text-[11px] text-muted-2 text-center">{t("invPrivacy")}</p>
          </div>
        )}

        {step === "form" && (
          <div className="p-5 space-y-4">
            {loadedSaved && (
              <p role="status" className="rounded-lg bg-ok/10 text-ok text-xs px-3 py-2">
                {t("invSavedCustomerLoaded")}
              </p>
            )}
            <Field
              label={t("invName")}
              value={customerName}
              onChange={setCustomerName}
              placeholder={t("invNamePlaceholder")}
            />
            {docFields}
            <Field
              label={t("invEmailLabel")}
              value={email}
              onChange={setEmail}
              type="email"
              placeholder={t("invEmailPlaceholder2")}
              hint={t(operatorMode ? "invEmailHintOp" : "invEmailHint")}
            />
            {operatorMode && (
              <ExtraEmailsField
                value={ccEmails}
                onChange={(next) => {
                  setCcEmails(next);
                  setCcInvalidIndex(null);
                }}
                invalidIndex={ccInvalidIndex}
                disabled={busy}
              />
            )}
            <div className="rounded-xl border border-hairline bg-ivory p-3">
              <label htmlFor={rememberId} className="flex items-start gap-3 text-sm">
                <input
                  id={rememberId}
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-terracotta"
                />
                <span>
                  {operatorMode
                    ? t("invRememberOp")
                    : restaurantName
                      ? t("invRemember", { restaurant: restaurantName })
                      : t("invRememberGeneric")}
                </span>
              </label>
              <p className="text-[11px] text-muted mt-1.5 pl-8">
                {t.rich(operatorMode ? "invRememberPolicyOp" : "invRememberPolicy", {
                  link: (chunks) => (
                    <a
                      href="/privacidad"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-ink"
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </p>
            </div>
            {err && <div role="alert" className="text-sm text-danger">{err}</div>}
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
        )}
      </div>
    </div>
  );
}

function humanError(
  j: { error?: string; code?: string; index?: number },
  t: ReturnType<typeof useTranslations>,
): string {
  // El servidor distingue el documento mal escrito del DV que no
  // corresponde: son dos correcciones distintas para quien está tecleando.
  if (j.code === "invalid_verification_digit") return t("invErrVerificationDigit");
  if (j.code === "invalid_document") return t("invErrDocument");
  if (j.code === "invalid_email") return t("invErrExtraEmail", { n: (j.index ?? 0) + 1 });
  if (j.code === "too_many_emails") return t("invErrTooManyEmails", { max: MAX_INVOICE_EMAILS });
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
