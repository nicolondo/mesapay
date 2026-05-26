"use client";

import { useRef, useState } from "react";

type Identidad = {
  // Nombre comercial — display público + sender de los correos
  // ("NOMBRE · MESAPAY <facturas@mesapay.co>"). Distinto de
  // legalName (razón social) que aparece dentro de la tirilla.
  name: string;
  logoUrl: string | null;
  legalName: string | null;
  taxId: string | null;
  legalAddress: string | null;
  legalCity: string | null;
  legalPhone: string | null;
  dianResolution: string | null;
  dianResolutionFrom: number | null;
  dianResolutionTo: number | null;
  dianResolutionDate: string | null; // YYYY-MM-DD
  invoicePrefix: string | null;
  // Próximo consecutivo a emitir. Default 1; el operador puede
  // ajustar si ya venía emitiendo en otra plataforma o quiere
  // arrancar desde dianResolutionFrom.
  invoiceNextNumber: number;
};

export function IdentidadClient({ initial }: { initial: Identidad }) {
  const [v, setV] = useState<Identidad>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof Identidad>(key: K, value: Identidad[K]) {
    setV((prev) => ({ ...prev, [key]: value }));
    setMsg(null);
  }

  async function pickLogo(file: File) {
    setUploading(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/operator/uploads", { method: "POST", body: fd });
    setUploading(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg({
        kind: "error",
        text: j.message ?? j.error ?? "No pudimos subir el logo",
      });
      return;
    }
    const j = (await r.json()) as { url: string };
    set("logoUrl", j.url);
    setMsg({ kind: "ok", text: "Logo subido. Recuerda guardar." });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/operator/settings/identidad", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v),
    });
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: "error", text: "No pudimos guardar" });
      return;
    }
    setMsg({ kind: "ok", text: "Guardado." });
  }

  return (
    <div className="space-y-6">
      {/* Logo */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
          Logo del comercio
        </div>
        <p className="text-xs text-op-muted mb-3">
          PNG o SVG. Aparece en el menú del cliente y en las facturas
          que enviamos por correo. Si está vacío usamos el logo
          MESAPAY.
        </p>

        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-xl bg-paper border border-op-border flex items-center justify-center overflow-hidden shrink-0">
            {v.logoUrl ? (
              <img
                src={v.logoUrl}
                alt="Logo"
                className="w-full h-full object-contain p-2"
              />
            ) : (
              <span className="text-[10px] text-op-muted">Sin logo</span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/svg+xml,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickLogo(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="h-9 px-4 rounded-full bg-ink text-bone text-xs font-medium disabled:opacity-40"
            >
              {uploading
                ? "Subiendo…"
                : v.logoUrl
                  ? "Cambiar logo"
                  : "Subir logo"}
            </button>
            {v.logoUrl && (
              <button
                type="button"
                onClick={() => set("logoUrl", null)}
                className="h-7 px-3 text-[11px] text-danger hover:underline self-start"
              >
                Quitar logo
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Datos legales */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          Datos legales
        </div>
        <Field
          label="Nombre del restaurante"
          hint="Aparece como remitente de los correos de factura. Ej: si pones 'DELIRIO RESTAURANTE' el cliente verá 'DELIRIO RESTAURANTE · MESAPAY' en su bandeja de entrada."
        >
          <input
            type="text"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Delirio Restaurante"
            maxLength={120}
            className={inputCls}
          />
        </Field>
        <Field label="Razón social">
          <input
            type="text"
            value={v.legalName ?? ""}
            onChange={(e) => set("legalName", e.target.value || null)}
            placeholder="Inversiones Mi Restaurante S.A.S."
            className={inputCls}
          />
        </Field>
        <Field label="NIT" hint="Solo dígitos. El DV no es obligatorio.">
          <input
            type="text"
            value={v.taxId ?? ""}
            onChange={(e) => set("taxId", e.target.value || null)}
            placeholder="900123456-7"
            className={inputCls}
          />
        </Field>
        <Field label="Dirección">
          <input
            type="text"
            value={v.legalAddress ?? ""}
            onChange={(e) => set("legalAddress", e.target.value || null)}
            placeholder="Cra 11 # 85-32"
            className={inputCls}
          />
        </Field>
        <Field label="Ciudad">
          <input
            type="text"
            value={v.legalCity ?? ""}
            onChange={(e) => set("legalCity", e.target.value || null)}
            placeholder="Bogotá"
            className={inputCls}
          />
        </Field>
        <Field label="Teléfono">
          <input
            type="text"
            value={v.legalPhone ?? ""}
            onChange={(e) => set("legalPhone", e.target.value || null)}
            placeholder="+57 320 123 4567"
            className={inputCls}
          />
        </Field>
      </section>

      {/* Resolución DIAN */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          Resolución de facturación DIAN
        </div>
        <p className="text-xs text-op-muted">
          La información de la resolución que aparece en las facturas
          tipo tirilla. No conectamos con la DIAN — esto es solo para
          imprimir en el comprobante.
        </p>
        <Field label="Resolución (texto)">
          <input
            type="text"
            value={v.dianResolution ?? ""}
            onChange={(e) => set("dianResolution", e.target.value || null)}
            placeholder="Resolución 18760000001"
            className={inputCls}
          />
        </Field>
        <Field label="Fecha de resolución">
          <input
            type="date"
            value={v.dianResolutionDate ?? ""}
            onChange={(e) =>
              set("dianResolutionDate", e.target.value || null)
            }
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Numeración desde">
            <input
              type="number"
              min={0}
              value={v.dianResolutionFrom ?? ""}
              onChange={(e) =>
                set(
                  "dianResolutionFrom",
                  e.target.value ? Number(e.target.value) : null,
                )
              }
              placeholder="1"
              className={inputCls}
            />
          </Field>
          <Field label="Numeración hasta">
            <input
              type="number"
              min={0}
              value={v.dianResolutionTo ?? ""}
              onChange={(e) =>
                set(
                  "dianResolutionTo",
                  e.target.value ? Number(e.target.value) : null,
                )
              }
              placeholder="5000"
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Prefijo" hint="Aparece antes del consecutivo. Ej: POS, FE.">
          <input
            type="text"
            value={v.invoicePrefix ?? ""}
            onChange={(e) => set("invoicePrefix", e.target.value || null)}
            placeholder="POS"
            maxLength={10}
            className={inputCls + " uppercase"}
          />
        </Field>
        <Field
          label="Próximo consecutivo a emitir"
          hint="Si ya venías emitiendo en otra plataforma o quieres arrancar desde el inicio de la resolución, ajustá este número."
        >
          <input
            type="number"
            min={1}
            value={v.invoiceNextNumber}
            onChange={(e) =>
              set(
                "invoiceNextNumber",
                e.target.value ? Math.max(1, Number(e.target.value)) : 1,
              )
            }
            className={inputCls}
          />
          {/* Sugerencia: si está en 1 (default) y hay rango DIAN
              configurado, ofrecer arrancar desde el límite inferior
              del rango. */}
          {v.invoiceNextNumber === 1 &&
            v.dianResolutionFrom != null &&
            v.dianResolutionFrom > 1 && (
              <button
                type="button"
                onClick={() => set("invoiceNextNumber", v.dianResolutionFrom!)}
                className="mt-1 text-[10px] text-terracotta underline"
              >
                Arrancar desde {v.dianResolutionFrom} (inicio de tu resolución)
              </button>
            )}
        </Field>
      </section>

      <div className="flex items-center justify-end gap-3">
        {msg && (
          <span
            className={
              "text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
