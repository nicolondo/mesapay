"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney, pesosToCents } from "@/lib/format";
import { waLink } from "@/lib/crm/phone";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  costPerBaseUnit,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";

type Supplier = {
  id: string;
  name: string;
  taxId: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  paymentTermsDays: number | null;
  notes: string | null;
  active: boolean;
  _count: { items: number };
};

type IngredientRef = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  active: boolean;
};

type SupplierItem = {
  id: string;
  presentationLabel: string;
  contentQty: number;
  lastPriceCents: number | null;
  supplierSku: string | null;
  preferred: boolean;
  ingredient: IngredientRef;
};

/** Búsqueda sin acentos: minúsculas + tildes fuera ("azucar" → "azúcar"). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** "g/kg", "ml/L", "un" — símbolos de unidad, iguales en es/en/pt. */
function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

type SheetState = { mode: "create" } | { mode: "edit"; supplier: Supplier };

export function ProveedoresClient({
  initial,
  currency,
}: {
  initial: Supplier[];
  currency: string;
}) {
  const t = useTranslations("opErp");
  const [items, setItems] = useState<Supplier[]>(initial);
  const [q, setQ] = useState("");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = fold(q.trim());
    if (!needle) return items;
    return items.filter((s) =>
      fold(`${s.name} ${s.contactName ?? ""}`).includes(needle),
    );
  }, [items, q]);

  // El detalle se referencia por id: si el proveedor se edita desde el
  // sheet, el detalle re-renderiza con los datos frescos de la lista.
  const detail = detailId
    ? (items.find((s) => s.id === detailId) ?? null)
    : null;

  function upsert(saved: Supplier) {
    setItems((prev) => {
      const exists = prev.some((x) => x.id === saved.id);
      const next = exists
        ? prev.map((x) => (x.id === saved.id ? saved : x))
        : [...prev, saved];
      // Mismo orden que el server: activos primero, luego alfabético.
      return next.sort(
        (a, b) =>
          Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
      );
    });
  }

  function setItemCount(id: string, count: number) {
    setItems((prev) =>
      prev.map((s) => (s.id === id ? { ...s, _count: { items: count } } : s)),
    );
  }

  async function toggleActive(s: Supplier) {
    setTogglingId(s.id);
    setRowError(null);
    const r = await fetch(`/api/operator/suppliers/${s.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !s.active }),
    });
    setTogglingId(null);
    if (!r.ok) {
      setRowError(t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    // El PATCH no incluye _count — se preserva el del row local.
    upsert({ ...(j.supplier as Supplier), _count: s._count });
  }

  return (
    <div className="space-y-4">
      {/* Crear + búsqueda */}
      <button
        type="button"
        onClick={() => setSheet({ mode: "create" })}
        className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
      >
        {t("newSupplier")}
      </button>

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("searchSuppliersPlaceholder")}
        className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm focus:outline-none focus:border-op-text/40"
      />

      {rowError && <div className="text-xs text-danger">{rowError}</div>}

      {/* Lista */}
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">
            {t("emptySuppliersTitle")}
          </div>
          <p className="text-sm text-op-muted">{t("emptySuppliersBody")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("emptyFilteredSuppliers")}
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {filtered.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-2 px-4 py-2 border-b border-op-border last:border-b-0"
            >
              <button
                type="button"
                onClick={() => setDetailId(s.id)}
                className="flex-1 min-w-0 min-h-[44px] py-1.5 text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={
                      "text-sm font-medium truncate" +
                      (s.active ? "" : " opacity-50")
                    }
                  >
                    {s.name}
                  </span>
                  {!s.active && (
                    <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                      {t("inactiveBadge")}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                  {[
                    s.contactName,
                    s.phone,
                    s.paymentTermsDays == null
                      ? t("termsCash")
                      : t("termsDays", { count: s.paymentTermsDays }),
                    t("itemCount", { count: s._count.items }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </button>
              {s.phone && (
                // Botón WhatsApp — mismo patrón/estilo del CRM (wa.me).
                <a
                  href={waLink(s.phone)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-h-[44px] px-3 rounded-full bg-[#25D366]/10 text-[#128C7E] text-[11px] font-medium flex items-center shrink-0"
                >
                  {t("whatsappLabel")}
                </a>
              )}
              <button
                type="button"
                onClick={() => toggleActive(s)}
                disabled={togglingId === s.id}
                className={
                  "min-h-[44px] px-3 rounded-full text-[11px] font-medium shrink-0 disabled:opacity-40 " +
                  (s.active
                    ? "text-danger hover:bg-danger/10"
                    : "text-ok hover:bg-ok/10")
                }
              >
                {s.active ? t("deactivate") : t("reactivate")}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* El detalle va ANTES del sheet en el DOM: al editar desde el
          detalle, el sheet (hermano posterior, mismo z) pinta encima. */}
      {detail && (
        <SupplierDetailSheet
          supplier={detail}
          currency={currency}
          onClose={() => setDetailId(null)}
          onEdit={() => setSheet({ mode: "edit", supplier: detail })}
          onItemsCount={(n) => setItemCount(detail.id, n)}
        />
      )}

      {sheet && (
        <SupplierSheet
          editing={sheet.mode === "edit" ? sheet.supplier : null}
          onClose={() => setSheet(null)}
          onSaved={(saved) => {
            upsert(saved);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}

/* ────────────────────────────── Sheet de proveedor ─────────────────── */

function SupplierSheet({
  editing,
  onClose,
  onSaved,
}: {
  editing: Supplier | null;
  onClose: () => void;
  onSaved: (s: Supplier) => void;
}) {
  const t = useTranslations("opErp");
  const [name, setName] = useState(editing?.name ?? "");
  const [taxId, setTaxId] = useState(editing?.taxId ?? "");
  const [contactName, setContactName] = useState(editing?.contactName ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  const [terms, setTerms] = useState(
    editing?.paymentTermsDays != null ? String(editing.paymentTermsDays) : "",
  );
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    // El input numérico (0-365) ya valida en el browser; esto es fallback.
    const days = terms.trim() === "" ? null : Number(terms);
    if (days != null && (!Number.isInteger(days) || days < 0 || days > 365)) {
      setErr(t("errSaveFailed"));
      return;
    }
    setBusy(true);
    const r = await fetch(
      editing
        ? `/api/operator/suppliers/${editing.id}`
        : "/api/operator/suppliers",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          taxId: taxId.trim() || null,
          contactName: contactName.trim() || null,
          phone: phone.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          paymentTermsDays: days,
          notes: notes.trim() || null,
        }),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "name_taken"
          ? t("errSupplierNameTaken")
          : t("errSaveFailed"),
      );
      return;
    }
    const j = await r.json();
    // POST/PATCH no incluyen _count — proveedor nuevo arranca sin insumos.
    onSaved({
      ...(j.supplier as Supplier),
      _count: { items: editing?._count.items ?? 0 },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl">
            {editing ? t("editSupplier") : t("newSupplier")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Field label={t("fieldName")} required>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("supplierNamePlaceholder")}
              maxLength={120}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldTaxId")}>
            <input
              type="text"
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              placeholder={t("taxIdPlaceholder")}
              maxLength={40}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldContactName")}>
            <input
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder={t("contactNamePlaceholder")}
              maxLength={120}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldPhone")}>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t("phonePlaceholder")}
              maxLength={40}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldEmail")}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={120}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldAddress")}>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={300}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldPaymentTerms")} hint={t("paymentTermsHint")}>
            <input
              type="number"
              min={0}
              max={365}
              step={1}
              inputMode="numeric"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldNotes")}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
            />
          </Field>

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={busy || name.trim().length === 0}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────── Detalle del proveedor: lista de precios ───────── */

function SupplierDetailSheet({
  supplier,
  currency,
  onClose,
  onEdit,
  onItemsCount,
}: {
  supplier: Supplier;
  currency: string;
  onClose: () => void;
  onEdit: () => void;
  onItemsCount: (n: number) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [items, setItems] = useState<SupplierItem[] | null>(null);
  const [ingredients, setIngredients] = useState<IngredientRef[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [form, setForm] = useState<{ editing: SupplierItem | null } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);

  // Al abrir: lista de precios del proveedor + insumos activos (para el
  // combobox de "agregar"), en paralelo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rs, ri] = await Promise.all([
          fetch(`/api/operator/suppliers/${supplier.id}`),
          fetch("/api/operator/ingredients"),
        ]);
        if (!rs.ok || !ri.ok) throw new Error("load_failed");
        const js = await rs.json();
        const ji = await ri.json();
        if (cancelled) return;
        setItems((js.supplier?.items ?? []) as SupplierItem[]);
        setIngredients(
          ((ji.ingredients ?? []) as IngredientRef[]).filter((i) => i.active),
        );
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplier.id]);

  const listedIngredientIds = useMemo(
    () => new Set((items ?? []).map((i) => i.ingredient.id)),
    [items],
  );

  async function togglePreferred(item: SupplierItem) {
    setBusyId(item.id);
    setRowErr(null);
    const r = await fetch(`/api/operator/supplier-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferred: !item.preferred }),
    });
    setBusyId(null);
    if (!r.ok) {
      setRowErr(t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    const updated = j.item as SupplierItem;
    setItems((prev) =>
      (prev ?? []).map((x) => (x.id === updated.id ? updated : x)),
    );
  }

  async function removeItem(item: SupplierItem) {
    if (!window.confirm(t("confirmDeleteItem"))) return;
    setBusyId(item.id);
    setRowErr(null);
    const r = await fetch(`/api/operator/supplier-items/${item.id}`, {
      method: "DELETE",
    });
    setBusyId(null);
    if (!r.ok) {
      setRowErr(t("errSaveFailed"));
      return;
    }
    const next = (items ?? []).filter((x) => x.id !== item.id);
    setItems(next);
    onItemsCount(next.length);
  }

  function handleSaved(saved: SupplierItem, isNew: boolean) {
    const next = isNew
      ? [...(items ?? []), saved]
      : (items ?? []).map((x) => {
          if (x.id === saved.id) return saved;
          // Marcar ★ desmarca al resto server-side; acá no hay otro row del
          // mismo insumo (unique por proveedor), así que no hay que tocar más.
          return x;
        });
    setItems(next);
    if (isNew) onItemsCount(next.length);
    setForm(null);
  }

  const headerLine = [
    supplier.contactName,
    supplier.phone,
    supplier.email,
    supplier.paymentTermsDays == null
      ? t("termsCash")
      : t("termsDays", { count: supplier.paymentTermsDays }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <h2 className="font-display text-2xl min-w-0 truncate">
            {supplier.name}
          </h2>
          <div className="flex items-center shrink-0 -mt-1 -mr-2">
            <button
              type="button"
              onClick={onEdit}
              className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-op-muted hover:text-ink"
            >
              {t("edit")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-op-muted text-sm min-h-[44px] min-w-[44px]"
              aria-label={t("cancel")}
            >
              {"✕"}
            </button>
          </div>
        </div>
        <div className="text-[11px] text-op-muted mb-4">{headerLine}</div>

        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
          {t("priceListTitle")}
        </div>

        {loadErr ? (
          <div className="text-xs text-danger">{t("errLoadFailed")}</div>
        ) : items === null ? (
          <div className="py-6 text-center text-sm text-op-muted">
            {t("loading")}
          </div>
        ) : (
          <>
            {items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-6 text-center text-sm text-op-muted">
                {t("priceListEmpty")}
              </div>
            ) : (
              <div className="border border-op-border rounded-2xl overflow-hidden">
                {items.map((item) => {
                  const kind = item.ingredient.measureKind;
                  const unitCost = costPerBaseUnit(
                    item.lastPriceCents,
                    item.contentQty,
                  );
                  const detailsLine = [
                    item.presentationLabel,
                    formatBaseQty(item.contentQty, kind, locale),
                    item.lastPriceCents != null
                      ? formatMoney(item.lastPriceCents, { currency, locale })
                      : null,
                    unitCost != null
                      ? `${formatMoney(unitCost, { currency, locale })}/${BASE_UNIT_SYMBOL[kind]}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-1 px-3 py-2 border-b border-op-border last:border-b-0"
                    >
                      <button
                        type="button"
                        onClick={() => togglePreferred(item)}
                        disabled={busyId === item.id}
                        aria-label={
                          item.preferred
                            ? t("unmarkPreferred")
                            : t("markPreferred")
                        }
                        title={
                          item.preferred
                            ? t("unmarkPreferred")
                            : t("markPreferred")
                        }
                        className={
                          "min-h-[44px] min-w-[36px] text-lg shrink-0 disabled:opacity-40 " +
                          (item.preferred
                            ? "text-[#C98A2E]"
                            : "text-op-muted hover:text-ink")
                        }
                      >
                        {item.preferred ? "★" : "☆"}
                      </button>
                      <div className="flex-1 min-w-0 py-1.5">
                        <div className="text-sm font-medium truncate">
                          {item.ingredient.name}
                        </div>
                        <div className="text-[11px] text-op-muted mt-0.5 truncate">
                          {detailsLine}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setForm({ editing: item })}
                        className="min-h-[44px] px-2 text-[11px] font-medium text-op-muted hover:text-ink shrink-0"
                      >
                        {t("edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(item)}
                        disabled={busyId === item.id}
                        className="min-h-[44px] px-2 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 shrink-0 disabled:opacity-40"
                      >
                        {t("deleteItem")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {rowErr && <div className="text-xs text-danger mt-2">{rowErr}</div>}

            {form ? (
              <ItemForm
                supplierId={supplier.id}
                editing={form.editing}
                ingredients={ingredients ?? []}
                listedIngredientIds={listedIngredientIds}
                currency={currency}
                onCancel={() => setForm(null)}
                onSaved={handleSaved}
              />
            ) : (
              <button
                type="button"
                onClick={() => setForm({ editing: null })}
                className="mt-3 w-full min-h-[44px] rounded-full border border-op-border bg-op-bg text-sm font-medium hover:bg-op-surface"
              >
                {t("addItem")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────── Formulario de fila de la lista de precios ─────────── */

/** Prefill del contenido: unidad grande cuando divide exacto (5000 g → 5 kg). */
function prefillQty(editing: SupplierItem | null): {
  qty: string;
  unit: string;
} {
  if (!editing) return { qty: "", unit: "" };
  const units = DISPLAY_UNITS[editing.ingredient.measureKind];
  const big = units[units.length - 1];
  if (big.factor > 1 && editing.contentQty % big.factor === 0) {
    return { qty: String(editing.contentQty / big.factor), unit: big.symbol };
  }
  return { qty: String(editing.contentQty), unit: units[0].symbol };
}

function ItemForm({
  supplierId,
  editing,
  ingredients,
  listedIngredientIds,
  currency,
  onCancel,
  onSaved,
}: {
  supplierId: string;
  editing: SupplierItem | null;
  ingredients: IngredientRef[];
  listedIngredientIds: Set<string>;
  currency: string;
  onCancel: () => void;
  onSaved: (item: SupplierItem, isNew: boolean) => void;
}) {
  const t = useTranslations("opErp");
  const [selected, setSelected] = useState<IngredientRef | null>(null);
  const [ingQ, setIngQ] = useState("");
  const [presentation, setPresentation] = useState(
    editing?.presentationLabel ?? "",
  );
  const [qty, setQty] = useState<string>(() => prefillQty(editing).qty);
  const [unit, setUnit] = useState<string>(() => prefillQty(editing).unit);
  const [price, setPrice] = useState<string>(
    editing?.lastPriceCents != null ? String(editing.lastPriceCents / 100) : "",
  );
  const [sku, setSku] = useState(editing?.supplierSku ?? "");
  const [preferred, setPreferred] = useState(editing?.preferred ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // En edición el insumo está fijo (unique proveedor+insumo); en creación
  // sale del combobox.
  const ingredient = editing?.ingredient ?? selected;
  const kind = ingredient?.measureKind ?? null;
  const unitOptions = kind ? DISPLAY_UNITS[kind] : [];

  const matches = useMemo(() => {
    const needle = fold(ingQ.trim());
    return ingredients
      .filter((i) => !listedIngredientIds.has(i.id))
      .filter((i) => !needle || fold(i.name).includes(needle))
      .slice(0, 8);
  }, [ingredients, listedIngredientIds, ingQ]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!ingredient || !kind) return;

    const contentQty = toBaseQty(Number(qty.replace(",", ".")), kind, unit);
    if (contentQty == null) {
      setErr(t("errContentInvalid"));
      return;
    }

    let lastPriceCents: number | null = null;
    if (price.trim() !== "") {
      const p = Number(price.replace(",", "."));
      if (!isFinite(p) || p < 0) {
        setErr(t("errSaveFailed"));
        return;
      }
      lastPriceCents = pesosToCents(p);
    }

    const payload: Record<string, unknown> = {
      presentationLabel: presentation.trim(),
      contentQty,
      lastPriceCents,
      supplierSku: sku.trim() || null,
      preferred,
    };
    if (!editing) payload.ingredientId = ingredient.id;

    setBusy(true);
    const r = await fetch(
      editing
        ? `/api/operator/supplier-items/${editing.id}`
        : `/api/operator/suppliers/${supplierId}/items`,
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "already_listed"
          ? t("errAlreadyListed")
          : t("errSaveFailed"),
      );
      return;
    }
    const j = await r.json();
    onSaved(j.item as SupplierItem, !editing);
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-2xl border border-op-border bg-op-bg/50 p-4 space-y-3"
    >
      <div className="font-display text-lg">
        {editing ? t("editPriceItem") : t("addItem")}
      </div>

      <Field label={t("fieldIngredient")} required>
        {editing ? (
          <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg/60 text-sm text-op-muted flex items-center">
            {editing.ingredient.name}
          </div>
        ) : selected ? (
          <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-surface text-sm flex items-center justify-between gap-2">
            <span className="truncate">
              {`${selected.name} (${unitSymbols(selected.measureKind)})`}
            </span>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setIngQ("");
              }}
              className="text-[11px] font-medium text-op-muted hover:text-ink shrink-0"
            >
              {t("changeIngredient")}
            </button>
          </div>
        ) : (
          <div>
            <input
              type="search"
              value={ingQ}
              onChange={(e) => setIngQ(e.target.value)}
              placeholder={t("ingredientSearchPlaceholder")}
              className={inputCls}
            />
            <div className="mt-1 rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
              {matches.length === 0 ? (
                <div className="px-3 py-2 text-xs text-op-muted">
                  {t("noIngredientMatches")}
                </div>
              ) : (
                matches.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      setSelected(i);
                      setUnit(BASE_UNIT_SYMBOL[i.measureKind]);
                    }}
                    className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0"
                  >
                    <span>{i.name}</span>
                    <span className="font-mono text-[10px] text-op-muted ml-2">
                      {unitSymbols(i.measureKind)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </Field>

      <Field label={t("fieldPresentation")} required>
        <input
          type="text"
          required
          value={presentation}
          onChange={(e) => setPresentation(e.target.value)}
          placeholder={t("presentationPlaceholder")}
          maxLength={80}
          className={inputCls}
        />
      </Field>

      <Field label={t("fieldContent")} required hint={t("contentHint")}>
        <div className="flex gap-2">
          <input
            type="number"
            required
            min={0}
            step="any"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            disabled={!kind}
            className={inputCls + " flex-1 disabled:opacity-40"}
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            disabled={!kind || unitOptions.length < 2}
            className="min-h-[44px] w-24 px-3 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
          >
            {unitOptions.map((u) => (
              <option key={u.symbol} value={u.symbol}>
                {u.symbol}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <Field label={`${t("fieldPrice")} (${currency})`}>
        <input
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className={inputCls}
        />
      </Field>

      <Field label={t("fieldSupplierSku")}>
        <input
          type="text"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          maxLength={60}
          className={inputCls}
        />
      </Field>

      <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
        <input
          type="checkbox"
          checked={preferred}
          onChange={(e) => setPreferred(e.target.checked)}
          className="w-4 h-4 accent-ink"
        />
        <span className="text-sm">{t("preferredLabel")}</span>
      </label>

      {err && <div className="text-xs text-danger">{err}</div>}

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          disabled={
            busy ||
            !ingredient ||
            presentation.trim().length === 0 ||
            qty.trim().length === 0
          }
          className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? t("saving") : t("save")}
        </button>
      </div>
    </form>
  );
}

/* ────────────────────────────── UI compartida ──────────────────────── */

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
