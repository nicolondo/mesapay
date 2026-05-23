"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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
}: {
  tenantSlug: string;
  orderId: string;
  existing: ExistingSummary | null;
}) {
  const [open, setOpen] = useState(false);

  if (existing?.status === "generated") {
    return (
      <div className="rounded-2xl border border-ok/30 bg-ok/10 p-5">
        <div className="font-display text-lg text-ok">
          ✓ Factura electrónica generada
        </div>
        <p className="text-sm text-ink-3 mt-1">
          Te la enviaron al correo <strong>{existing.email}</strong>. Si no la
          encuentras, revisa la carpeta de spam o avísale al restaurante.
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
              Solicitud de factura enviada
            </div>
            <p className="text-sm text-ink-3 mt-1">
              El restaurante la emite manualmente desde su software de
              facturación y te la envía a <strong>{existing.email}</strong>.
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
            Corregir datos
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
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-display text-xl">
              ¿Necesitas factura electrónica?
            </div>
            <p className="text-sm text-muted mt-1">
              Si la quieres a nombre de empresa o con tu cédula, déjanos tus
              datos. El restaurante te la emite y te la envía al correo.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 w-full h-12 rounded-full bg-ink text-bone font-medium"
        >
          Sí, quiero factura electrónica
        </button>
      </div>
      {open && (
        <InvoiceFormSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          initial={null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
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
  const [done, setDone] = useState(false);

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
      setErr(humanError(j));
      return;
    }
    setDone(true);
    router.refresh();
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
        {done ? (
          <div className="p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto flex items-center justify-center font-display text-3xl">
              ✓
            </div>
            <h2 className="font-display text-2xl mt-4">Datos enviados</h2>
            <p className="text-sm text-muted mt-2">
              El restaurante recibirá tu solicitud y emitirá la factura desde
              su sistema. Te llegará a {email} en las próximas horas.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 h-11 px-6 rounded-full bg-ink text-bone text-sm font-medium"
            >
              Cerrar
            </button>
          </div>
        ) : (
          <>
            <div className="p-5 border-b border-hairline flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
                  Datos para factura electrónica
                </div>
                <h2 className="font-display text-2xl mt-1">Tus datos</h2>
              </div>
              <button
                onClick={onClose}
                disabled={busy}
                className="text-muted text-sm shrink-0"
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-4">
              <Field
                label="Nombre o razón social"
                value={customerName}
                onChange={setCustomerName}
                placeholder="Juan Pérez · Restaurante S.A.S"
              />
              <div className="grid grid-cols-3 gap-2">
                <Select
                  label="Tipo"
                  value={docType}
                  onChange={(v) => setDocType(v as DocType)}
                  options={[
                    ["CC", "CC"],
                    ["CE", "CE"],
                    ["NIT", "NIT"],
                    ["PA", "Pasaporte"],
                  ]}
                  className="col-span-1"
                />
                <Field
                  className="col-span-2"
                  label="Número de identificación"
                  value={docNumber}
                  onChange={setDocNumber}
                  type="text"
                  inputMode="numeric"
                />
              </div>
              <Field
                label="Correo electrónico"
                value={email}
                onChange={setEmail}
                type="email"
                placeholder="tu@email.com"
                hint="Aquí te llega la factura"
              />
              <div>
                <label className="block">
                  <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                    Dirección
                  </span>
                  <input
                    ref={addressRef}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Empieza a escribir tu dirección…"
                    className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta"
                  />
                </label>
                <p className="text-[11px] text-muted mt-1">
                  Busca tu dirección y selecciónala — la ciudad y el
                  departamento se llenan solos.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Ciudad" value={city} onChange={setCity} />
                <Field
                  label="Departamento"
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
                {busy ? "Enviando…" : "Enviar al restaurante"}
              </button>
              <p className="text-[11px] text-muted-2 text-center">
                Tus datos solo se comparten con el restaurante para emitir tu
                factura.
              </p>
            </div>
          </>
        )}
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

function humanError(j: { error?: string }): string {
  switch (j.error) {
    case "already_generated":
      return "Ya se generó una factura para este pedido. Contacta al restaurante para correcciones.";
    case "order_not_paid":
      return "El pedido aún no está marcado como pagado.";
    case "order_not_found":
      return "No encontramos este pedido.";
    case "invalid":
      return "Revisa los datos: alguno está incompleto.";
    default:
      return j.error ?? "No pudimos enviar tu solicitud.";
  }
}
