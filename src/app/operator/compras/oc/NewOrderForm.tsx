"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney, isZeroDecimalCurrency } from "@/lib/format";
import { moneySeparators } from "@/lib/moneyInput";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon } from "@/components/ui/Icon";
import { SupplierCombobox } from "@/components/suppliers/SupplierCombobox";
import { DuplicateDocumentAlert, useDuplicateDocumentCheck } from "@/components/suppliers/DuplicateDocumentAlert";
import { parseDuplicateConflict, type DuplicateConflict } from "@/lib/erp/documentNumber";
import { purchaseTaxRates } from "@/lib/erp/purchaseTax";
import { DEFAULT_INC_PCT, type LineTaxChoice } from "@/lib/erp/purchaseLineTax";
import { retentionTotalCents } from "@/lib/erp/purchaseRetentions";
import { habitualHistoryItems, type SupplierHistory } from "@/lib/erp/supplierHistory";
import type { MeasureKind } from "@/lib/erp/units";
import { DiscountControl } from "../DiscountControl";
import {
  InvoiceRetentionsEditor,
  useInvoiceRetentions,
  usePurchaseTaxContext,
  useRetentionRows,
} from "../purchaseTaxUi";
import {
  API_CREATE_ERROR_KEYS,
  IngredientInlineForm,
  inputCls,
  splitSupplierText,
  SupplierInlineForm,
  usePurchaseCountry,
  type IngredientRef,
  type SupplierRef,
} from "../shared";
import {
  blankLine,
  buildCreateOrderPayload,
  centsToRaw,
  changeUnit,
  detachLine,
  draftTotals,
  duplicateOf,
  ingredientOptions,
  insertBlankAfter,
  isBlankLine,
  lineIssues,
  linesForIngredients,
  mergeLines,
  nextKey,
  patchLine,
  pickIngredient,
  removeLine,
  resolveLines,
  suggestPrice,
  type GridKeyAction,
  type LineIssues,
  type OcCatalog,
  type OcCol,
  type OcIngredient,
  type OcLine,
  type OcOption,
  type OcSupplierItem,
} from "./draft";
import type { LineCtl } from "./lineCtl";
import { LinesTable } from "./LinesTable";
import { LineCards, LineEditorSheet } from "./LineCards";
import { OrderFooter } from "./OrderFooter";
import { DESKTOP_QUERY, useMediaQuery, WIDE_QUERY } from "./useMediaQuery";

type ApiIngredient = IngredientRef & { measureKind: MeasureKind };
type ApiSupplierItem = {
  id: string;
  presentationLabel: string;
  contentQty: number;
  lastPriceCents: number | null;
  ingredient: { id: string; name: string; measureKind: MeasureKind; active: boolean };
};
type ReorderGroup = { supplierId: string; lines: { ingredientId: string; presentations: number }[] };
type Notice = { text: string; undo?: OcLine[] };
type SectionId = "discount" | "retentions" | "notes";

const EMPTY_HISTORY: SupplierHistory = { orderCount: 0, items: [] };

/**
 * «Nueva orden de compra». En escritorio, un diálogo ancho: arriba el
 * proveedor, la entrega (o la factura, con «Ya recibí esta mercancía»);
 * en el medio una tabla con una fila por producto que se llena con el
 * teclado; al lado (o debajo) el descuento sobre el total, los impuestos y
 * retenciones y las notas, plegables; y abajo, fijos, los totales y el
 * botón. En el celular, tarjetas de dos renglones que se editan en una hoja
 * y una barra fija con el total. El cuerpo del POST es el de siempre
 * (oc/draft.ts → buildCreateOrderPayload).
 */
