"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type LegalEntity = {
  id: string;
  name: string;
  taxId: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  dianResolution: string | null;
  dianResolutionFrom: number | null;
  dianResolutionTo: number | null;
  dianResolutionDate: string | null;
  invoicePrefix: string | null;
  invoiceNextNumber: number;
  restaurantCount: number;
};

export function LegalEntitiesClient({ initial }: { initial: LegalEntity[] }) {
  const router = useRouter();
  const [items, setItems] = useState<LegalEntity[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function onChange(id: string, patch: Partial<LegalEntity>) {
    setItems((arr) =>
      arr.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    );
  }

  async function deleteEntity(id: string) {
    if (
      !window.confirm("¿Borrar esta razón social? No se puede revertir.")
    ) {
      return;
    }
    const res = await fetch(`/api/group/legal-entities/${id}`, {
      method: "DELETE",
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.alert(j.message ?? j.error ?? "No pudimos borrar.");
      return;
    }
    setItems((arr) => arr.filter((e) => e.id !== id));
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && !creating && (
        <div className="rounded-2xl border border-op-border bg-op-surface p-6 text-center text-sm text-op-muted">
          Aún no hay razones sociales. Crea la primera para empezar a
          asignarla a tus restaurantes.
        </div>
      )}

      {items.map((e) => (
        <EntityCard
          key={e.id}
          entity={e}
          editing={editingId === e.id}
          onStartEdit={() => setEditingId(e.id)}
          onCancelEdit={() => {
            setEditingId(null);
            router.refresh();
          }}
          onChange={(patch) => onChange(e.id, patch)}
          onSaved={() => {
            setEditingId(null);
            router.refresh();
          }}
          onDelete={() => deleteEntity(e.id)}
        />
      ))}

      {creating ? (
        <CreateCard
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full h-11 rounded-full border border-dashed border-op-border text-op-muted hover:text-op-text hover:border-op-text/40 text-sm font-medium"
        >
          + Agregar razón social
        </button>
      )}
    </div>
  );
}

function EntityCard({
  entity,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onDelete,
  onChange,
}: {
  entity: LegalEntity;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onDelete: () => void;
  onChange: (patch: Partial<LegalEntity>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/group/legal-entities/${entity.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: entity.name,
        taxId: entity.taxId,
        address: entity.address,
        city: entity.city,
        phone: entity.phone,
        dianResolution: entity.dianResolution,
        dianResolutionFrom: entity.dianResolutionFrom,
        dianResolutionTo: entity.dianResolutionTo,
        dianResolutionDate: entity.dianResolutionDate,
        invoicePrefix: entity.invoicePrefix,
        invoiceNextNumber: entity.invoiceNextNumber,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? "No pudimos guardar.");
      return;
    }
    onSaved();
  }

  if (!editing) {
    return (
      <div className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="min-w-0">
            <div className="font-display text-lg truncate">{entity.name}</div>
            <div className="font-mono text-xs text-op-muted">
              NIT {entity.taxId}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-mono text-[10px] tracking-wider uppercase px-2 py-1 rounded border bg-op-bg border-op-border text-op-muted">
              {entity.restaurantCount}{" "}
              {entity.restaurantCount === 1 ? "local" : "locales"}
            </span>
            <button
              type="button"
              onClick={onStartEdit}
              className="h-8 px-3 rounded-full border border-op-border text-xs font-medium hover:bg-op-bg"
            >
              Editar
            </button>
          </div>
        </div>
        {(entity.address || entity.city || entity.phone) && (
          <div className="font-mono text-[11px] text-op-muted mt-1">
            {[entity.address, entity.city, entity.phone]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
        {entity.dianResolution && (
          <div className="font-mono text-[11px] text-op-muted mt-1">
            {entity.dianResolution}
            {entity.invoicePrefix ? ` · prefijo ${entity.invoicePrefix}` : ""}
            {entity.dianResolutionFrom != null &&
            entity.dianResolutionTo != null
              ? ` · ${entity.dianResolutionFrom}-${entity.dianResolutionTo}`
              : ""}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        Editando · {entity.restaurantCount}{" "}
        {entity.restaurantCount === 1 ? "local usa" : "locales usan"} esta
      </div>
      <Fields
        entity={entity}
        onChange={onChange}
      />
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <button
          type="button"
          onClick={onDelete}
          disabled={busy || entity.restaurantCount > 0}
          title={
            entity.restaurantCount > 0
              ? "Desasigná la razón social de los restaurantes antes de borrar"
              : ""
          }
          className="h-9 px-4 rounded-full border border-danger/40 text-danger text-sm disabled:opacity-40"
        >
          Borrar
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancelEdit}
          disabled={busy}
          className="h-9 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy || !entity.name.trim() || !entity.taxId.trim()}
          className="h-9 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

function CreateCard({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<LegalEntity>({
    id: "_new",
    name: "",
    taxId: "",
    address: null,
    city: null,
    phone: null,
    dianResolution: null,
    dianResolutionFrom: null,
    dianResolutionTo: null,
    dianResolutionDate: null,
    invoicePrefix: null,
    invoiceNextNumber: 1,
    restaurantCount: 0,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!draft.name.trim() || !draft.taxId.trim()) {
      setErr("Nombre y NIT son obligatorios.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/group/legal-entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: draft.name.trim(),
        taxId: draft.taxId.trim(),
        address: draft.address,
        city: draft.city,
        phone: draft.phone,
        dianResolution: draft.dianResolution,
        dianResolutionFrom: draft.dianResolutionFrom,
        dianResolutionTo: draft.dianResolutionTo,
        dianResolutionDate: draft.dianResolutionDate,
        invoicePrefix: draft.invoicePrefix,
        invoiceNextNumber: draft.invoiceNextNumber,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? "No pudimos crear.");
      return;
    }
    onCreated();
  }

  return (
    <div className="rounded-2xl border-2 border-dashed border-op-border bg-op-surface p-5 space-y-3">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        Nueva razón social
      </div>
      <Fields
        entity={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-9 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={create}
          disabled={busy || !draft.name.trim() || !draft.taxId.trim()}
          className="h-9 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Creando…" : "Crear"}
        </button>
      </div>
    </div>
  );
}

function Fields({
  entity,
  onChange,
}: {
  entity: LegalEntity;
  onChange: (patch: Partial<LegalEntity>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Razón social" required>
          <input
            type="text"
            value={entity.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Inversiones Mi Restaurante S.A.S."
            className={inputCls}
          />
        </Field>
        <Field label="NIT" required>
          <input
            type="text"
            value={entity.taxId}
            onChange={(e) => onChange({ taxId: e.target.value })}
            placeholder="900123456-7"
            className={inputCls}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Dirección">
          <input
            type="text"
            value={entity.address ?? ""}
            onChange={(e) => onChange({ address: e.target.value || null })}
            className={inputCls}
          />
        </Field>
        <Field label="Ciudad">
          <input
            type="text"
            value={entity.city ?? ""}
            onChange={(e) => onChange({ city: e.target.value || null })}
            className={inputCls}
          />
        </Field>
        <Field label="Teléfono">
          <input
            type="text"
            value={entity.phone ?? ""}
            onChange={(e) => onChange({ phone: e.target.value || null })}
            className={inputCls}
          />
        </Field>
      </div>
      <details className="rounded-lg border border-op-border bg-op-bg/50 p-3">
        <summary className="cursor-pointer font-mono text-[10px] tracking-wider uppercase text-op-muted">
          Resolución DIAN (opcional)
        </summary>
        <div className="mt-3 space-y-3">
          <Field label="Resolución">
            <input
              type="text"
              value={entity.dianResolution ?? ""}
              onChange={(e) =>
                onChange({ dianResolution: e.target.value || null })
              }
              placeholder="Resolución 18760000001"
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Numeración desde">
              <input
                type="number"
                min={0}
                value={entity.dianResolutionFrom ?? ""}
                onChange={(e) =>
                  onChange({
                    dianResolutionFrom: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
                className={inputCls}
              />
            </Field>
            <Field label="Numeración hasta">
              <input
                type="number"
                min={0}
                value={entity.dianResolutionTo ?? ""}
                onChange={(e) =>
                  onChange({
                    dianResolutionTo: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
                className={inputCls}
              />
            </Field>
            <Field label="Fecha resolución">
              <input
                type="date"
                value={entity.dianResolutionDate ?? ""}
                onChange={(e) =>
                  onChange({ dianResolutionDate: e.target.value || null })
                }
                className={inputCls}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Prefijo factura">
              <input
                type="text"
                value={entity.invoicePrefix ?? ""}
                onChange={(e) =>
                  onChange({ invoicePrefix: e.target.value || null })
                }
                placeholder="POS"
                maxLength={10}
                className={inputCls + " uppercase"}
              />
            </Field>
            <Field label="Próximo consecutivo">
              <input
                type="number"
                min={1}
                value={entity.invoiceNextNumber}
                onChange={(e) =>
                  onChange({
                    invoiceNextNumber: Math.max(1, Number(e.target.value) || 1),
                  })
                }
                className={inputCls}
              />
            </Field>
          </div>
        </div>
      </details>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">*</span>}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta";
