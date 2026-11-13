"use client";

// Piezas compartidas de Compras: el campo con etiqueta, las altas rápidas de
// proveedor e insumo, el país del comercio (tarifas de IVA) y los errores del
// POST de creación. Las usan «Nueva orden» (oc/) y la revisión de facturas,
// la recepción y el resto de ComprasClient.

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { BARCODE_MAX_LENGTH } from "@/lib/erp/barcode";
import { DISPLAY_UNITS, MEASURE_KINDS, type MeasureKind } from "@/lib/erp/units";

export type SupplierRef = { id: string; name: string; taxId?: string | null };

/** Lo escrito en el campo de proveedor al pedir «Crear proveedor»: si son
 *  solo dígitos (con puntos, guiones o espacios), es el NIT; si no, el nombre. */
export function splitSupplierText(text: string): { name: string; taxId: string } {
  const trimmed = text.trim();
  return /^[\d.\-\s]+$/.test(trimmed) && /\d/.test(trimmed)
    ? { name: "", taxId: trimmed }
    : { name: trimmed, taxId: "" };
}

export type IngredientRef = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  active: boolean;
  referencePriceCents?: number | null;
};

// Errores del POST de creación → clave i18n (fallback errSaveFailed).
export const API_CREATE_ERROR_KEYS: Record<string, string> = {
  supplier_not_found: "errSupplierNotFound",
  ingredient_not_found: "errIngredientNotFound",
  supplier_item_mismatch: "errSupplierItemMismatch",
  no_lines: "errNoLines",
  line_invalid: "errLineInvalid",
  retention_exceeds_base: "errRetentionExceedsBase",
  retention_exceeds_total: "errRetentionExceedsTotal",
};


/**
 * País del comercio (para las tarifas de IVA del picker). Se lee de los
 * ajustes de compras al montar; default CO mientras carga o si falla. El
 * país solo define las opciones de tarifa, así que un fallback razonable
 * es suficiente y no bloquea la UI.
 */
export function usePurchaseCountry(): string {
  const [country, setCountry] = useState<string>("CO");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/purchasing-settings");
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && typeof j.country === "string") setCountry(j.country);
      } catch {
        // Sin país: se mantiene el default CO. No es bloqueante.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return country;
}

/* ────────────────────────────── UI compartida ──────────────────────── */

export function Field({
  label,
  required,
  hint,
  group = false,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  group?: boolean;
  children: React.ReactNode;
}) {
  // Pickers contain several buttons and change their children on selection.
  // A wrapping label can forward the click to the newly rendered "change"
  // button in Safari and immediately undo the selection.
  const labelId = useId();
  const Container = group ? "div" : "label";
  return (
    <Container className="block" role={group ? "group" : undefined} aria-labelledby={group ? labelId : undefined}>
      <div id={labelId} className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </Container>
  );
}

/* ────────────── Crear proveedor / insumo inline (mini-forms) ────────── */

/**
 * Alta de proveedor sin salir de la creación de OC: Nombre (req.), NIT
 * (opc.) y plazo de pago en días (opc.). Entrega el proveedor devuelto por
 * el API a `onCreated` (que lo elige y dispara su lista de precios).
 */
export function SupplierInlineForm({
  initialName,
  initialTaxId,
  onCreated,
  onCancel,
}: {
  initialName?: string;
  /** NIT escrito en el campo de proveedor (si lo escrito eran dígitos). */
  initialTaxId?: string;
  onCreated: (s: SupplierRef) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("opErp");
  const [name, setName] = useState(initialName ?? "");
  const [taxId, setTaxId] = useState(initialTaxId ?? "");
  const [termsRaw, setTermsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(t("errLineInvalid"));
      return;
    }
    const terms = termsRaw.trim();
    const paymentTermsDays = terms === "" ? undefined : Number(terms);
    if (
      paymentTermsDays !== undefined &&
      (!Number.isInteger(paymentTermsDays) ||
        paymentTermsDays < 0 ||
        paymentTermsDays > 365)
    ) {
      setErr(t("errLineInvalid"));
      return;
    }
    setErr(null);
    setBusy(true);
    const r = await fetch("/api/operator/suppliers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: trimmed,
        taxId: taxId.trim() || undefined,
        paymentTermsDays,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        (j as { error?: string }).error === "name_taken"
          ? t("errSupplierNameTaken")
          : t("errSaveFailed"),
      );
      return;
    }
    const j = (await r.json()) as { supplier: SupplierRef };
    onCreated({ id: j.supplier.id, name: j.supplier.name, taxId: j.supplier.taxId ?? null });
  }

  return (
    <div className="mt-2 rounded-xl border border-op-border bg-op-bg/50 p-3 space-y-2">
      <Field label={t("fieldName")} required>
        <input
          type="text"
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
          value={termsRaw}
          onChange={(e) => setTermsRaw(e.target.value)}
          className={inputCls}
        />
      </Field>
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="mp-btn mp-btn--sm mp-btn--secondary"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={create}
          disabled={busy || name.trim() === ""}
          className="mp-btn mp-btn--sm mp-btn--primary"
        >
          {busy ? t("creating") : t("inlineCreate")}
        </button>
      </div>
    </div>
  );
}

// Clave i18n por dimensión — mismas labels que el editor de insumos.
const DIM_LABEL_KEYS: Record<MeasureKind, string> = {
  mass: "dimMass",
  volume: "dimVolume",
  count: "dimCount",
};

/** Insumo que ya existe con ese nombre o ese código (mismo comercio). */
export type IngredientConflict = {
  kind: "name" | "barcode";
  ingredient: { id: string; name: string; active: boolean };
};

