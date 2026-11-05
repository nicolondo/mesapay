"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon } from "@/components/ui/Icon";
import { REFERENCE_PRICE_QTY_BASE, referencePriceUnit } from "@/lib/erp/ingredientPrice";
import type { MenuTax } from "@/lib/erp/recipeDetail";
import {
  buildLinesPayload,
  draftFingerprint,
  editLineFromItem,
  newEditLine,
  type CostDto,
  type DishRow,
  type EditLine,
  type IngredientOption,
  type ModLine,
  type ParseError,
  type RecipeDto,
} from "../recipeModel";
import { buildLineViews, resolveCost, type LineView, type ResolvedCost } from "./lineView";
import { CostSummary, MissingCostBanner } from "./CostSummary";
import { LinesTable, type LinesCtl } from "./LinesTable";
import { AddIngredientSheet, LineCards, LineEditSheet } from "./LineCards";
import { ModifiersSection } from "./ModifiersSection";
import { WarningIcon } from "./icons";
import { useLineCopy } from "./lineCopy";
import { DESKTOP_QUERY, useMediaQuery } from "./useMediaQuery";

// Errores del PUT de receta → clave i18n (fallback errSaveFailed).
const API_ERROR_KEYS: Record<string, string> = {
  invalid: "errLineInvalid",
  duplicate_ingredient: "errDuplicateIngredient",
  ingredient_not_found: "errIngredientNotFound",
  menu_item_not_found: "errMenuItemNotFound",
};

type ItemPayload = { ingredientId: string; qtyBase: number; wastePct: number };
type ModItemPayload = ItemPayload & { modifierId: string; optLabel: string };

type AddTarget =
  | { kind: "base" }
  | { kind: "mod"; modifierId: string; optLabel: string };

/**
 * Detalle de la receta de un plato. En escritorio, un diálogo ancho:
 * cabecera con el plato y sus distintivos, la franja de costos siempre a la
 * vista, un aviso único si faltan costos, la tabla de líneas (una fila por
 * insumo, con el buscador al final) y, debajo, los insumos por modificador
 * y las notas. En el celular, pantalla completa con la franja fija arriba,
 * tarjetas por línea que se editan en una hoja y el botón Guardar abajo.
 *
 * Guardar es explícito (el PUT de siempre reemplaza la receta completa y
 * cierra); cerrar con cambios sin guardar pide confirmación.
 */