export function NewOrderForm({
  suppliers,
  currency,
  onClose,
  onCreated,
}: {
  suppliers: SupplierRef[];
  currency: string;
  onClose: () => void;
  onCreated: (orderId: string) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const dec = moneySeparators().decimal;
  // Precios calculados (última orden, cambio de unidad) a pesos enteros en COP.
  const fmt = useMemo(() => ({ dec, step: isZeroDecimalCurrency(currency) ? 100 : 1 }), [dec, currency]);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);
  const country = usePurchaseCountry();
  const taxRates = useMemo(() => purchaseTaxRates(country), [country]);
  const rootRef = useRef<HTMLDivElement>(null);
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });

  /* ── Proveedor ── */
  const [supplier, setSupplier] = useState<SupplierRef | null>(null);
  const [changingSupplier, setChangingSupplier] = useState(false);
  const [createdSuppliers, setCreatedSuppliers] = useState<SupplierRef[]>([]);
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [newSupplierText, setNewSupplierText] = useState("");
  const supplierOptions = useMemo(() => [...suppliers, ...createdSuppliers], [suppliers, createdSuppliers]);

  /* ── Catálogo del proveedor ── */
  const [priceList, setPriceList] = useState<OcSupplierItem[] | null>(null);
  const [ingredients, setIngredients] = useState<OcIngredient[] | null>(null);
  const [history, setHistory] = useState<SupplierHistory | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const catalog = useMemo<OcCatalog | null>(
    () => (priceList && ingredients && history ? { priceList, ingredients, history: history.items } : null),
    [priceList, ingredients, history],
  );
  const options = useMemo(() => (catalog ? ingredientOptions(catalog) : []), [catalog]);

  /* ── Productos ── */
  const [lines, setLines] = useState<OcLine[]>([]);
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState<{ key: number; isNew: boolean } | null>(null);
  const [creatingIng, setCreatingIng] = useState<{ key: number; text: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);

  /* ── Cabecera y opciones ── */
  const [expectedAt, setExpectedAt] = useState("");
  const [receivedNow, setReceivedNow] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDueAt, setInvoiceDueAt] = useState("");
  const [orderDiscRaw, setOrderDiscRaw] = useState("");
  const [orderDiscIsPct, setOrderDiscIsPct] = useState(true);
  const [notes, setNotes] = useState("");
  const [openSections, setOpenSections] = useState<Partial<Record<SectionId, boolean>>>({});

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Factura ya registrada (sólo «Ya recibí»: una orden por pedir no es una
  // factura): aviso temprano mientras se digita y el 409 al guardar. Sin
  // número, el servidor advierte y «Guardar de todas formas» reenvía.
  const [conflict, setConflict] = useState<DuplicateConflict | null>(null);
  const allowPossibleDuplicate = useRef(false);
  const earlyDuplicate = useDuplicateDocumentCheck({
    supplierId: supplier?.id ?? null,
    number: receivedNow ? invoiceNumber : null,
  });

  /* ── Cálculos (los mismos del servidor) ── */
  const resolved = useMemo(() => resolveLines(lines), [lines]);
  const totals = useMemo(() => draftTotals(resolved.lines, orderDiscRaw, orderDiscIsPct), [resolved, orderDiscRaw, orderDiscIsPct]);
  const taxCtx = usePurchaseTaxContext(receivedNow);
  const retentions = useInvoiceRetentions(taxCtx, totals.invoiceDoc);
  const retentionRows = useRetentionRows();
  const retainedCents = receivedNow ? retentionTotalCents(retentions.totals) : 0;
  const filledCount = lines.filter((l) => !isBlankLine(l)).length;

  // Catálogo al elegir proveedor: lista de precios, insumos y lo que se le
  // ha pedido (esto último no bloquea: sin historia, solo no se recuerda).
  useEffect(() => {
    if (!supplier) return;
    let cancelled = false;
    (async () => {
      try {
        const [rs, ri, rh] = await Promise.all([
          fetch(`/api/operator/suppliers/${supplier.id}`),
          fetch("/api/operator/ingredients"),
          fetch(`/api/operator/suppliers/${supplier.id}/recent-items`).catch(() => null),
        ]);
        if (!rs.ok || !ri.ok) throw new Error("load_failed");
        const js = await rs.json();
        const ji = await ri.json();
        const jh: SupplierHistory = rh && rh.ok ? await rh.json().catch(() => EMPTY_HISTORY) : EMPTY_HISTORY;
        if (cancelled) return;
        const ings: OcIngredient[] = ((ji.ingredients ?? []) as ApiIngredient[])
          .filter((i) => i.active)
          .map((i) => ({ id: i.id, name: i.name, measureKind: i.measureKind, referencePriceCents: i.referencePriceCents ?? null }));
        const byId = new Map(ings.map((i) => [i.id, i]));
        const list: OcSupplierItem[] = ((js.supplier?.items ?? []) as ApiSupplierItem[])
          .filter((i) => i.ingredient.active)
          .map((i) => ({
            id: i.id,
            presentationLabel: i.presentationLabel,
            contentQty: i.contentQty,
            lastPriceCents: i.lastPriceCents,
            ingredient: byId.get(i.ingredient.id) ?? { id: i.ingredient.id, name: i.ingredient.name, measureKind: i.ingredient.measureKind },
          }));
        setIngredients(ings);
        setPriceList(list);
        setHistory(jh);
        // Escritorio: la primera fila lista, con el foco en su insumo. En el
        // celular las filas se crean desde «Agregar producto».
        if (linesRef.current.length === 0 && window.matchMedia(DESKTOP_QUERY).matches) {
          setLines([blankLine(1)]);
          queueFocus(1, "item");
        }
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplier, loadTick]);

  /* ── Foco ── */
  function queueFocus(key: number, col: OcCol) {
    requestAnimationFrame(() => {
      const cell = rootRef.current?.querySelector(`[data-oc-key="${key}"] [data-oc-col="${col}"]`);
      const el = cell?.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled), select:not(:disabled)");
      el?.focus({ preventScroll: true });
      if (el instanceof HTMLInputElement) el.select();
      // La fila entera a la vista, con su franja (aviso de repetido, errores).
      cell?.closest("tbody")?.scrollIntoView({ block: "nearest" });
    });
  }

  function focusById(id: string) {
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  /* ── Proveedor ── */
  function pickSupplier(s: SupplierRef) {
    setChangingSupplier(false);
    setCreatingSupplier(false);
    if (s.id === supplier?.id) return;
    const switching = supplier != null;
    setSupplier(s);
    setPriceList(null);
    setHistory(null);
    setLoadErr(false);
    if (switching && lines.some((l) => l.ingredient)) {
      setLines((prev) => prev.map((l) => detachLine(l, fmt)));
      setNotice({ text: t("ocSupplierChanged") });
    }
  }

  /* ── Filas ── */
  function setLinesWithDesktopBlank(next: OcLine[]) {
    setLines(desktop && next.length === 0 ? [blankLine(1)] : next);
  }

  function pick(key: number, o: OcOption) {
    if (!catalog) return;
    setLines((prev) => prev.map((l) => (l.key === key ? pickIngredient(l, o.ingredient, catalog, fmt) : l)));
    if (desktop) queueFocus(key, "qty");
    else focusById(`oc-m-qty-${key}`);
  }

  function setUnit(key: number, unit: string) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        let next = changeUnit(l, unit, fmt);
        // Un precio sugerido se vuelve a sugerir para la unidad nueva (la
        // lista de precios manda en presentaciones); uno escrito se convierte.
        if ((l.priceSource != null || next.priceRaw.trim() === "") && next.ingredient && catalog) {
          const hist = catalog.history.find((h) => h.ingredientId === next.ingredient!.id);
          const s = suggestPrice(next.ingredient, next.supplierItem, hist, unit, fmt.step);
          if (s) next = { ...next, priceRaw: centsToRaw(s.cents), priceSource: s.source };
        }
        return next;
      }),
    );
  }

  function setTax(key: number, choice: LineTaxChoice) {
    setLines((prev) =>
      prev.map((l) =>
        l.key !== key
          ? l
          : {
              ...l,
              tax: choice,
              // Al elegir consumo se propone el 8 % (lo típico).
              ...(choice.inc && !l.tax.inc && l.incRaw.trim() === "" ? { incRaw: String(DEFAULT_INC_PCT), incIsPct: true } : {}),
            },
      ),
    );
  }

  function remove(key: number) {
    setLinesWithDesktopBlank(removeLine(lines, key));
  }

  function merge(targetKey: number, sourceKey: number) {
    const merged = mergeLines(lines, targetKey, sourceKey, fmt);
    if (!merged) {
      setNotice({ text: t("ocMergeNeedsData") });
      return;
    }
    setLines(merged);
    if (editing?.key === sourceKey) setEditing(null);
    if (desktop) queueFocus(targetKey, "qty");
  }

  function touch(key: number, col: OcCol) {
    const id = `${key}:${col}`;
    if (touched.has(id)) return;
    setTouched((prev) => new Set(prev).add(id));
  }

  function visibleIssues(l: OcLine): LineIssues {
    const all = lineIssues(l);
    if (submitted) return all;
    const q = touched.has(`${l.key}:qty`);
    const p = touched.has(`${l.key}:price`);
    return {
      item: q || p ? all.item : undefined,
      qty: q ? all.qty : undefined,
      price: p ? all.price : undefined,
    };
  }

  function amounts(key: number) {
    const i = resolved.keys.indexOf(key);
    if (i < 0) return null;
    return { lineDiscountCents: totals.applied.lines[i]?.lineDiscountCents ?? 0, incCents: totals.lineIncs[i] ?? 0 };
  }

  function dupOf(l: OcLine) {
    const d = duplicateOf(lines, l.key);
    if (!d) return null;
    const index = lines.indexOf(d);
    return index < lines.indexOf(l) ? { line: d, index } : null;
  }

  const ctl: LineCtl = {
    currency,
    taxRates,
    options,
    visibleIssues,
    duplicateOf: dupOf,
    amounts,
    pick,
    createIngredient: (key, text) => setCreatingIng({ key, text }),
    patch: (key, p) => setLines((prev) => patchLine(prev, key, p)),
    setUnit,
    setTax,
    remove,
    merge,
    touch,
  };

  function addLineDesktop() {
    const last = lines[lines.length - 1];
    if (last && isBlankLine(last)) {
      queueFocus(last.key, "item");
      return;
    }
    const { lines: next, key } = insertBlankAfter(lines, lines.length - 1);
    setLines(next);
    queueFocus(key, "item");
  }

  function addLineMobile() {
    const key = nextKey(lines);
    setLines([...lines, blankLine(key)]);
    setEditing({ key, isNew: true });
  }

  function closeEditor() {
    if (editing?.isNew) {
      const l = lines.find((x) => x.key === editing.key);
      if (l && !l.ingredient) setLines((prev) => removeLine(prev, editing.key));
    }
    setEditing(null);
  }

  function onGrid(a: GridKeyAction) {
    switch (a.kind) {
      case "submit":
        void submit();
        break;
      case "addBelow": {
        const { lines: next, key } = insertBlankAfter(lines, a.row);
        setLines(next);
        queueFocus(key, "item");
        break;
      }
      case "focus": {
        const l = lines[a.row];
        if (l) queueFocus(l.key, a.col);
        break;
      }
      case "remove": {
        const l = lines[a.row];
        if (!l) break;
        const next = removeLine(lines, l.key);
        setLinesWithDesktopBlank(next);
        const f = next[a.focusRow];
        if (f) queueFocus(f.key, "item");
        break;
      }
      case "none":
        break;
    }
  }

  /* ── Habituales y reorden ── */
  function addHabituals() {
    if (!catalog || !history) return;
    const hist = habitualHistoryItems(history);
    const picks =
      hist.length > 0
        ? hist.map((h) => ({ ingredientId: h.ingredientId }))
        : catalog.priceList.map((i) => ({ ingredientId: i.ingredient.id }));
    if (picks.length === 0) {
      setNotice({ text: t("ocHabitualsNone") });
      return;
    }
    const before = lines;
    const r = linesForIngredients(lines, picks, catalog, fmt);
    setLines(r.lines);
    setNotice(r.added > 0 ? { text: t("ocAddedNotice", { count: r.added }), undo: before } : { text: t("ocAddedNone") });
  }

  async function addReorder() {
    if (!catalog || !supplier || reorderBusy) return;
    setReorderBusy(true);
    try {
      const r = await fetch("/api/operator/purchase-orders/suggested");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setNotice({ text: (j as { error?: string }).error === "module_disabled" ? t("suggestedNeedsInventory") : t("errLoadFailed") });
        return;
      }
      const j = (await r.json()) as { suppliers?: ReorderGroup[] };
      const group = (j.suppliers ?? []).find((g) => g.supplierId === supplier.id);
      if (!group || group.lines.length === 0) {
        setNotice({ text: t("ocReorderNone") });
        return;
      }
      const before = linesRef.current;
      const res = linesForIngredients(
        before,
        group.lines.map((l) => ({ ingredientId: l.ingredientId, presentations: l.presentations })),
        catalog,
        fmt,
      );
      setLines(res.lines);
      setNotice(res.added > 0 ? { text: t("ocAddedNotice", { count: res.added }), undo: before } : { text: t("ocAddedNone") });
    } catch {
      setNotice({ text: t("errLoadFailed") });
    } finally {
      setReorderBusy(false);
    }
  }

  /* ── Guardar ── */
  async function submit() {
    if (busy || !supplier) return;
    setSubmitted(true);
    setErr(null);
    setConflict(null);
    if (resolved.invalidKeys.length > 0) {
      setErr(t("ocErrFixLines", { count: resolved.invalidKeys.length }));
      const first = lines.find((l) => l.key === resolved.invalidKeys[0]);
      if (first) {
        if (desktop) {
          const i = lineIssues(first);
          queueFocus(first.key, i.item ? "item" : i.qty ? "qty" : "price");
        } else setEditing({ key: first.key, isNew: false });
      }
      return;
    }
    if (resolved.lines.length === 0) {
      setErr(t("noLinesYet"));
      return;
    }
    if (receivedNow && retentions.error) {
      setOpenSections((s) => ({ ...s, retentions: true }));
      setErr(t(retentions.error === "retention_exceeds_base" ? "errRetentionExceedsBase" : "errRetentionExceedsTotal"));
      return;
    }
    setBusy(true);
    try {
      const body = buildCreateOrderPayload({
        supplierId: supplier.id,
        lines: resolved.lines,
        orderDiscRaw,
        orderDiscIsPct,
        notes,
        expectedAt,
        receivedNow,
        invoiceNumber,
        invoiceDueAt,
        retentions: retentions.totals,
      });
      const possibleDuplicate = allowPossibleDuplicate.current ? "allow" : "check";
      allowPossibleDuplicate.current = false;
      const r = await fetch("/api/operator/purchase-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receivedNow ? { ...body, possibleDuplicate } : body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const dup = parseDuplicateConflict(j);
        if (dup) {
          setConflict(dup);
          return;
        }
        const key = API_CREATE_ERROR_KEYS[(j as { error?: string }).error as string];
        setErr(key ? t(key) : t("errSaveFailed"));
        return;
      }
      const j = await r.json();
      onCreated((j.order as { id: string }).id);
    } catch {
      setErr(t("errSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  function requestClose() {
    if (busy) return;
    if (supplier && filledCount > 0) setConfirmDiscard(true);
    else onClose();
  }

  /* ── Secciones plegables ── */
  const sectionOpen = (id: SectionId, hasContent: boolean) => openSections[id] ?? (wide || hasContent);
  const toggleSection = (id: SectionId, current: boolean) => setOpenSections((s) => ({ ...s, [id]: !current }));

  const orderDiscSummary = totals.discountCents > 0 ? `− ${money(totals.discountCents)}` : t("ocNone");
  const retSummary = t("ocRetCount", { count: retentions.lines.length });

  const advanced = supplier && catalog && (
    <div className="space-y-3 lg:max-[1439px]:space-y-0 lg:max-[1439px]:grid lg:max-[1439px]:grid-cols-3 lg:max-[1439px]:gap-3 lg:max-[1439px]:items-start">
      <Section
        id="discount"
        title={t("orderDiscountLabel")}
        summary={orderDiscSummary}
        open={sectionOpen("discount", orderDiscRaw.trim() !== "")}
        onToggle={toggleSection}
      >
        <DiscountControl
          id="po-order-discount"
          label={t("orderDiscountLabel")}
          raw={orderDiscRaw}
          isPct={orderDiscIsPct}
          currency={currency}
          onChange={(raw, isPct) => {
            setOrderDiscRaw(raw);
            setOrderDiscIsPct(isPct);
          }}
          hint={t("ocOrderDiscountHint")}
        />
      </Section>
      {receivedNow && (
        <Section
          id="retentions"
          title={t("poTaxSectionTitle")}
          summary={retSummary}
          open={sectionOpen("retentions", true)}
          onToggle={toggleSection}
        >
          <p className="text-[11px] text-op-muted mb-2">{t("poReceivedNowHint")}</p>
          <InvoiceRetentionsEditor state={retentions} ctx={taxCtx} doc={totals.invoiceDoc} currency={currency} />
          {retainedCents > 0 && <p className="mt-2 text-[10px] text-op-muted">{t("invTaxRetentionNote")}</p>}
        </Section>
      )}
      <Section
        id="notes"
        title={t("fieldNotes")}
        summary={notes.trim() ? notes.trim() : t("ocNoNotes")}
        open={sectionOpen("notes", notes.trim() !== "")}
        onToggle={toggleSection}
      >
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1000}
          rows={3}
          aria-label={t("fieldNotes")}
          placeholder={t("ocNotesPlaceholder")}
          className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-base sm:text-sm focus:outline-none focus:border-op-text/40"
        />
      </Section>
    </div>
  );

  /* ── Pintar ── */
  const editingLine = editing ? lines.find((l) => l.key === editing.key) ?? null : null;
  const primaryLabel = busy ? t("creating") : receivedNow ? t("poCreateReceived") : t("createOrder");

  const actions = confirmDiscard ? (
    <>
      <span className="hidden sm:block text-sm mr-1">{t("ocDiscardTitle", { count: filledCount })}</span>
      <button type="button" onClick={() => setConfirmDiscard(false)} className="mp-btn mp-btn--secondary" autoFocus>
        {t("ocDiscardKeep")}
      </button>
      <button type="button" onClick={onClose} className="mp-btn mp-btn--danger-solid">
        {t("ocDiscardConfirm")}
      </button>
    </>
  ) : (
    <>
      {desktop && (
        <button type="button" onClick={requestClose} className="mp-btn mp-btn--secondary">
          {t("cancel")}
        </button>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !supplier || filledCount === 0}
        className="mp-btn mp-btn--primary"
        data-testid="oc-submit"
      >
        {primaryLabel}
      </button>
    </>
  );

  const duplicate = conflict ?? (earlyDuplicate ? { code: "early" as const, existing: earlyDuplicate } : null);
  const message = (err || duplicate || (confirmDiscard && !desktop)) && (
    <div className="px-4 lg:px-6 pt-3">
      {confirmDiscard && !desktop ? (
        <p className="text-sm font-medium">{t("ocDiscardTitle", { count: filledCount })}</p>
      ) : (
        <>
          {err && (
            <p role="alert" className="text-sm text-danger">
              {err}
            </p>
          )}
          {duplicate && (
            <DuplicateDocumentAlert
              code={duplicate.code}
              existing={duplicate.existing}
              currency={currency}
              busy={busy}
              onConfirm={() => {
                allowPossibleDuplicate.current = true;
                void submit();
              }}
            />
          )}
        </>
      )}
    </div>
  );

  const toolbar = catalog && (
    <div className="grid grid-cols-2 lg:flex lg:flex-wrap items-center gap-2 px-4 lg:px-6 pt-4 pb-2">
      <h3 className="col-span-2 font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted lg:mr-auto">
        {t("ocProductsTitle")}
        <span className="ml-2 normal-case tracking-normal font-sans text-xs text-op-text">{t("ocProductsCount", { count: filledCount })}</span>
      </h3>
      <button
        type="button"
        onClick={addHabituals}
        disabled={catalog.history.length === 0 && catalog.priceList.length === 0}
        title={t("ocHabitualsHint")}
        className="mp-btn mp-btn--sm mp-btn--secondary h-auto! min-h-[44px] lg:min-h-0 lg:h-[38px]! whitespace-normal! leading-tight px-3!"
      >
        <RepeatIcon />
        {t("ocHabituals")}
      </button>
      <button
        type="button"
        onClick={() => void addReorder()}
        disabled={reorderBusy}
        className="mp-btn mp-btn--sm mp-btn--secondary h-auto! min-h-[44px] lg:min-h-0 lg:h-[38px]! whitespace-normal! leading-tight px-3!"
      >
        <ReorderIcon />
        {reorderBusy ? t("loading") : t("suggestedButton")}
      </button>
      {notice && (
        <div role="status" className="col-span-2 basis-full flex items-center gap-3 rounded-lg bg-op-bg border border-op-border px-3 py-2 text-xs">
          <span className="flex-1 min-w-0">{notice.text}</span>
          {notice.undo && (
            <button
              type="button"
              onClick={() => {
                setLines(notice.undo!);
                setNotice(null);
              }}
              className="font-medium underline underline-offset-2 hover:no-underline shrink-0"
            >
              {t("ocUndo")}
            </button>
          )}
          <button type="button" onClick={() => setNotice(null)} aria-label={t("ocDismiss")} className="shrink-0 text-op-muted hover:text-ink w-7 h-7 inline-flex items-center justify-center">
            <Icon name="close" width={14} height={14} />
          </button>
        </div>
      )}
    </div>
  );

  // Estados del cuerpo antes de tener el catálogo del proveedor.
  let pending: ReactNode = null;
  if (!supplier) {
    pending = (
      <div className="flex-1 flex items-center justify-center px-8 py-10">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 w-12 h-12 rounded-2xl bg-op-bg border border-op-border flex items-center justify-center text-op-muted">
            <Icon name="orders" width={22} height={22} />
          </div>
          <p className="font-display text-xl mb-1">{t("ocPickSupplierTitle")}</p>
          <p className="text-sm text-op-muted">{t("ocPickSupplierBody")}</p>
        </div>
      </div>
    );
  } else if (loadErr) {
    pending = (
      <div className="p-6 text-sm">
        <p className="text-danger mb-3">{t("errLoadFailed")}</p>
        <button
          type="button"
          onClick={() => {
            setLoadErr(false);
            setLoadTick((n) => n + 1);
          }}
          className="mp-btn mp-btn--sm mp-btn--secondary"
        >
          {t("ocRetry")}
        </button>
      </div>
    );
  } else if (!catalog) {
    pending = (
      <div className="px-4 lg:px-6 pt-6 pb-6 space-y-3" aria-busy="true" aria-label={t("loading")}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-10 rounded-lg bg-op-bg animate-pulse motion-reduce:animate-none" />
        ))}
      </div>
    );
  }

  const linesBlock = desktop ? (
    <div className="px-3 lg:px-4">
      <LinesTable lines={lines} ctl={ctl} onGrid={onGrid} />
      <button
        type="button"
        onClick={addLineDesktop}
        className="mt-2 mb-4 ml-8 inline-flex items-center gap-2 h-9 px-3 rounded-md text-sm font-medium text-op-accent hover:bg-op-accent/10"
      >
        <Icon name="plus" width={16} height={16} />
        {t("ocAddProduct")}
      </button>
    </div>
  ) : (
    <div className="px-4 space-y-3 pb-4">
      <LineCards lines={lines} ctl={ctl} onEdit={(key) => setEditing({ key, isNew: false })} />
      {lines.every((l) => !l.ingredient) && <p className="text-sm text-op-muted text-center py-2">{t("ocLinesEmpty")}</p>}
      {/* Fijo al borde de abajo mientras se recorre la lista. */}
      <button
        type="button"
        onClick={addLineMobile}
        className="sticky bottom-3 z-10 w-full min-h-[52px] rounded-2xl border border-op-border-2 bg-op-surface/95 backdrop-blur shadow-[var(--shadow-2)] text-[15px] font-medium text-op-text inline-flex items-center justify-center gap-2 active:bg-op-bg"
        data-testid="oc-add-mobile"
      >
        <Icon name="plus" width={18} height={18} />
        {t("ocAddProduct")}
      </button>
    </div>
  );

  const asideBlock = (
    <aside className="px-4 lg:px-6 pb-6 pt-2 min-[1440px]:pt-4 min-[1440px]:w-[360px] min-[1440px]:shrink-0 min-[1440px]:overflow-y-auto min-[1440px]:border-l min-[1440px]:border-op-border min-[1440px]:bg-op-bg/40">
      <h3 className="hidden min-[1440px]:block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-3">{t("ocMoreOptions")}</h3>
      {advanced}
    </aside>
  );

  const supplierField = (
    <div className="min-w-0">
      <label htmlFor="po-supplier" className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1 block">
        {t("fieldSupplier")}
        <span className="text-danger ml-1">{"*"}</span>
      </label>
      {supplier && !changingSupplier ? (
        <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg/60 text-sm flex items-center justify-between gap-2">
          <span className="truncate font-medium" data-testid="oc-supplier">{supplier.name}</span>
          <button
            type="button"
            onClick={() => setChangingSupplier(true)}
            className="text-[11px] font-medium text-op-muted hover:text-ink shrink-0 min-h-[36px] px-1"
          >
            {t("changeSupplier")}
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-start gap-2">
            <SupplierCombobox
              id="po-supplier"
              className="flex-1 min-w-0"
              suppliers={supplierOptions}
              value={null}
              onChange={(_id, s) => {
                if (s) pickSupplier({ id: s.id, name: s.name, taxId: s.taxId });
              }}
              onCreateRequested={(text) => {
                setNewSupplierText(text);
                setCreatingSupplier(true);
              }}
              aria-label={t("fieldSupplier")}
            />
            {changingSupplier && (
              <button type="button" onClick={() => setChangingSupplier(false)} className="mp-btn mp-btn--ghost shrink-0">
                {t("cancel")}
              </button>
            )}
          </div>
          {creatingSupplier && (
            <SupplierInlineForm
              key={newSupplierText}
              initialName={splitSupplierText(newSupplierText).name}
              initialTaxId={splitSupplierText(newSupplierText).taxId}
              onCreated={(s) => {
                setCreatedSuppliers((prev) => [...prev, s]);
                pickSupplier(s);
              }}
              onCancel={() => setCreatingSupplier(false)}
            />
          )}
        </div>
      )}
    </div>
  );

  const receivedSwitch = (
    <button
      type="button"
      role="switch"
      aria-checked={receivedNow}
      onClick={() => setReceivedNow((v) => !v)}
      title={t("poReceivedNowHint")}
      data-testid="oc-received-now"
      className={
        "min-h-[44px] w-full lg:w-auto inline-flex items-center gap-3 px-3 rounded-lg border text-sm font-medium text-left leading-tight transition-colors " +
        (receivedNow ? "border-ink bg-ink text-bone" : "border-op-border bg-op-surface hover:bg-op-bg")
      }
    >
      <span
        aria-hidden="true"
        className={"relative w-8 h-[18px] rounded-full shrink-0 transition-colors " + (receivedNow ? "bg-bone/30" : "bg-op-muted/45")}
      >
        <span
          className={
            "absolute top-[2px] left-0 w-[14px] h-[14px] rounded-full bg-white shadow transition-transform motion-reduce:transition-none " +
            (receivedNow ? "translate-x-[16px]" : "translate-x-[2px]")
          }
        />
      </span>
      <span className="lg:whitespace-nowrap">{t("poReceivedNow")}</span>
    </button>
  );

  const labelCls = "font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1 block";
  const headerGrid = (
    <div
      className={
        "grid gap-3 grid-cols-2 " +
        (receivedNow ? "lg:grid-cols-[minmax(0,1fr)_auto_170px_170px]" : "lg:grid-cols-[minmax(0,1fr)_auto_190px]")
      }
    >
      <div className="col-span-2 lg:col-span-1 min-w-0">{supplierField}</div>
      <div className={"flex items-end " + (receivedNow ? "col-span-2 lg:col-span-1" : "")}>{receivedSwitch}</div>
      {receivedNow ? (
        <>
          <div>
            <label htmlFor="oc-invoice-number" className={labelCls}>{t("fieldInvoiceNumber")}</label>
            <input
              id="oc-invoice-number"
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              maxLength={80}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="oc-invoice-due" className={labelCls}>{t("fieldInvoiceDueAt")}</label>
            <input
              id="oc-invoice-due"
              type="date"
              value={invoiceDueAt}
              onChange={(e) => setInvoiceDueAt(e.target.value)}
              title={t("poInvoiceDueHint")}
              className={inputCls}
            />
          </div>
        </>
      ) : (
        <div>
          <label htmlFor="oc-expected-at" className={labelCls}>{t("fieldExpectedAt")}</label>
          <input
            id="oc-expected-at"
            type="date"
            value={expectedAt}
            onChange={(e) => setExpectedAt(e.target.value)}
            className={inputCls}
          />
        </div>
      )}
    </div>
  );

  const footerTotals = {
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    ivaCents: totals.ivaCents,
    incCents: totals.incCents,
    retentions: receivedNow ? retentionRows(retentions.totals) : null,
    payableCents: totals.totalCents - retainedCents,
    productCount: resolved.lines.length,
  };

  return (
    <>
      <AppDialog
        label={t("newOrderTitle")}
        onClose={requestClose}
        dismissOnBackdrop={false}
        className="m-0! inset-0! w-screen! max-w-none! h-dvh! max-h-none! overflow-hidden! rounded-none! border-0! lg:m-auto! lg:w-[min(1560px,calc(100vw-48px))]! lg:h-[calc(100dvh-48px)]! lg:rounded-[18px]! lg:border!"
      >
        <div
          ref={rootRef}
          className="flex flex-col h-full min-h-0 pt-[env(safe-area-inset-top)] lg:pt-0"
          data-testid="oc-form"
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter guarda desde cualquier campo (la tabla ya lo maneja).
            if (e.defaultPrevented || e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            void submit();
          }}
        >
          <header className={"shrink-0 px-4 lg:px-6 pt-3 lg:pt-4 pb-2 lg:pb-4 " + (desktop ? "border-b border-op-border" : "")}>
            <div className="flex items-center justify-between gap-3 lg:mb-3">
              <h2 className="font-display text-2xl lg:text-[28px] leading-tight">{t("newOrderTitle")}</h2>
              <button type="button" onClick={requestClose} aria-label={t("cancel")} className="mp-icobtn -mr-1 shrink-0">
                <Icon name="close" width={18} height={18} />
              </button>
            </div>
            {desktop && headerGrid}
          </header>
          {desktop ? (
            pending ?? (
              <div className="flex-1 min-h-0 flex flex-col min-[1440px]:flex-row overflow-y-auto min-[1440px]:overflow-hidden">
                <div className="min-[1440px]:flex-1 min-w-0 min-[1440px]:overflow-y-auto">
                  {toolbar}
                  {linesBlock}
                </div>
                {asideBlock}
              </div>
            )
          ) : (
            // Celular: la cabecera se recorre con la lista (más espacio para los productos).
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col">
              <div className="px-4 pt-1 pb-4 border-b border-op-border">{headerGrid}</div>
              {pending ?? (
                <>
                  {toolbar}
                  {linesBlock}
                  {asideBlock}
                </>
              )}
            </div>
          )}
          <OrderFooter
            totals={footerTotals}
            currency={currency}
            receivedNow={receivedNow}
            desktop={desktop}
            actions={actions}
            message={message}
            hint={
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                {t.rich("ocKbdHint", {
                  kbd: (chunks) => (
                    <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-op-border bg-op-bg text-op-text">{chunks}</kbd>
                  ),
                })}
              </span>
            }
          />
        </div>
      </AppDialog>
      {editing && editingLine && !desktop && (
        <LineEditorSheet
          line={editingLine}
          index={lines.indexOf(editingLine)}
          isNew={editing.isNew}
          ctl={ctl}
          onClose={closeEditor}
          onAddAnother={() => {
            const key = nextKey(lines);
            setLines([...lines, blankLine(key)]);
            setEditing({ key, isNew: true });
          }}
        />
      )}
      {creatingIng && (
        <AppDialog label={t("ocCreateIngredientTitle")} onClose={() => setCreatingIng(null)} dismissOnBackdrop={false} className="mp-sheet mp-sheet--md-center">
          <div className="p-5">
            <div className="flex items-center justify-between gap-3 mb-1">
              <h3 className="font-display text-xl">{t("ocCreateIngredientTitle")}</h3>
              <button type="button" onClick={() => setCreatingIng(null)} aria-label={t("cancel")} className="mp-icobtn -mr-2">
                <Icon name="close" width={18} height={18} />
              </button>
            </div>
            <IngredientInlineForm
              initialName={creatingIng.text}
              onCreated={(ing) => {
                const oc: OcIngredient = { id: ing.id, name: ing.name, measureKind: ing.measureKind, referencePriceCents: null };
                const key = creatingIng.key;
                setIngredients((prev) => [...(prev ?? []), oc]);
                setLines((prev) =>
                  prev.map((l) =>
                    l.key === key ? pickIngredient(l, oc, { priceList: priceList ?? [], history: history?.items ?? [] }, fmt) : l,
                  ),
                );
                setCreatingIng(null);
                if (desktop) queueFocus(key, "qty");
                else focusById(`oc-m-qty-${key}`);
              }}
              onCancel={() => setCreatingIng(null)}
            />
          </div>
        </AppDialog>
      )}
    </>
  );
}

/** Sección plegable de opciones (descuento, retenciones, notas). */
function Section({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  summary: string;
  open: boolean;
  onToggle: (id: SectionId, current: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-op-border bg-op-surface" data-testid={`oc-section-${id}`}>
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`oc-sec-${id}`}
          onClick={() => onToggle(id, open)}
          className="w-full min-h-[48px] px-4 flex items-center gap-3 text-left"
        >
          <span className="text-sm font-medium flex-1">{title}</span>
          {!open && <span className="text-xs text-op-muted truncate max-w-[50%] tabular-nums">{summary}</span>}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={"shrink-0 text-op-muted transition-transform motion-reduce:transition-none " + (open ? "rotate-180" : "")}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h4>
      {open && (
        <div id={`oc-sec-${id}`} className="px-4 pb-4">
          {children}
        </div>
      )}
    </section>
  );
}

function RepeatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function ReorderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  );
}
