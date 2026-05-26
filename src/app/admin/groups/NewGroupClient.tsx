"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewGroupClient({
  ungroupedRestaurants,
}: {
  ungroupedRestaurants: { id: string; name: string; slug: string }[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [selectedRestaurants, setSelectedRestaurants] = useState<Set<string>>(
    new Set(),
  );
  const [createAdmin, setCreateAdmin] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function autoSlug(s: string) {
    return s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  function setNameAndSlug(v: string) {
    setName(v);
    if (!slugTouched) setSlug(autoSlug(v));
  }

  function toggleRestaurant(id: string) {
    setSelectedRestaurants((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    setErr(null);
    if (!name.trim() || !slug.trim()) {
      setErr("Nombre y slug obligatorios.");
      return;
    }
    if (createAdmin) {
      if (!adminEmail.trim() || !adminPassword) {
        setErr("Email y contraseña del admin son obligatorios.");
        return;
      }
      if (adminPassword.length < 6) {
        setErr("Contraseña min 6 caracteres.");
        return;
      }
    }
    setBusy(true);
    const res = await fetch("/api/admin/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim(),
        restaurantIds: Array.from(selectedRestaurants),
        ...(createAdmin && {
          adminEmail: adminEmail.trim().toLowerCase(),
          adminName: adminName.trim() || undefined,
          adminPassword,
        }),
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? "No pudimos crear el grupo.");
      return;
    }
    // Reset
    setName("");
    setSlug("");
    setSlugTouched(false);
    setSelectedRestaurants(new Set());
    setCreateAdmin(false);
    setAdminEmail("");
    setAdminName("");
    setAdminPassword("");
    router.refresh();
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        Crear grupo nuevo
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Nombre">
          <input
            type="text"
            value={name}
            onChange={(e) => setNameAndSlug(e.target.value)}
            maxLength={160}
            placeholder="Grupo Delirio"
            className={inputCls}
          />
        </Field>
        <Field label="Slug">
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(autoSlug(e.target.value));
              setSlugTouched(true);
            }}
            maxLength={40}
            placeholder="grupo-delirio"
            className={inputCls}
          />
        </Field>
      </div>

      {ungroupedRestaurants.length > 0 && (
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
            Asignar restaurantes (opcional)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-auto rounded-lg border border-op-border p-2 bg-op-bg/30">
            {ungroupedRestaurants.map((r) => (
              <label
                key={r.id}
                className={
                  "flex items-center gap-2 rounded-md p-2 cursor-pointer border " +
                  (selectedRestaurants.has(r.id)
                    ? "border-ink bg-ink/5"
                    : "border-transparent hover:bg-op-bg")
                }
              >
                <input
                  type="checkbox"
                  checked={selectedRestaurants.has(r.id)}
                  onChange={() => toggleRestaurant(r.id)}
                  className="accent-ink"
                />
                <div className="min-w-0">
                  <div className="text-sm truncate">{r.name}</div>
                  <div className="font-mono text-[10px] text-op-muted">
                    /{r.slug}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="text-[10px] text-op-muted mt-1">
            {selectedRestaurants.size > 0
              ? `${selectedRestaurants.size} seleccionado(s)`
              : "Sólo se listan restaurantes sin grupo asignado."}
          </div>
        </div>
      )}

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={createAdmin}
            onChange={(e) => setCreateAdmin(e.target.checked)}
            className="accent-ink"
          />
          <span className="text-sm">
            Crear usuario group_admin para este grupo
          </span>
        </label>
        {createAdmin && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Nombre">
              <input
                type="text"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="Dueño Delirio"
                className={inputCls}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@delirio.com"
                className={inputCls}
              />
            </Field>
            <Field label="Contraseña">
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="min 6 caracteres"
                className={inputCls}
              />
            </Field>
          </div>
        )}
      </div>

      {err && <div className="text-xs text-danger">{err}</div>}

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={create}
          disabled={busy || !name.trim() || !slug.trim()}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Creando…" : "Crear grupo"}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta";
