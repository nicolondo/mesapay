"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

type Cat = { id: string; label: string; slug: string };
type Item = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  available: boolean;
  photoUrl: string | null;
  tags: string[];
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
      body: JSON.stringify({ label: label.trim() }),
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
      className="bg-op-surface border border-op-border rounded-xl p-4 flex items-end gap-3"
    >
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
      <div className="flex gap-2">
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
    <div className="flex items-center gap-3">
      <div className="font-display text-2xl">{cat.label}</div>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(price) * 100);
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr("Revisa el nombre y el precio.");
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const cents = Math.round(Number(priceCents) * 100);
    if (!name.trim() || !Number.isFinite(cents) || cents < 0) {
      setErr("Revisa el nombre y el precio.");
      return;
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
            <label className="w-36 flex flex-col">
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

          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              URL de la foto (opcional)
            </span>
            <input
              value={photoUrl}
              onChange={(e) => setPhotoUrl(e.target.value)}
              placeholder="https://…"
              className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            />
          </label>

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
