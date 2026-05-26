"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewRestaurantClient() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [serviceMode, setServiceMode] = useState<"table" | "counter">("table");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Auto-generar slug del nombre mientras el usuario no lo edite a
  // mano. Una vez que toca el slug input, dejamos su versión.
  function setNameAndSlug(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(autoSlug(value));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim() || !slug.trim()) {
      setErr("Faltan datos.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/group/restaurants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim(),
        serviceMode,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? j.error ?? "No pudimos crear el restaurante.");
      return;
    }
    // Después de crear, volvemos al landing — desde ahí el group_admin
    // puede impersonar al nuevo restaurante para configurarlo.
    router.push("/group");
    router.refresh();
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4"
    >
      <div>
        <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5 block">
          Nombre
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setNameAndSlug(e.target.value)}
          maxLength={80}
          placeholder="Delirio Restaurante"
          className={inputCls}
          autoFocus
        />
      </div>

      <div>
        <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5 block">
          Identificador (URL)
        </label>
        <div className="flex items-center gap-2">
          <span className="text-op-muted text-sm">mesapay.co/t/</span>
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(autoSlug(e.target.value));
              setSlugTouched(true);
            }}
            maxLength={40}
            placeholder="delirio"
            className={inputCls + " flex-1"}
          />
        </div>
        <div className="text-[10px] text-op-muted mt-1">
          Sólo a-z, 0-9 y guiones. Cliente escanea QR y va a esta URL.
        </div>
      </div>

      <div>
        <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2 block">
          Modo de servicio
        </label>
        <div className="flex gap-2 flex-wrap">
          {(
            [
              {
                value: "table" as const,
                label: "Con mesas",
                desc: "Cada mesa tiene su QR. Cliente escanea desde su puesto.",
              },
              {
                value: "counter" as const,
                label: "Mostrador",
                desc: "Un solo QR. Útil para food trucks / pickup.",
              },
            ]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setServiceMode(o.value)}
              className={
                "flex-1 min-w-[140px] text-left rounded-xl border p-3 transition-colors " +
                (serviceMode === o.value
                  ? "border-ink bg-ink/5"
                  : "border-op-border hover:border-op-text/30")
              }
            >
              <div className="font-medium text-sm">{o.label}</div>
              <div className="text-[11px] text-op-muted mt-0.5">{o.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {err && <div className="text-danger text-xs">{err}</div>}

      <div className="flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={busy || !name.trim() || !slug.trim()}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Creando…" : "Crear restaurante"}
        </button>
      </div>
    </form>
  );
}

function autoSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta";