export function RecipeDetail({
  dish,
  ingredients,
  subRecipeIds,
  currency,
  tax,
  onClose,
  onSaved,
  onCostFixed,
}: {
  dish: DishRow;
  ingredients: IngredientOption[];
  /** Insumos que tienen sub-receta (preparaciones propias). */
  subRecipeIds: ReadonlySet<string>;
  currency: string;
  tax: MenuTax;
  onClose: () => void;
  onSaved: (menuItemId: string, recipe: RecipeDto | null, cost: CostDto | null) => void;
  /** Se corrigió el costo de un insumo: la lista recarga costos y catálogo. */
  onCostFixed: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const copy = useLineCopy();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const notesId = useId();
  const money = (c: number) => formatMoney(c, { currency, locale });

  const catalog = useMemo(() => {
    const m = new Map<string, IngredientOption>();
    for (const i of ingredients) m.set(i.id, i);
    return m;
  }, [ingredients]);

  /* ── Borrador ── */
  const [initial] = useState(() => {
    const ls = (dish.recipe?.items ?? []).map((it) =>
      editLineFromItem(it, catalog, dish.cost?.lines),
    );
    const ms: ModLine[] = (dish.recipe?.modifierItems ?? []).map((it) => ({
      ...editLineFromItem({ ...it, qtyBase: Math.abs(it.qtyBase) }, catalog, undefined),
      modifierId: it.modifierId,
      optLabel: it.optLabel,
      sign: it.qtyBase < 0 ? -1 : 1,
    }));
    const n = dish.recipe?.notes ?? "";
    return { lines: ls, modLines: ms, notes: n, print: draftFingerprint(ls, ms, n) };
  });
  const [lines, setLines] = useState<EditLine[]>(initial.lines);
  const [modLines, setModLines] = useState<ModLine[]>(initial.modLines);
  const [notes, setNotes] = useState(initial.notes);
  const dirty = draftFingerprint(lines, modLines, notes) !== initial.print;

  /* ── Costos corregidos acá mismo ──
     Al guardar un precio de referencia la línea se recostea al instante;
     cuando la lista recarga el catálogo (nuevo `ingredients`), manda el
     costo resuelto por el server y lo local se descarta. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ResolvedCost>>(
    () => new Map(),
  );
  const [seenIngredients, setSeenIngredients] = useState(ingredients);
  if (seenIngredients !== ingredients) {
    setSeenIngredients(ingredients);
    setOverrides(new Map());
  }

  const { views, summary } = useMemo(
    () =>
      buildLineViews(
        lines,
        (l) => resolveCost(l, overrides, catalog),
        dish.priceCents,
        tax,
      ),
    [lines, overrides, catalog, dish.priceCents, tax],
  );
  const modViews = useMemo(
    () =>
      buildLineViews(modLines, (l) => resolveCost(l, overrides, catalog), 0, null)
        .views,
    [modLines, overrides, catalog],
  );

  /* ── Estado de la pantalla ── */
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());
  const [fixOpen, setFixOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [confirm, setConfirm] = useState<null | "discard" | "delete">(null);
  // Celular: hoja de una línea y hoja para agregar.
  const [editing, setEditing] = useState<{ key: number; isNew: boolean; mod: boolean } | null>(null);
  const [adding, setAdding] = useState<AddTarget | null>(null);
  // Foco pendiente tras un render (fila nueva → su cantidad; corregir costo).
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    pendingFocus.current = null;
    const el = rootRef.current?.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.focus({ preventScroll: true });
  });

  // Cambios sin guardar: también al recargar o cerrar la pestaña.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /* ── Líneas ── */
  const usedBase = useMemo(() => new Set(lines.map((l) => l.ingredientId)), [lines]);
  const baseOptions = useMemo(
    () => ingredients.filter((i) => !usedBase.has(i.id)),
    [ingredients, usedBase],
  );

  function clearMessages() {
    setErr(null);
    setNotice(null);
  }

  function addLine(ing: IngredientOption) {
    clearMessages();
    const line = newEditLine(ing);
    setLines((prev) => [...prev, line]);
    if (desktop) pendingFocus.current = `[data-line="${line.key}"] [data-col="qty"]`;
    else setEditing({ key: line.key, isNew: true, mod: false });
  }

  function addModLine(modifierId: string, optLabel: string, ing: IngredientOption) {
    clearMessages();
    const line: ModLine = { ...newEditLine(ing), modifierId, optLabel, sign: 1 };
    setModLines((prev) => [...prev, line]);
    if (desktop) pendingFocus.current = `[data-line="${line.key}"] [data-col="qty"]`;
    else setEditing({ key: line.key, isNew: true, mod: true });
  }

  function touch(key: number) {
    setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }

  function toggleFix(key: number) {
    setFixOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function fixSaved(v: LineView, referencePriceCents: number) {
    const { ingredientId, ingredientName, measureKind } = v.line;
    setOverrides((prev) =>
      new Map(prev).set(ingredientId, {
        costPerBase: referencePriceCents / REFERENCE_PRICE_QTY_BASE,
        costSource: "reference",
      }),
    );
    // La corrección vale para todas las líneas del mismo insumo.
    const sameIngredient = new Set(
      [...lines, ...modLines]
        .filter((l) => l.ingredientId === ingredientId)
        .map((l) => l.key),
    );
    const stillOpen = [...fixOpen].filter((k) => !sameIngredient.has(k));
    setFixOpen(new Set(stillOpen));
    // El foco no se pierde: va a la siguiente corrección abierta o, si no
    // queda ninguna, a la cantidad de la línea recién costeada.
    pendingFocus.current =
      stillOpen.length > 0
        ? `[data-line="${stillOpen[0]}"] [data-testid="recipe-cost-fix"] input`
        : `[data-line="${v.line.key}"] [data-col="qty"]`;
    setErr(null);
    setNotice(
      t("rdFixSavedNotice", {
        name: ingredientName,
        price: `${money(referencePriceCents)}/${referencePriceUnit(measureKind)}`,
      }),
    );
    onCostFixed();
  }

  const visibleError = (v: LineView) => {
    if (v.error == null) return false;
    if (showErrors) return true;
    // Una cantidad vacía no es un error hasta que se intenta guardar.
    if (v.error === "qty_invalid" && v.line.qtyRaw.trim() === "") return false;
    return touched.has(v.line.key);
  };

  const shared = {
    currency,
    subRecipeIds,
    visibleError,
    fixOpen,
    toggleFix,
    fixSaved,
    touch,
  };
  const baseCtl: LinesCtl<EditLine> = {
    ...shared,
    patch: (key, patch) => {
      clearMessages();
      setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    },
    remove: (key) => {
      clearMessages();
      setLines((prev) => prev.filter((l) => l.key !== key));
    },
  };
  const modCtl: LinesCtl<ModLine> = {
    ...shared,
    patch: (key, patch) => {
      clearMessages();
      setModLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    },
    remove: (key) => {
      clearMessages();
      setModLines((prev) => prev.filter((l) => l.key !== key));
    },
    toggleSign: (key) => {
      clearMessages();
      setModLines((prev) =>
        prev.map((l) => (l.key === key ? { ...l, sign: l.sign === -1 ? 1 : -1 } : l)),
      );
    },
  };

  /** «Poner precios»: abre la corrección de cada insumo sin costo. */
  function fixMissing() {
    const missing = views.filter((v) => v.state !== "ok");
    const first = missing[0];
    if (!first) return;
    if (desktop) {
      setFixOpen(new Set(missing.map((v) => v.line.key)));
      pendingFocus.current = `[data-line="${first.line.key}"] [data-testid="recipe-cost-fix"] input`;
    } else {
      setEditing({ key: first.line.key, isNew: false, mod: false });
    }
  }

  /* ── Guardar / eliminar / cerrar ── */
  function failOn(line: EditLine, error: ParseError, mod: boolean) {
    setShowErrors(true);
    setNotice(null);
    setErr(`${line.ingredientName}: ${copy.error(line, error)}`);
    if (desktop) {
      const col = error === "waste_invalid" ? "waste" : "qty";
      pendingFocus.current = `[data-line="${line.key}"] [data-col="${col}"]`;
      // Fuerza un render para que el efecto de foco corra.
      setTouched((prev) => new Set(prev).add(line.key));
    } else {
      setEditing({ key: line.key, isNew: false, mod });
    }
  }

  async function put(body: {
    items: ItemPayload[];
    modifierItems?: ModItemPayload[];
    notes: string | null;
  }): Promise<Response> {
    return fetch(`/api/operator/recipes/dish/${dish.menuItemId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function apiError(r: Response): Promise<string> {
    const j = await r.json().catch(() => ({}));
    const key = API_ERROR_KEYS[(j as { error?: string }).error ?? ""];
    return key ? t(key) : t("errSaveFailed");
  }

  async function save() {
    if (busy || deleting) return;
    clearMessages();
    const base = buildLinesPayload(lines, (l, p) => ({
      ingredientId: l.ingredientId,
      qtyBase: p.qtyBase,
      wastePct: p.wastePct,
    }));
    if (!base.ok) return failOn(base.line, base.error, false);
    if (base.items.length === 0) return;
    // Deltas de modificador: qtyBase con signo (sign −1 = quitar).
    const mods = buildLinesPayload(modLines, (l, p) => ({
      modifierId: l.modifierId,
      optLabel: l.optLabel,
      ingredientId: l.ingredientId,
      qtyBase: (l.sign === -1 ? -1 : 1) * p.qtyBase,
      wastePct: p.wastePct,
    }));
    if (!mods.ok) return failOn(mods.line, mods.error, true);

    setBusy(true);
    try {
      const r = await put({
        items: base.items,
        modifierItems: mods.items,
        notes: notes.trim() || null,
      });
      if (!r.ok) {
        setErr(await apiError(r));
        return;
      }
      const j = await r.json();
      // El PUT devuelve items sin nombre/dimensión (a diferencia del GET):
      // se enriquecen desde las líneas recién validadas.
      const raw = j.recipe as {
        id: string;
        notes: string | null;
        items: ItemPayload[];
        modifierItems: ModItemPayload[];
      };
      const meta = (id: string) =>
        lines.find((l) => l.ingredientId === id) ??
        modLines.find((l) => l.ingredientId === id);
      const enrich = <T extends ItemPayload>(it: T) => ({
        ...it,
        ingredientName: meta(it.ingredientId)?.ingredientName ?? "",
        measureKind: meta(it.ingredientId)?.measureKind ?? "count",
      });
      const recipe: RecipeDto = {
        id: raw.id,
        notes: raw.notes,
        items: raw.items.map(enrich),
        modifierItems: (raw.modifierItems ?? []).map(enrich),
      };
      onSaved(dish.menuItemId, recipe, j.cost as CostDto);
    } catch {
      setErr(t("errSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Borrado = PUT con items: [] (contrato del API); el plato queda sin receta.
  async function deleteRecipe() {
    setConfirm(null);
    clearMessages();
    setDeleting(true);
    try {
      const r = await put({ items: [], notes: null });
      if (!r.ok) {
        setErr(await apiError(r));
        return;
      }
      onSaved(dish.menuItemId, null, null);
    } catch {
      setErr(t("errSaveFailed"));
    } finally {
      setDeleting(false);
    }
  }

  function requestClose() {
    if (busy || deleting) return;
    if (dirty) setConfirm("discard");
    else onClose();
  }

  const anyBusy = busy || deleting;
  const canSave = !anyBusy && lines.length > 0;

  /* ── Piezas ── */
  const chips = (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusChip tone={dish.available ? "ok" : "muted"}>
        {dish.available ? t("rdAvailable") : t("unavailableBadge")}
      </StatusChip>
      {dish.recipe === null && <StatusChip tone="muted">{t("rdNewRecipe")}</StatusChip>}
      {/* En el celular el aviso de abajo ya lo dice (y deja corregirlo). */}
      {desktop && summary.missingCount > 0 && (
        <StatusChip tone="warn">
          <WarningIcon size={12} />
          {t("rdIncompleteChip", { count: summary.missingCount })}
        </StatusChip>
      )}
    </div>
  );

  const banner = (
    <MissingCostBanner
      missing={summary.missingCount}
      zero={summary.zeroCount}
      onFix={fixMissing}
      compact={!desktop}
    />
  );

  const linesBlock = desktop ? (
    <LinesTable
      views={views}
      ctl={baseCtl}
      addOptions={baseOptions}
      onAdd={addLine}
      addPlaceholder={t("rdAddPlaceholder")}
      total={{ cents: summary.totalCents, complete: summary.complete }}
      emptyText={t("noRecipeLinesYet")}
      testId="recipe-lines"
    />
  ) : (
    <div className="space-y-2">
      {views.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-4 text-center text-sm text-op-muted">
          {t("noRecipeLinesYet")}
        </div>
      ) : (
        <LineCards
          views={views}
          ctl={baseCtl}
          onEdit={(key) => setEditing({ key, isNew: false, mod: false })}
          testId="recipe-lines"
        />
      )}
      <button
        type="button"
        onClick={() => setAdding({ kind: "base" })}
        className="w-full min-h-[48px] rounded-xl border border-dashed border-op-border-2 text-[15px] font-medium text-op-text inline-flex items-center justify-center gap-2 active:bg-op-bg"
      >
        <Icon name="plus" width={16} height={16} />
        {t("rdAddIngredient")}
      </button>
    </div>
  );

  const extras = (
    <>
      {/* Los deltas de modificador cuelgan de la receta base: sin base no
          se puede guardar y el server borraría la receta. */}
      {lines.length > 0 && (
        <ModifiersSection
          modifiers={dish.modifiers}
          views={modViews}
          ctl={modCtl}
          catalog={ingredients}
          desktop={desktop}
          onAdd={addModLine}
          onEdit={(key) => setEditing({ key, isNew: false, mod: true })}
          onAddMobile={(modifierId, optLabel) =>
            setAdding({ kind: "mod", modifierId, optLabel })
          }
        />
      )}
      <div>
        <label htmlFor={notesId} className="block text-sm font-semibold mb-1.5">
          {t("fieldNotes")}
        </label>
        <textarea
          id={notesId}
          value={notes}
          onChange={(e) => {
            clearMessages();
            setNotes(e.target.value);
          }}
          maxLength={1000}
          rows={2}
          placeholder={t("rdNotesPlaceholder")}
          className="w-full px-3 py-2 rounded-[var(--radius-btn)] border border-op-border bg-op-bg text-base lg:text-sm focus:outline-none focus:border-op-text/40"
        />
      </div>
    </>
  );

  const status = (
    <div aria-live="polite" className="min-w-0 text-[13px] leading-5">
      {err ? (
        <span role="alert" className="inline-flex items-center gap-1.5 text-danger">
          {err}
        </span>
      ) : notice ? (
        <span className="text-ok">{notice}</span>
      ) : dirty ? (
        <span className="inline-flex items-center gap-1.5 text-op-muted">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-op-accent" />
          {t("rdUnsaved")}
        </span>
      ) : null}
    </div>
  );

  const deleteButton = dish.recipe !== null && (
    <button
      type="button"
      onClick={() => setConfirm("delete")}
      disabled={anyBusy}
      className="mp-btn mp-btn--ghost mp-btn--sm text-danger! hover:bg-danger/10!"
    >
      {deleting ? t("deleting") : t("deleteRecipe")}
    </button>
  );

  // Hojas del celular.
  const editingView =
    editing && !desktop
      ? (editing.mod ? modViews : views).find((v) => v.line.key === editing.key)
      : undefined;
  const addOptionsFor = (target: AddTarget): IngredientOption[] => {
    if (target.kind === "base") return baseOptions;
    const used = new Set(
      modLines
        .filter((l) => l.modifierId === target.modifierId && l.optLabel === target.optLabel)
        .map((l) => l.ingredientId),
    );
    return ingredients.filter((i) => !used.has(i.id));
  };

  return (
    <>
      <AppDialog
        label={dish.name}
        onClose={requestClose}
        className="m-0! inset-0! w-screen! max-w-none! h-dvh! max-h-none! overflow-hidden! rounded-none! border-0! lg:m-auto! lg:w-[min(1320px,calc(100vw-48px))]! lg:h-fit! lg:max-h-[calc(100dvh-48px)]! lg:rounded-[18px]! lg:border!"
      >
        <div
          ref={rootRef}
          aria-labelledby={titleId}
          className="flex flex-col h-full min-h-0 lg:h-auto lg:max-h-[calc(100dvh-48px)] pt-[env(safe-area-inset-top)] lg:pt-0"
          data-testid="recipe-detail"
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter (o + S) guarda desde cualquier campo.
            if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return;
            if (e.key !== "Enter" && e.key.toLowerCase() !== "s") return;
            e.preventDefault();
            if (canSave) void save();
          }}
        >
          <header
            className={
              "shrink-0 border-b border-op-border " +
              (desktop ? "px-6 pt-5 pb-4 space-y-4" : "px-4 pt-3 pb-3 space-y-2.5")
            }
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <h2
                  id={titleId}
                  className={
                    "font-display leading-tight break-words " +
                    (desktop ? "text-[30px]" : "text-[26px]")
                  }
                >
                  {dish.name}
                </h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[13px] text-op-muted">
                    {desktop
                      ? dish.category.label
                      : `${dish.category.label} · ${money(dish.priceCents)}`}
                  </span>
                  {chips}
                </div>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label={t("rdClose")}
                className="mp-icobtn -mr-1 shrink-0"
              >
                <Icon name="close" width={18} height={18} />
              </button>
            </div>
            <CostSummary
              summary={summary}
              lineCount={lines.length}
              tax={tax}
              currency={currency}
              compact={!desktop}
            />
            {banner}
          </header>

          <div
            className={
              "flex-1 min-h-0 overflow-y-auto overscroll-contain " +
              (desktop ? "px-4 pb-6 space-y-6" : "px-4 pt-3 pb-6 space-y-5")
            }
          >
            <section aria-label={t("linesTitle")}>
              {!desktop && (
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h3 className="text-sm font-semibold">{t("linesTitle")}</h3>
                  <span className="text-[12px] text-op-muted">{t("rdLinesHintShort")}</span>
                </div>
              )}
              {linesBlock}
              {desktop && (
                <p className="px-3 mt-2 text-[12px] text-op-muted">{t("recipeLinesHint")}</p>
              )}
            </section>
            <div className={desktop ? "px-2 space-y-6" : "space-y-5"}>{extras}</div>
            {!desktop && deleteButton && <div className="pt-1">{deleteButton}</div>}
          </div>

          <footer
            className={
              "shrink-0 border-t border-op-border bg-op-surface " +
              (desktop
                ? "px-6 py-3 flex items-center gap-4"
                : "px-4 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] space-y-2")
            }
          >
            {desktop ? (
              <>
                {deleteButton}
                <span className="hidden xl:inline-flex flex-wrap items-center gap-x-1.5 text-[11px] text-op-muted">
                  {t.rich("rdKbdHint", {
                    kbd: (chunks) => (
                      <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-op-border bg-op-bg text-op-text">
                        {chunks}
                      </kbd>
                    ),
                  })}
                </span>
                <div className="flex-1 min-w-0 flex justify-end">{status}</div>
                <button
                  type="button"
                  onClick={requestClose}
                  disabled={anyBusy}
                  className="mp-btn mp-btn--secondary"
                >
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!canSave}
                  className="mp-btn mp-btn--primary min-w-[120px]"
                  data-testid="recipe-save"
                >
                  {busy ? t("saving") : t("save")}
                </button>
              </>
            ) : (
              <>
                {status}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={requestClose}
                    disabled={anyBusy}
                    className="mp-btn mp-btn--secondary flex-1"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!canSave}
                    className="mp-btn mp-btn--primary flex-[2]"
                    data-testid="recipe-save"
                  >
                    {busy ? t("saving") : t("save")}
                  </button>
                </div>
              </>
            )}
          </footer>
        </div>
      </AppDialog>

      {editingView && editing && (
        <LineEditSheet
          view={editingView}
          ctl={editing.mod ? (modCtl as LinesCtl<EditLine>) : baseCtl}
          isNew={editing.isNew}
          signed={editing.mod}
          onClose={() => setEditing(null)}
          onAddAnother={() => {
            const line = editingView.line as EditLine & Partial<ModLine>;
            setEditing(null);
            setAdding(
              editing.mod && line.modifierId && line.optLabel
                ? { kind: "mod", modifierId: line.modifierId, optLabel: line.optLabel }
                : { kind: "base" },
            );
          }}
        />
      )}

      {adding && !desktop && (
        <AddIngredientSheet
          title={
            adding.kind === "base"
              ? t("rdAddIngredient")
              : t("rdAddToOption", { option: adding.optLabel })
          }
          options={addOptionsFor(adding)}
          subRecipeIds={subRecipeIds}
          currency={currency}
          onClose={() => setAdding(null)}
          onPick={(ing) => {
            const target = adding;
            setAdding(null);
            if (target.kind === "base") addLine(ing);
            else addModLine(target.modifierId, target.optLabel, ing);
          }}
        />
      )}

      {confirm === "discard" && (
        <ConfirmDialog
          title={t("rdDiscardTitle")}
          body={t("rdDiscardBody", { name: dish.name })}
          cancelLabel={t("rdDiscardKeep")}
          confirmLabel={t("rdDiscardConfirm")}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            onClose();
          }}
        />
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title={t("rdDeleteTitle")}
          body={t("confirmDeleteRecipe")}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteRecipe")}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteRecipe()}
        />
      )}
    </>
  );
}

function StatusChip({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "bg-ok/10 text-ok"
      : tone === "warn"
        ? "bg-warn/15 text-[#7F5A1F]"
        : "bg-op-bg text-op-muted border border-op-border";
  return (
    <span
      className={
        "inline-flex items-center gap-1 h-6 px-2 rounded-md text-[12px] font-medium " + cls
      }
    >
      {children}
    </span>
  );
}

/** Confirmación centrada (descartar cambios, eliminar la receta). */
function ConfirmDialog({
  title,
  body,
  cancelLabel,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AppDialog label={title} onClose={onCancel} placement="center" className="rounded-2xl">
      <div className="p-5" data-testid="recipe-confirm">
        <h3 className="font-display text-2xl leading-tight">{title}</h3>
        <p className="mt-2 text-sm text-op-muted">{body}</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="mp-btn mp-btn--secondary w-full sm:w-auto"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              "mp-btn w-full sm:w-auto " +
              (danger ? "mp-btn--danger-solid" : "mp-btn--primary")
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </AppDialog>
  );
}
