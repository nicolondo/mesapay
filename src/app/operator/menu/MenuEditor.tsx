"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

type CategoryKind =
  | "starter"
  | "main"
  | "side"
  | "drink"
  | "dessert"
  | "other";
type Cat = { id: string; label: string; slug: string; kind: CategoryKind };

const KIND_OPTIONS: { value: CategoryKind; label: string }[] = [
  { value: "starter", label: "Entradas" },
  { value: "main", label: "Fuertes" },
  { value: "side", label: "Acompañamientos" },
  { value: "drink", label: "Bebidas" },
  { value: "dessert", label: "Postres" },
  { value: "other", label: "Otro" },
];
type ModifierDef = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: string[];
  default?: string;
};
type Item = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  available: boolean;
  photoUrl: string | null;
  tags: string[];
  modifiers: ModifierDef[];
  prepMinutes: number;
};

const TAGS = ["firma", "popular", "veg", "spicy", "nuevo"] as const;
const TAG_LABEL: Record<string, string> = {
  firma: "De la casa",
  popular: "Favorito",
  veg: "Vegetariano",
  spicy: "Picante",
  nuevo: "Nuevo",
};

export function MenuEditor({
  categories,
  items,
}: {
  categories: Cat[];
  items: Item[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingItemInCat, setAddingItemInCat] = useState<string | null>(null);

  function refresh() {
    startTx(() => router.refresh());
  }

  const byCat = new Map<string, Item[]>();
  for (const c of categories) byCat.set(c.id, []);
  for (const it of items) byCat.get(it.categoryId)?.push(it);

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-5">
        <div className="font-display text-3xl">Menú</div>
        {!addingCategory && (
          <button
            onClick={() => setAddingCategory(true)}
            className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
          >
            + Nueva categoría
          </button>
        )}
      </div>

      {addingCategory && (
        <div className="mb-5">
          <NewCategoryForm
            onSave={refresh}
            onClose={() => setAddingCategory(false)}
          />
        </div>
      )}

      {categories.length === 0 && !addingCategory && (
        <div className="text-sm text-op-muted border border-dashed border-op-border rounded-xl p-8 text-center">
          Todavía no tienes categorías. Crea la primera — por ejemplo, “Para
          empezar”, “Principales”, “Postres”.
        </div>
      )}

      <div className="space-y-8">
        {categories.map((c) => {
          const rows = byCat.get(c.id) ?? [];
          return (
            <section key={c.id}>
              <div className="flex items-center justify-between mb-3">
                <CategoryHeader cat={c} onSave={refresh} />
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setAddingItemInCat(c.id)}
                    className="h-8 px-4 rounded-full bg-op-surface border border-op-border text-xs font-medium"
                  >
                    + Plato
                  </button>
                </div>
              </div>

              {addingItemInCat === c.id && (
                <div className="mb-3">
                  <NewItemForm
                    categoryId={c.id}
                    onSave={() => {
                      refresh();
                    }}
                    onClose={() => setAddingItemInCat(null)}
                  />
                </div>
              )}

              <ul className="divide-y divide-op-border border border-op-border rounded-xl bg-op-surface overflow-hidden">
                {rows.length === 0 && addingItemInCat !== c.id && (
                  <li className="p-4 text-sm text-op-muted">
                    Sin platos todavía.
                  </li>
                )}
                {rows.map((it) => (
                  <li
                    key={it.id}
                    className="p-4 flex items-start gap-3 hover:bg-op-bg/50"
                  >
                    <div
                      className="w-14 h-14 shrink-0 rounded-lg bg-op-bg bg-cover bg-center"
                      style={
                        it.photoUrl
                          ? { backgroundImage: `url(${it.photoUrl})` }
                          : undefined
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="font-medium truncate">
                          {it.name}
                          {!it.available && (
                            <span className="ml-2 text-[10px] font-mono uppercase tracking-wider text-op-muted">
                              · agotado
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-sm tabular shrink-0">
                          {fmtCOP(it.priceCents)}
                        </div>
                      </div>
                      {it.description && (
                        <div className="text-xs text-op-muted line-clamp-1 mt-0.5">
                          {it.description}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setEditingItem(it)}
                      className="shrink-0 text-xs text-terracotta hover:underline"
                    >
                      Editar
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {editingItem && (
        <ItemSheet
          item={editingItem}
          categories={categories}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewCategoryForm({
  onSave,
  onClose,
}: {
  onSave: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<CategoryKind>("other");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/operator/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.trim(), kind }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Error");
      return;
    }
    onSave();
    onClose();
  }

  return (
    <form
      onSubmit={submit}
      className="bg-op-surface border border-op-border rounded-xl p-4 space-y-3"
    >
      <div className="flex items-end gap-3">
        <label className="flex-1 flex flex-col">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Nombre de la categoría
          </span>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            placeholder="Para empezar, Principales, Postres…"
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        <label className="w-48 flex flex-col">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Tipo
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CategoryKind)}
            className="h-10 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="text-[11px] text-op-muted">
        Marcar como <span className="font-medium">Fuertes</span> activa el modo
        “Fuertes juntos” cuando el comensal lo elige al pedir.
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-10 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim()}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear"}
        </button>
      </div>
      {err && <div className="w-full text-danger text-xs">{err}</div>}
    </form>
  );
}

function CategoryHeader({
  cat,
  onSave,
}: {
  cat: Cat;
  onSave: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(cat.label);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!label.trim() || label.trim() === cat.label) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      alert("No se pudo renombrar.");
      return;
    }
    setEditing(false);
    onSave();
  }

  async function changeKind(kind: CategoryKind) {
    if (kind === cat.kind) return;
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!res.ok) {
      alert("No se pudo cambiar el tipo.");
      return;
    }
    onSave();
  }

  async function del() {
    const ok = window.confirm(`¿Eliminar la categoría "${cat.label}"?`);
    if (!ok) return;
    const res = await fetch(`/api/operator/categories/${cat.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "No se pudo eliminar.");
      return;
    }
    onSave();
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
          className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-lg font-display"
        />
        <button
          onClick={save}
          disabled={busy}
          className="text-xs text-terracotta font-medium"
        >
          Guardar
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setLabel(cat.label);
          }}
          className="text-xs text-op-muted"
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="font-display text-2xl">{cat.label}</div>
      <select
        value={cat.kind}
        onChange={(e) => changeKind(e.target.value as CategoryKind)}
        title="Tipo de categoría — los fuertes controlan el modo ‘Fuertes juntos’"
        className="h-7 px-1.5 rounded border border-op-border bg-op-bg text-[11px]"
      >
        {KIND_OPTIONS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <button
        onClick={() => setEditing(true)}
        className="text-[11px] text-op-muted hover:text-ink"
      >
        Renombrar
      </button>
      <button
        onClick={del}
        className="text-[11px] text-op-muted hover:text-danger"
      >
        Eliminar
      </button>
    </div>
  );
}

function NewItemForm({
  categoryId,
  onSave,
  onClose,
}: {
  categoryId: string;
  onSave: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [prepMinutes, setPrepMinutes] = useState("10");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(price) * 100);
    const mins = Math.round(Number(prepMinutes));
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr("Revisa el nombre y el precio.");
      return;
    }
    if (!Number.isFinite(mins) || mins < 1 || mins > 120) {
      setErr("Tiempo de preparación entre 1 y 120 minutos.");
      return;
    }
    setErr(null);
    setBusy(true);
    const res = await fetch("/api/operator/menu-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        categoryId,
        name: name.trim(),
        priceCents: cents,
        description: description.trim() || undefined,
        prepMinutes: mins,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Error");
      return;
    }
    onSave();
    onClose();
  }

  return (
    <form
      onSubmit={submit}
      className="bg-op-surface border border-op-border rounded-xl p-4 space-y-3"
    >
      <div className="flex gap-3">
        <label className="flex flex-col flex-1">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Nombre
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        <label className="flex flex-col w-32">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Precio (COP)
          </span>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            min={0}
            step={100}
            placeholder="25000"
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        <label className="flex flex-col w-24">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            Prep (min)
          </span>
          <input
            type="number"
            value={prepMinutes}
            onChange={(e) => setPrepMinutes(e.target.value)}
            min={1}
            max={120}
            step={1}
            className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
      </div>
      <label className="flex flex-col">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          Descripción (opcional)
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={240}
          rows={2}
          className="px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
        />
      </label>
      {err && <div className="text-danger text-xs">{err}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-9 px-4 rounded-full border border-op-border text-sm"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-9 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear plato"}
        </button>
      </div>
    </form>
  );
}

function ItemSheet({
  item,
  categories,
  onClose,
  onSaved,
}: {
  item: Item;
  categories: Cat[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [priceCents, setPriceCents] = useState(String(item.priceCents / 100));
  const [description, setDescription] = useState(item.description);
  const [categoryId, setCategoryId] = useState(item.categoryId);
  const [available, setAvailable] = useState(item.available);
  const [photoUrl, setPhotoUrl] = useState(item.photoUrl ?? "");
  const [tags, setTags] = useState<string[]>(item.tags);
  const [modifiers, setModifiers] = useState<ModifierDef[]>(item.modifiers);
  const [prepMinutes, setPrepMinutes] = useState(String(item.prepMinutes));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPhotoPick(file: File) {
    setUploading(true);
    setErr(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/operator/uploads", { method: "POST", body: form });
    setUploading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos subir la foto.");
      return;
    }
    const { url } = await res.json();
    setPhotoUrl(url);
  }

  async function save() {
    const cents = Math.round(Number(priceCents) * 100);
    const mins = Math.round(Number(prepMinutes));
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr("Revisa el nombre y el precio.");
      return;
    }
    if (!Number.isFinite(mins) || mins < 1 || mins > 120) {
      setErr("Tiempo de preparación entre 1 y 120 minutos.");
      return;
    }
    for (const m of modifiers) {
      if (!m.label.trim() || m.opts.length === 0) {
        setErr(`El modificador "${m.label || "(sin nombre)"}" necesita etiqueta y al menos una opción.`);
        return;
      }
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/operator/menu-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        priceCents: cents,
        description: description.trim() || null,
        categoryId,
        available,
        photoUrl: photoUrl.trim() || null,
        tags,
        modifiers: modifiers.length > 0 ? modifiers : null,
        prepMinutes: mins,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Error");
      return;
    }
    onSaved();
  }

  async function del() {
    const ok = window.confirm(`¿Eliminar "${item.name}"?`);
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/operator/menu-items/${item.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? "Error");
      return;
    }
    const j = await res.json().catch(() => ({}));
    if (j.archived) {
      alert(
        "Este plato ya aparece en pedidos antiguos, así que se marcó como agotado en lugar de eliminarse.",
      );
    }
    onSaved();
  }

  function toggleTag(t: string) {
    setTags((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-op-surface text-op-text w-full max-w-xl max-h-[92vh] rounded-2xl overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="font-display text-2xl">Editar plato</div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full border border-op-border"
            >
              ×
            </button>
          </div>

          <div className="flex gap-3">
            <label className="flex-1 flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                Nombre
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
            <label className="w-32 flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                Precio (COP)
              </span>
              <input
                type="number"
                value={priceCents}
                onChange={(e) => setPriceCents(e.target.value)}
                min={0}
                step={100}
                className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
            <label className="w-24 flex flex-col">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
                Prep (min)
              </span>
              <input
                type="number"
                value={prepMinutes}
                onChange={(e) => setPrepMinutes(e.target.value)}
                min={1}
                max={120}
                step={1}
                className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
          </div>

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              Descripción
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={240}
              rows={3}
              className="px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
            />
          </label>

          <div className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              Foto
            </span>
            <div className="flex items-center gap-3">
              <div
                className="w-20 h-20 rounded-lg bg-op-bg border border-op-border bg-cover bg-center shrink-0"
                style={
                  photoUrl ? { backgroundImage: `url(${photoUrl})` } : undefined
                }
              />
              <div className="flex flex-col gap-1.5">
                <label className="inline-flex items-center justify-center h-9 px-4 rounded-lg border border-op-border bg-op-bg text-sm font-medium cursor-pointer hover:bg-ink/5">
                  {uploading ? "Subiendo…" : photoUrl ? "Cambiar foto" : "Subir foto"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onPhotoPick(f);
                      e.target.value = "";
                    }}
                    className="hidden"
                  />
                </label>
                {photoUrl && (
                  <button
                    type="button"
                    onClick={() => setPhotoUrl("")}
                    className="text-xs text-danger hover:underline text-left"
                  >
                    Quitar foto
                  </button>
                )}
                <div className="text-[11px] text-op-muted">
                  JPG, PNG o WebP · máx 5MB
                </div>
              </div>
            </div>
          </div>

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              Categoría
            </span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
              Etiquetas
            </div>
            <div className="flex gap-2 flex-wrap">
              {TAGS.map((t) => {
                const active = tags.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleTag(t)}
                    className={
                      "h-8 px-3 rounded-full text-xs border " +
                      (active
                        ? "bg-ink text-bone border-ink"
                        : "bg-op-bg border-op-border text-op-text")
                    }
                  >
                    {TAG_LABEL[t] ?? t}
                  </button>
                );
              })}
            </div>
          </div>

          <ModifiersEditor modifiers={modifiers} onChange={setModifiers} />

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={available}
              onChange={(e) => setAvailable(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Disponible (se muestra en el menú)</span>
          </label>

          {err && <div className="text-danger text-sm">{err}</div>}

          <div className="flex items-center justify-between pt-2 border-t border-op-border">
            <button
              onClick={del}
              disabled={busy}
              className="text-sm text-danger hover:underline disabled:opacity-60"
            >
              Eliminar
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="h-10 px-4 rounded-full border border-op-border text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
              >
                {busy ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function slugifyMod(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "mod"
  );
}

function ModifiersEditor({
  modifiers,
  onChange,
}: {
  modifiers: ModifierDef[];
  onChange: (m: ModifierDef[]) => void;
}) {
  function add() {
    const base = "opcion";
    let id = base;
    let n = 2;
    while (modifiers.some((m) => m.id === id)) id = `${base}-${n++}`;
    onChange([
      ...modifiers,
      { id, label: "", type: "radio", opts: [], default: undefined },
    ]);
  }

  function update(ix: number, patch: Partial<ModifierDef>) {
    onChange(modifiers.map((m, i) => (i === ix ? { ...m, ...patch } : m)));
  }

  function remove(ix: number) {
    onChange(modifiers.filter((_, i) => i !== ix));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          Modificadores
        </div>
        <button
          type="button"
          onClick={add}
          className="text-xs text-terracotta hover:underline"
        >
          + Añadir
        </button>
      </div>
      {modifiers.length === 0 && (
        <div className="text-xs text-op-muted">
          Sin modificadores. Por ejemplo: nivel de picante, tamaño, guarnición.
        </div>
      )}
      <div className="space-y-3">
        {modifiers.map((m, i) => (
          <div
            key={i}
            className="border border-op-border rounded-lg p-3 bg-op-bg/50 space-y-2"
          >
            <div className="flex gap-2 items-end">
              <label className="flex-1 flex flex-col">
                <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  Etiqueta
                </span>
                <input
                  value={m.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    update(i, {
                      label,
                      id: m.id || slugifyMod(label),
                    });
                  }}
                  onBlur={(e) => {
                    if (!m.id && e.target.value) {
                      update(i, { id: slugifyMod(e.target.value) });
                    }
                  }}
                  maxLength={60}
                  placeholder="Nivel de picante, Tamaño…"
                  className="h-9 px-2 rounded border border-op-border bg-op-surface text-sm"
                />
              </label>
              <label className="flex flex-col">
                <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  Tipo
                </span>
                <select
                  value={m.type}
                  onChange={(e) =>
                    update(i, { type: e.target.value as "radio" | "checkbox" })
                  }
                  className="h-9 px-2 rounded border border-op-border bg-op-surface text-sm"
                >
                  <option value="radio">Uno solo</option>
                  <option value="checkbox">Varias</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => remove(i)}
                className="h-9 px-2 text-xs text-op-muted hover:text-danger"
              >
                ×
              </button>
            </div>

            <OptionsEditor
              opts={m.opts}
              defaultOpt={m.default}
              canDefault={m.type === "radio"}
              onChange={(opts, def) =>
                update(i, {
                  opts,
                  default:
                    m.type === "radio"
                      ? def && opts.includes(def)
                        ? def
                        : undefined
                      : undefined,
                })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function OptionsEditor({
  opts,
  defaultOpt,
  canDefault,
  onChange,
}: {
  opts: string[];
  defaultOpt: string | undefined;
  canDefault: boolean;
  onChange: (opts: string[], defaultOpt: string | undefined) => void;
}) {
  const [draft, setDraft] = useState("");

  function addDraft() {
    const v = draft.trim();
    if (!v || opts.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...opts, v], defaultOpt);
    setDraft("");
  }

  function removeAt(ix: number) {
    const next = opts.filter((_, i) => i !== ix);
    const nextDefault = defaultOpt && next.includes(defaultOpt) ? defaultOpt : undefined;
    onChange(next, nextDefault);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {opts.map((o, i) => {
          const isDefault = canDefault && o === defaultOpt;
          return (
            <span
              key={o}
              className={
                "inline-flex items-center gap-1 h-7 pl-3 pr-1 rounded-full border text-xs " +
                (isDefault
                  ? "bg-ink text-bone border-ink"
                  : "bg-op-surface border-op-border")
              }
            >
              <span>{o}</span>
              {canDefault && !isDefault && (
                <button
                  type="button"
                  onClick={() => onChange(opts, o)}
                  className="text-[9px] uppercase tracking-wider text-op-muted hover:text-ink px-1"
                  title="Marcar como opción por defecto"
                >
                  default
                </button>
              )}
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="w-5 h-5 rounded-full hover:bg-op-border/40 inline-flex items-center justify-center"
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
          maxLength={60}
          placeholder="Añadir opción y Enter"
          className="flex-1 h-8 px-2 rounded border border-op-border bg-op-surface text-xs"
        />
        <button
          type="button"
          onClick={addDraft}
          className="h-8 px-3 rounded-full bg-op-border/40 text-xs"
        >
          Añadir
        </button>
      </div>
    </div>
  );
}