function conflictIngredient(value: unknown): IngredientConflict["ingredient"] | null {
  const item = value as Partial<IngredientConflict["ingredient"]> | null | undefined;
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !item.name) return null;
  return { id: item.id, name: item.name, active: item.active !== false };
}

/**
 * Alta de insumo sin salir de donde se está: Nombre (req.), tipo de medida
 * (req.) y categoría (opc.). Entrega el insumo devuelto por el API a
 * `onCreated` (que lo suma a la lista y lo deja elegido).
 *
 * La usan la línea libre de «Nueva orden» y el conteo físico. Para el
 * conteo se prenden las piezas opcionales: código de barras (`withBarcode`),
 * categorías existentes como sugerencias (`categories`), las unidades junto
 * a la dimensión (`showUnits`), una nota bajo la categoría (`categoryNote`)
 * y, si el nombre o el código ya son de otro insumo, las acciones que el
 * conteo ofrece sobre el existente (`conflictActions`).
 */
export function IngredientInlineForm({
  initialName,
  onCreated,
  onCancel,
  withBarcode = false,
  initialBarcode,
  categories,
  initialCategory,
  showUnits = false,
  categoryNote,
  conflictActions,
}: {
  initialName?: string;
  onCreated: (ing: IngredientRef) => void;
  onCancel: () => void;
  withBarcode?: boolean;
  initialBarcode?: string;
  categories?: readonly string[];
  initialCategory?: string;
  showUnits?: boolean;
  categoryNote?: (category: string) => string | null;
  conflictActions?: (conflict: IngredientConflict, busy: boolean) => React.ReactNode;
}) {
  const t = useTranslations("opErp");
  const listId = useId();
  const [name, setName] = useState(initialName ?? "");
  const [measureKind, setMeasureKind] = useState<MeasureKind>("mass");
  const [category, setCategory] = useState(initialCategory ?? "");
  const [barcode, setBarcode] = useState(initialBarcode ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<IngredientConflict | null>(null);
  const note = categoryNote?.(category.trim()) ?? null;

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(t("errLineInvalid"));
      return;
    }
    setErr(null);
    setConflict(null);
    setBusy(true);
    let r: Response;
    try {
      r = await fetch("/api/operator/ingredients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          measureKind,
          category: category.trim() || undefined,
          // Crudo: la API es la que limpia lo que teclea el lector.
          ...(withBarcode && barcode.trim() ? { barcode } : {}),
        }),
      });
    } catch {
      setBusy(false);
      setErr(t("errSaveFailed"));
      return;
    }
    setBusy(false);
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string; existing?: unknown; owner?: unknown };
      const existing = j.error === "name_taken" ? conflictIngredient(j.existing) : j.error === "barcode_taken" ? conflictIngredient(j.owner) : null;
      if (existing && conflictActions) {
        const kind = j.error === "name_taken" ? "name" : "barcode";
        setConflict({ kind, ingredient: existing });
        setErr(t(
          kind === "name"
            ? (existing.active ? "ingredientNameTakenBy" : "ingredientNameTakenByArchived")
            : (existing.active ? "ingredientCodeTakenBy" : "ingredientCodeTakenByArchived"),
          { name: existing.name },
        ));
        return;
      }
      setErr(
        j.error === "name_taken"
          ? t("errNameTaken")
          : j.error === "barcode_taken"
            ? (existing ? t(existing.active ? "errBarcodeTakenBy" : "errBarcodeTakenByArchived", { name: existing.name }) : t("errBarcodeTaken"))
            : t("errSaveFailed"),
      );
      return;
    }
    const j = (await r.json()) as { ingredient: IngredientRef };
    onCreated({
      id: j.ingredient.id,
      name: j.ingredient.name,
      measureKind: j.ingredient.measureKind,
      active: true,
    });
  }

  return (
    <div className="mt-2 rounded-xl border border-op-border bg-op-bg/50 p-3 space-y-2">
      <Field label={t("fieldName")} required>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setConflict(null); }}
          placeholder={t("namePlaceholder")}
          maxLength={120}
          className={inputCls}
        />
      </Field>
      <Field label={t("fieldMeasure")} required>
        <select
          value={measureKind}
          onChange={(e) => setMeasureKind(e.target.value as MeasureKind)}
          className={inputCls}
        >
          {MEASURE_KINDS.map((k) => (
            <option key={k} value={k}>
              {showUnits ? `${t(DIM_LABEL_KEYS[k])} — ${DISPLAY_UNITS[k].map((u) => u.symbol).join("/")}` : t(DIM_LABEL_KEYS[k])}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("fieldCategory")} hint={note ?? undefined}>
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder={t("categoryPlaceholder")}
          maxLength={60}
          list={categories?.length ? listId : undefined}
          className={inputCls}
        />
        {categories && categories.length > 0 && (
          <datalist id={listId}>
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        )}
      </Field>
      {withBarcode && (
        <Field label={t("fieldBarcode")}>
          <input
            type="text"
            value={barcode}
            onChange={(e) => { setBarcode(e.target.value); setConflict(null); }}
            placeholder={t("barcodePlaceholder")}
            maxLength={BARCODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className={inputCls + " font-mono"}
          />
        </Field>
      )}
      {err && <div role="alert" className="text-xs text-danger">{err}</div>}
      {conflict && conflictActions?.(conflict, busy)}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="mp-btn mp-btn--sm mp-btn--secondary"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={create}
          disabled={busy || name.trim() === ""}
          className="mp-btn mp-btn--sm mp-btn--primary"
        >
          {busy ? t("creating") : t("inlineCreate")}
        </button>
      </div>
    </div>
  );
}

export const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
