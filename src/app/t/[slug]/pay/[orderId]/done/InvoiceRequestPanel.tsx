"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  loadProfiles,
  saveProfile,
  removeProfile,
  type InvoiceProfile,
} from "@/lib/invoiceProfiles";

type DocType = "CC" | "CE" | "NIT" | "PA";

type ExistingSummary = {
  status: "pending" | "generated" | "rejected";
  customerName: string;
  docType: DocType;
  docNumber: string;
  email: string;
  address: string;
  city: string;
  department: string;
};

/**
 * Post-payment electronic-invoice request. The diner taps "Necesito factura
 * electrónica" and fills a form; the data lands at the restaurant's
 * /operator/facturas page so the cashier can emit it from their own
 * invoicing software (Siigo/Alegra/etc.). We don't push to DIAN directly
 * — each restaurant uses their own provider.
 */
export function InvoiceRequestPanel({
  tenantSlug,
  orderId,
  existing,
  operatorMode = false,
}: {
  tenantSlug: string;
  orderId: string;
  existing: ExistingSummary | null;
  // En modo mesero (cobra por el cliente) la copia va en tercera persona.
  operatorMode?: boolean;
}) {
  const t = useTranslations("done");
  const [open, setOpen] = useState(false);
  // Sheet para la "tirilla simple" — flujo independiente del formal.
  const [simpleOpen, setSimpleOpen] = useState(false);

  if (existing?.status === "generated") {
    return (
      <div className="rounded-2xl border border-ok/30 bg-ok/10 p-5">
        <div className="font-display text-lg text-ok">
          {"✓"} {t("invGeneratedTitle")}
        </div>
        <p className="text-sm text-ink-3 mt-1">
          {t.rich("invGeneratedBody", {
            email: existing.email,
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </div>
    );
  }

  if (existing?.status === "pending") {
    return (
      <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-display text-lg text-[#7F5A1F]">
              {t("invPendingTitle")}
            </div>
            <p className="text-sm text-ink-3 mt-1">
              {t.rich("invPendingBody", {
                email: existing.email,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <div className="text-xs text-ink-3 mt-3">
              <div>
                <strong>{existing.customerName}</strong> · {existing.docType}{" "}
                {existing.docNumber}
              </div>
              <div className="mt-0.5">
                {existing.address}, {existing.city}, {existing.department}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 h-9 px-3 rounded-full border border-[#7F5A1F]/40 text-[#7F5A1F] text-xs font-medium hover:bg-[#C98A2E]/10"
          >
            {t("invCorrectData")}
          </button>
        </div>
        {open && (
          <InvoiceFormSheet
            tenantSlug={tenantSlug}
            orderId={orderId}
            initial={existing}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="rounded-2xl border border-hairline bg-paper p-5">
        <div className="font-display text-xl">
          {t(operatorMode ? "invNeedReceiptOp" : "invNeedReceipt")}
        </div>
        <p className="text-sm text-muted mt-1">
          {t(operatorMode ? "invReceiptIntroOp" : "invReceiptIntro")}
        </p>
        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => setSimpleOpen(true)}
            className="w-full h-12 rounded-full bg-ink text-bone font-medium"
          >
            {t(operatorMode ? "invSendEmailOp" : "invSendEmail")}
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full h-11 rounded-full border border-hairline bg-paper text-ink text-sm font-medium"
          >
            {t(operatorMode ? "invToNameOp" : "invToName")}
          </button>
        </div>
      </div>
      {open && (
        <InvoiceFormSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          initial={null}
          onClose={() => setOpen(false)}
        />
      )}
      {simpleOpen && (
        <SimpleInvoiceSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          onClose={() => setSimpleOpen(false)}
        />
      )}
    </>
  );
}

// "Factura simple" — solo email, auto-envío. Distinto del flow
// formal (InvoiceFormSheet) que pide nombre/NIT/dirección.
function SimpleInvoiceSheet({
  tenantSlug,
  orderId,
  onClose,
}: {
  tenantSlug: string;
  orderId: string;
  onClose: () => void;
}) {
  const t = useTranslations("done");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{
    invoiceUrl: string;
    email: string;
  } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const mail = email.trim();
    // Correo OPCIONAL: solo se valida si se escribió algo. Sin correo, la
    // factura igual se genera para imprimir/descargar.
    if (mail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setErr(t("invErrEmail"));
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/simple-invoice`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: mail }),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.message ?? j.error ?? t("invErrGenerate"));
      return;
    }
    const j = (await r.json()) as { invoiceUrl: string };
    setDone({ invoiceUrl: j.invoiceUrl, email: mail });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {t("invSimpleLabel")}
            </div>
            <h2 className="font-display text-2xl mt-1">
              {done
                ? done.email
                  ? t("invSentTitle")
                  : t("invGeneratedReady")
                : t("invYourReceipt")}
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

        {done ? (
          <>
            <p className="text-sm text-ink/80">
              {done.email ? (
                t.rich("invSentBody", {
                  email: done.email,
                  b: (chunks) => <strong>{chunks}</strong>,
                })
              ) : (
                <span>{t("invGeneratedReadyBody")}</span>
              )}
            </p>
            <a
              href={`${done.invoiceUrl}?print=1`}
              target="_blank"
              rel="noreferrer"
              className="block text-center w-full h-12 leading-[3rem] rounded-2xl bg-ink text-bone text-sm font-medium"
            >
              {t("invPrintInvoice")}
            </a>
            <button
              type="button"
              onClick={onClose}
              className="w-full h-10 rounded-2xl border border-hairline text-sm"
            >
              {t("close")}
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-sm text-muted">{t("invSimpleIntro")}</p>
            <label className="block">
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
                {t("invEmailFieldOptional")}
              </div>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("invEmailPlaceholder")}
                className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
              />
            </label>
            {err && <div className="text-xs text-danger">{err}</div>}
            <button
              type="submit"
              disabled={busy}
              className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium disabled:opacity-50"
            >
              {busy ? t("invGenerating") : t("invGenerateInvoice")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InvoiceFormSheet({
  tenantSlug,
  orderId,
  initial,
  onClose,
}: {
  tenantSlug: string;
  orderId: string;
  initial: ExistingSummary | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useTranslations("done");
  const [customerName, setCustomerName] = useState(initial?.customerName ?? "");
  const [docType, setDocType] = useState<DocType>(initial?.docType ?? "CC");
  const [docNumber, setDocNumber] = useState(initial?.docNumber ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [department, setDepartment] = useState(initial?.department ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [rawComponents, setRawComponents] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Saved profiles from previous orders on this device (any restaurant).
  // localStorage-only; nothing crosses to the server until the diner picks
  // one and submits it.
  const [profiles, setProfiles] = useState<InvoiceProfile[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  // Load saved profiles on mount. Default to showing the picker if there
  // are any and the form isn't already pre-filled from a prior request on
  // this same order.
  useEffect(() => {
    const ps = loadProfiles();
    setProfiles(ps);
    if (ps.length > 0 && !initial) setShowSaved(true);
  }, [initial]);

  function applyProfile(p: InvoiceProfile) {
    setCustomerName(p.customerName);
    setDocType(p.docType);
    setDocNumber(p.docNumber);
    setEmail(p.email);
    setAddress(p.address);
    setCity(p.city);
    setDepartment(p.department);
    setPlaceId(p.placeId ?? null);
    setRawComponents(p.rawComponents ?? null);
    setShowSaved(false);
  }

  function dropProfile(id: string) {
    removeProfile(id);
    setProfiles(loadProfiles());
  }

  const addressRef = useRef<HTMLInputElement | null>(null);
  // Track the Maps Autocomplete instance to clean up on close. Without a
  // ref we leak listeners every time the sheet reopens.
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  // Lazy-load the Google Maps Places library and attach Autocomplete to the
  // address input. Restricted to Colombia and biased to address-type results.
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return;

    function attach() {
      if (!addressRef.current || !window.google?.maps?.places) return;
      const ac = new window.google.maps.places.Autocomplete(addressRef.current, {
        types: ["address"],
        componentRestrictions: { country: "co" },
        fields: [
          "address_components",
          "formatted_address",
          "place_id",
          "geometry",
        ],
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const comps = place.address_components ?? [];
        let route = "";
        let streetNumber = "";
        let cityVal = "";
        let deptVal = "";
        for (const c of comps) {
          if (c.types.includes("street_number")) streetNumber = c.long_name;
          else if (c.types.includes("route")) route = c.long_name;
          else if (
            c.types.includes("locality") ||
            c.types.includes("postal_town") ||
            c.types.includes("administrative_area_level_2")
          ) {
            // Locality is the city in CO. Some Google results put the city
            // under admin level 2 (e.g. small towns), so fall back.
            if (!cityVal) cityVal = c.long_name;
          } else if (c.types.includes("administrative_area_level_1")) {
            deptVal = c.long_name;
          }
        }
        const composed =
          place.formatted_address ??
          [route, streetNumber].filter(Boolean).join(" ");
        if (composed) setAddress(composed);
        if (cityVal) setCity(cityVal);
        if (deptVal) setDepartment(deptVal);
        if (place.place_id) setPlaceId(place.place_id);
        setRawComponents(comps);
      });
      autocompleteRef.current = ac;
    }

    if (window.google?.maps?.places) {
      attach();
      return;
    }

    // Avoid loading the script twice across the app lifecycle.
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-google-maps="true"]',
    );
    if (existing) {
      existing.addEventListener("load", attach);
      return () => existing.removeEventListener("load", attach);
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey,
    )}&libraries=places&language=es&region=CO`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMaps = "true";
    script.onload = attach;
    document.head.appendChild(script);
  }, []);

  // Unbind the listener when the sheet closes so the next mount starts clean.
  useEffect(() => {
    return () => {
      if (autocompleteRef.current && window.google?.maps?.event) {
        window.google.maps.event.clearInstanceListeners(autocompleteRef.current);
        autocompleteRef.current = null;
      }
    };
  }, []);

  const canSubmit =
    !busy &&
    customerName.trim().length >= 2 &&
    docNumber.trim().length >= 4 &&
    address.trim().length >= 4 &&
    city.trim().length >= 2 &&
    department.trim().length >= 2 &&
    /.+@.+\..+/.test(email);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/invoice-request`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerName: customerName.trim(),
          docType,
          docNumber: docNumber.trim(),
          address: address.trim(),
          city: city.trim(),
          department: department.trim(),
          email: email.trim(),
          placeId: placeId ?? undefined,
          rawComponents,
        }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(humanError(j, t));
      return;
    }
    // Remember on this device so the next restaurant gets one-tap fill.
    // Wrapped in try so a storage failure (private mode, full quota) doesn't
    // hide the success state from the user.
    try {
      saveProfile({
        customerName: customerName.trim(),
        docType,
        docNumber: docNumber.trim(),
        email: email.trim(),
        address: address.trim(),
        city: city.trim(),
        department: department.trim(),
        placeId,
        rawComponents,
      });
    } catch {
      /* ignore */
    }
    // Cierra el sheet de una — el banner "Solicitud de factura enviada" de
    // la página (estado pending tras el refresh) confirma el envío.
    router.refresh();
    onClose();
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
        <>
            <div className="p-5 border-b border-hairline flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
                  {t("invFormLabel")}
                </div>
                <h2 className="font-display text-2xl mt-1">{t("invYourData")}</h2>
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
                              {p.docType} {p.docNumber} ·{" "}
                              {p.address.split(",")[0]}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              confirm(
                                t("invForgetConfirm", { name: p.customerName }),
                              )
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
                  <p className="text-[10px] text-muted-2 mt-2">
                    {t("invSavedHint")}
                  </p>
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
              <div>
                <label className="block">
                  <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                    {t("invAddress")}
                  </span>
                  <input
                    ref={addressRef}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder={t("invAddressPlaceholder")}
                    className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta"
                  />
                </label>
                <p className="text-[11px] text-muted mt-1">{t("invAddressHint")}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("invCity")} value={city} onChange={setCity} />
                <Field
                  label={t("invDepartment")}
                  value={department}
                  onChange={setDepartment}
                />
              </div>
              {err && <div className="text-sm text-danger">{err}</div>}
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="w-full h-12 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
              >
                {busy ? t("invSending") : t("invSendToRestaurant")}
              </button>
              <p className="text-[11px] text-muted-2 text-center">
                {t("invPrivacy")}
              </p>
            </div>
        </>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type,
  placeholder,
  hint,
  inputMode,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  inputMode?: "text" | "numeric" | "email" | "tel";
  className?: string;
}) {
  return (
    <label className={"block " + (className ?? "")}>
      <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
        {label}
      </span>
      <input
        type={type ?? "text"}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta"
      />
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  className?: string;
}) {
  return (
    <label className={"block " + (className ?? "")}>
      <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function humanError(
  j: { error?: string },
  t: ReturnType<typeof useTranslations>,
): string {
  switch (j.error) {
    case "already_generated":
      return t("invErrAlreadyGenerated");
    case "order_not_paid":
      return t("invErrNotPaid");
    case "order_not_found":
      return t("invErrNotFound");
    case "invalid":
      return t("invErrInvalid");
    default:
      return j.error ?? t("invErrGeneric");
  }
}
