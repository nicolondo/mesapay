"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { BARCODE_MAX_LENGTH, ingredientBarcodeValues, mergeIngredientBarcodes, normalizeBarcode, type IngredientBarcodeUpdate } from "@/lib/erp/barcode";
import {
  buildCountBarcodeIndex, countOrderReducer, countRowState, countScopeCategory, countStats, EMPTY_COUNT_ORDER,
  filterCountItems, orderCountItems, pruneBlankCountParts, restoreCountOrder, serializeCountOrder,
  type CountOrderState, type DifferenceFilter,
} from "@/lib/erp/countView";
import { countEntriesFromBase, nextCountEntry, parseCountEntries, parseCountEntry, type CountEntry } from "@/lib/erp/stockCountInput";
import { MAX_COUNT_PARTS } from "@/lib/erp/stockCountParts";
import type { IngredientConflict, IngredientRef } from "../compras/shared";
import { addIngredientBarcode, moveIngredientBarcode, removeIngredientBarcode } from "./barcodeApi";
import { BarcodeSheet, type BarcodeMoveTarget } from "./BarcodeSheet";
import { appendCountItem, lookupCountScan, restoreIngredient, type ScanMatch } from "./countApi";
import { CountItemPicker, CountNewIngredientDialog } from "./CountDialogs";
import { CountRow, type CountRowHandlers } from "./CountRow";
import { InvIcon } from "./InventoryIcons";
import type { CountDetail, CountItemRow } from "./types";

type Stage = "initial" | "preliminary" | "recount" | "review" | "closed";

function stageOf(count: CountDetail): Stage {
  if (count.status === "closed") return "closed";
  return count.finalReview ? "review" : count.recountStartedAt ? "recount" : count.preliminaryAt ? "preliminary" : "initial";
}

const STAGE_LABEL: Record<Stage, string> = {
  initial: "countStageInitial", preliminary: "countStagePreliminary", recount: "countStageDefinitive", review: "countStageReview", closed: "countStatusClosed",
};
const STAGE_HINT: Record<Exclude<Stage, "closed">, string> = {
  initial: "countInitialHint", preliminary: "countPreliminaryHint", recount: "countRecountHint", review: "countReviewHint",
};

const savedEntriesOf = (item: CountItemRow) => countEntriesFromBase(item.countedQty, item.ingredient.measureKind, item.countedParts);
const entriesOf = (count: CountDetail): Record<string, CountEntry[]> => Object.fromEntries(count.items.map((item) => [item.id, savedEntriesOf(item)]));

// El orden «recientes primero» se guarda en el dispositivo al guardar el
// borrador, para que al reabrirlo lo último contado siga arriba.
const orderKey = (countId: string) => `mp:count-order:${countId}`;
function loadOrder(count: CountDetail): CountOrderState {
  try {
    return restoreCountOrder(JSON.parse(window.localStorage.getItem(orderKey(count.id)) ?? "null"), stageOf(count), count.items);
  } catch {
    return EMPTY_COUNT_ORDER;
  }
}
function storeOrder(countId: string, state: CountOrderState | null, stage: Stage) {
  try {
    if (state) window.localStorage.setItem(orderKey(countId), JSON.stringify(serializeCountOrder(state, stage)));
    else window.localStorage.removeItem(orderKey(countId));
  } catch {
    // Sin almacenamiento (modo privado): solo se pierde el orden al reabrir.
  }
}

type Named = { id: string; name: string };

/** Lo que se muestra bajo la barra de escaneo (una cosa a la vez). */
type ScanPanel =
  | { kind: "looking"; code: string }
  /** Nadie tiene el código (o no se pudo consultar: `failed`). */
  | { kind: "unknown"; code: string; failed: boolean }
  /** El código es de un insumo que no está en este conteo. */
  | { kind: "owned"; code: string; match: ScanMatch }
  /** Código recién vinculado: se puede deshacer o corregir. */
  | { kind: "linked"; code: string; item: { id: string; ingredientId: string; name: string }; previous: Named | null }
  | { kind: "note"; tone: "ok" | "error"; text: string };

const COUNT_ERROR_KEYS: Record<string, string> = {
  count_changed: "countErrChanged", stock_changed: "countErrStockChanged",
  incomplete_count: "countErrIncomplete", empty_count: "countErrEmpty",
  preliminary_required: "countErrPreliminary", recount_required: "countErrRecount",
  review_required: "countErrReview", already_closed: "errAlreadyClosed", qty_invalid: "errQtyInvalid",
  count_not_editable: "countErrNotEditable", ingredient_inactive: "errIngredientInactive",
  ingredient_not_tracked: "errIngredientNotTracked", ingredient_not_found: "errIngredientNotFound",
};

/**
 * Hoja «Conteo físico». Una línea por insumo; lo que se escanea o se digita
 * sube a «Contados recientemente» (lo último, arriba) y el resto queda abajo
 * en su orden de siempre. La barra de escaneo, el buscador y los filtros se
 * quedan pegados arriba y las acciones, abajo. Desde aquí también se corrige
 * un código mal vinculado y se crea un insumo que faltaba.
 *
 * Las cantidades NO se guardan solas: «Guardar borrador» manda el conteo
 * completo (con su revisión) y cierra la hoja; las acciones de etapa siguen
 * igual. Tocar afuera no cierra, y ✕ pregunta si hay cantidades sin guardar.
 */
export function CountSheet({ count: initialCount, onClose, onClosed, onDeleted, onDraftSaved, onBarcodeSaved, onCatalogChanged }: {
  count: CountDetail;
  onClose: () => void;
  onClosed: () => void;
  onDeleted: () => void;
  /** «Guardar borrador» salió bien: la página cierra la hoja y avisa. */
  onDraftSaved: () => void;
  onBarcodeSaved: (ingredient: IngredientBarcodeUpdate) => void;
  /** Se creó o se restauró un insumo: la página refresca sus existencias. */
  onCatalogChanged: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const enterHintId = useId();
  const [count, setCount] = useState(initialCount);
  // Cada escaneo conserva su propia cantidad y unidad; el total se deriva.
  const [entries, setEntries] = useState<Record<string, CountEntry[]>>(() => entriesOf(initialCount));
  const [order, dispatchOrder] = useReducer(countOrderReducer, initialCount, loadOrder);
  const [q, setQ] = useState("");
  const [differenceFilter, setDifferenceFilter] = useState<DifferenceFilter>("all");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<"stock" | "count" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [closedResult, setClosedResult] = useState<number | null>(null);

  // ── Lectura de código de barras ──
  // Los lectores del mercado son HID ("tipo teclado"): teclean el código a
  // toda velocidad y rematan con un Enter. No hace falta cámara ni pedir
  // permisos: alcanza con un input enfocado que capture la ráfaga y
  // reaccione al submit. Funciona con cualquier lector USB o bluetooth.
  const [scan, setScan] = useState("");
  const [panel, setPanel] = useState<ScanPanel | null>(null);
  const [quantityError, setQuantityError] = useState<{ itemId: string; index: number } | null>(null);
  // Fila a la que saltó el último escaneo. `seq` sube en cada lectura para
  // que re-escanear el MISMO código vuelva a enfocar. `toTop`: además la
  // lista vuelve arriba, donde quedó la fila.
  const [hit, setHit] = useState<{ itemId: string; index: number; seq: number; toTop: boolean } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hintOpen, setHintOpen] = useState(true);
  const [codesFor, setCodesFor] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ code: string; from: Named | null } | null>(null);
  const [creating, setCreating] = useState<{ name?: string; barcode?: string } | null>(null);

  const seqRef = useRef(0);
  const lookupRef = useRef(0);
  const scanRef = useRef<HTMLInputElement | null>(null);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  /** Elemento que debe quedarse quieto en pantalla cuando una fila sube. */
  const anchorRef = useRef<{ el: Element; top: number } | null>(null);
  /** Insumo al que se le vinculó el código pendiente desde su hoja de códigos. */
  const countAfterCodes = useRef<string | null>(null);

  const stage: Stage = closedResult !== null ? "closed" : stageOf(count);
  const readOnly = stage === "closed";
  const canEdit = stage === "initial" || stage === "recount";
  const finalStage = !!count.recountStartedAt;
  const showPreliminary = !!count.preliminaryAt;

  // Hay cantidades digitadas que se perderían al cerrar.
  const dirty = canEdit && count.items.some((item) => JSON.stringify(entries[item.id] ?? []) !== JSON.stringify(savedEntriesOf(item)));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  /** ✕ y Cancelar: con cantidades sin guardar, pregunta antes de perderlas. */
  function requestClose() {
    if (busy) return;
    if (dirty && !window.confirm(t("countUnsavedConfirm"))) return;
    onClose();
  }

  const baseline = (item: CountItemRow) => finalStage ? (item.finalExpectedQty ?? item.expectedQty) : item.expectedQty;
  const quantity = (item: CountItemRow) => {
    if (!canEdit) return item.countedQty;
    const parsed = parseCountEntries(entries[item.id] ?? [], item.ingredient.measureKind);
    return parsed === "invalid" ? parsed : parsed.countedQty;
  };

  function acceptCount(next: CountDetail) {
    if (stageOf(next) !== stageOf(count)) {
      // Etapa nueva: las cantidades vuelven a empezar y el orden también.
      dispatchOrder({ type: "reset" });
      setHintOpen(true);
    }
    setCount(next);
    setEntries(entriesOf(next));
    setConflict(null);
    setDifferenceFilter("all");
    setQuantityError(null);
    setExpandedId(null);
    setHit(null);
    setPanel(null);
  }

  function showError(code?: string) {
    setErr(t(COUNT_ERROR_KEYS[code ?? ""] ?? "errSaveFailed"));
    if (code === "stock_changed") setConflict("stock");
    if (code === "count_changed" || code === "already_closed") setConflict("count");
  }

  async function requestCount(action: string, body?: unknown): Promise<CountDetail | null> {
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}${action ? `/${action}` : ""}`, {
        method: action ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { showError(result.error); return null; }
      acceptCount(result.count as CountDetail);
      return result.count as CountDetail;
    } catch { setErr(t("errSaveFailed")); return null; }
  }

  async function reloadCount() {
    setBusy(true); setErr(null);
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}`);
      if (!response.ok) throw new Error("load_failed");
      acceptCount((await response.json()).count as CountDetail);
    } catch { setErr(t("errSaveFailed")); }
    finally { setBusy(false); }
  }

  // Código de barras → fila del conteo. El índice único
  // (restaurantId, barcode) garantiza que no haya dos insumos con el mismo
  // código, así que el mapa nunca pierde filas y el escaneo no es ambiguo.
  const byBarcode = useMemo(() => buildCountBarcodeIndex(count.items), [count.items]);
  const scopeCategory = useMemo(() => countScopeCategory(count.items), [count.items]);
  const categories = useMemo(
    () => [...new Set(count.items.map((item) => item.ingredient.category).filter((category): category is string => !!category))].sort((a, b) => a.localeCompare(b)),
    [count.items],
  );
  const moveTargets = useMemo<BarcodeMoveTarget[]>(
    () => count.items.filter((item) => item.ingredient.active && item.ingredient.trackInventory).map((item) => item.ingredient),
    [count.items],
  );

  // Los filtros miran lo DIGITADO (igual que sus contadores), pero la fila
  // recién escaneada, la que se está editando y la desplegada no desaparecen:
  // escribir el primer número no saca la fila de «Pendientes» ni le quita el
  // foco; sale de ese filtro cuando se suelta.
  const pinned = new Set([hit?.itemId, order.editing, expandedId].filter((id): id is string => !!id));
  const filtered = filterCountItems(count.items, {
    q, filter: differenceFilter, pinned,
    view: (item) => ({ ingredient: item.ingredient, tracked: item.ingredient.trackInventory, value: quantity(item), baseline: baseline(item) }),
  });
  const { recent, rest } = orderCountItems(filtered, order.touched);

  // Desviación en vivo: contados y con diferencia (borrador usa lo
  // digitado; cerrado usa lo persistido).
  const stats = countStats(count.items.map((item) => countRowState(quantity(item), baseline(item), item.ingredient.trackInventory)));

  /** Solo los códigos del insumo: recargar el conteo borraría lo digitado. */
  function applyBarcodes(update: IngredientBarcodeUpdate) {
    setCount((current) => ({
      ...current,
      items: current.items.map((item) => item.ingredient.id === update.id ? { ...item, ingredient: mergeIngredientBarcodes(item.ingredient, update) } : item),
    }));
    onBarcodeSaved(update);
  }

  /**
   * Deja lista la cantidad del insumo (escaneo, alta o vínculo): la fila sube
   * arriba de todo, se abre un campo —o se reutiliza el que quedó vacío— y
   * queda con el foco.
   */
  function focusItem(item: CountItemRow, current: readonly CountEntry[]): boolean {
    if (!item.ingredient.trackInventory) return false;
    const next = nextCountEntry(current, item.ingredient.measureKind);
    if (!next) {
      setPanel({ kind: "note", tone: "error", text: t("countPartsLimit", { count: MAX_COUNT_PARTS }) });
      return false;
    }
    setEntries((prev) => ({ ...prev, [item.id]: next.entries }));
    setQuantityError(null);
    // El buscador puede estar escondiendo justo la fila escaneada.
    setQ("");
    setDifferenceFilter("all");
    setHintOpen(false);
    dispatchOrder({ type: "scan", itemId: item.id });
    setExpandedId(next.entries.length > 1 ? item.id : null);
    setHit({ itemId: item.id, index: next.index, seq: ++seqRef.current, toTop: true });
    return true;
  }

  /** Escaneo (o Enter manual): salta al insumo del código leído. */
  function handleScan(event: React.FormEvent) {
    event.preventDefault();
    if (!canEdit || busy) return;
    const code = normalizeBarcode(scan);
    setScan("");
    if (!code) return;
    const item = count.items.find((candidate) => candidate.id === byBarcode.get(code));
    if (item) {
      lookupRef.current++;
      setPanel(null);
      focusItem(item, entries[item.id] ?? []);
      return;
    }
    // Nunca fallar en silencio: el operador tiene el empaque en la mano y
    // necesita saber de quién es ese código y qué puede hacer con él.
    void explainCode(code);
  }

  async function explainCode(code: string) {
    const token = ++lookupRef.current;
    setPanel({ kind: "looking", code });
    const result = await lookupCountScan(count.id, code);
    if (token !== lookupRef.current) return;
    if (!result.ok) { setPanel({ kind: "unknown", code, failed: true }); return; }
    const { match } = result;
    if (!match) { setPanel({ kind: "unknown", code, failed: false }); return; }
    if (match.state === "in_count") {
      // El insumo sí está: el navegador tenía sus códigos viejos.
      const item = count.items.find((candidate) => candidate.id === match.itemId);
      if (!item) { setPanel(null); showError("count_changed"); return; }
      applyBarcodes(match.ingredient);
      setPanel(null);
      focusItem(item, entries[item.id] ?? []);
      return;
    }
    setPanel({ kind: "owned", code, match });
  }

  /** Vincula el código a un insumo del conteo (o se lo pasa desde `from`) y lo cuenta. */
  async function linkCode(code: string, item: CountItemRow, from: Named | null) {
    if (busy) return;
    if (from && !window.confirm(t("barcodeMoveConfirm", { code, name: from.name, target: item.ingredient.name }))) return;
    setBusy(true);
    const result = from ? await moveIngredientBarcode(from.id, code, item.ingredient.id) : await addIngredientBarcode(item.ingredient.id, code);
    setBusy(false);
    setPicker(null);
    if (!result.ok) { setPanel({ kind: "note", tone: "error", text: t(result.errorKey, result.errorValues) }); return; }
    applyBarcodes(result.ingredient);
    const moved = (result as { target?: IngredientBarcodeUpdate }).target;
    if (moved) applyBarcodes(moved);
    focusItem(item, entries[item.id] ?? []);
    setPanel({ kind: "linked", code, item: { id: item.id, ingredientId: item.ingredient.id, name: item.ingredient.name }, previous: from });
  }

  /** «Deshacer»: el código vuelve a quien lo tenía (o queda sin dueño). */
  async function undoLink(linked: Extract<ScanPanel, { kind: "linked" }>) {
    if (busy) return;
    setBusy(true);
    const result = linked.previous
      ? await moveIngredientBarcode(linked.item.ingredientId, linked.code, linked.previous.id)
      : await removeIngredientBarcode(linked.item.ingredientId, linked.code);
    setBusy(false);
    if (!result.ok) { setPanel({ kind: "note", tone: "error", text: t(result.errorKey, result.errorValues) }); return; }
    applyBarcodes(result.ingredient);
    const moved = (result as { target?: IngredientBarcodeUpdate }).target;
    if (moved) applyBarcodes(moved);
    // Quedó como antes de vincularlo: se vuelve a ofrecer qué hacer con él.
    void explainCode(linked.code);
  }

  /** Entra la fila nueva sin tocar lo digitado en las demás. */
  function mergeAppended(next: CountDetail, itemId: string, note: string | null) {
    const item = next.items.find((candidate) => candidate.id === itemId);
    setCount(next);
    setEntries((prev) => {
      const merged = { ...prev };
      for (const candidate of next.items) if (!merged[candidate.id]) merged[candidate.id] = savedEntriesOf(candidate);
      return merged;
    });
    if (!item) return;
    focusItem(item, entries[item.id] ?? savedEntriesOf(item));
    setPanel(note ? { kind: "note", tone: "ok", text: note } : null);
  }

  /**
   * Trae un insumo a este conteo y deja lista su cantidad: si ya está, salta
   * a su fila; si está archivado, primero lo restaura; después lo suma al
   * borrador (existencia de ahora; 0 si es nuevo).
   */
  async function bringIntoCount(target: { id: string; name: string; active: boolean; category?: string | null }) {
    if (busy) return;
    const existing = count.items.find((item) => item.ingredient.id === target.id);
    if (existing) { setPanel(null); focusItem(existing, entries[existing.id] ?? []); return; }
    setBusy(true); setErr(null);
    if (!target.active) {
      if (!(await restoreIngredient(target.id))) {
        setBusy(false);
        setPanel({ kind: "note", tone: "error", text: t("countRestoreFailed", { name: target.name }) });
        return;
      }
      onCatalogChanged();
    }
    const result = await appendCountItem(count.id, count.revision, target.id);
    setBusy(false);
    if (!result.ok) {
      if (result.error === "ingredient_not_tracked") {
        setPanel({ kind: "note", tone: "ok", text: t(target.active ? "countAppendNotTracked" : "countRestoredNotTracked", { name: target.name }) });
      } else {
        // Restaurado pero sin poder entrar a este borrador: saldrá en el próximo.
        if (!target.active) setPanel({ kind: "note", tone: "ok", text: t("countRestoredNext", { name: target.name }) });
        showError(result.error);
      }
      return;
    }
    const added = result.count.items.find((item) => item.id === result.itemId);
    const outside = scopeCategory && added && added.ingredient.category !== scopeCategory;
    mergeAppended(result.count, result.itemId, outside
      ? t("countAppendedOutsideScope", { name: target.name, category: scopeCategory })
      : t(target.active ? "countAppended" : "countRestoredAppended", { name: target.name }));
  }

  async function ingredientCreated(ingredient: IngredientRef) {
    setCreating(null);
    onCatalogChanged();
    await bringIntoCount({ id: ingredient.id, name: ingredient.name, active: true });
  }

  // Enfocar la cantidad del insumo escaneado. Corre DESPUÉS del render, así
  // que la fila ya existe aunque el escaneo haya tenido que limpiar el
  // buscador para revelarla, y ya está arriba de la lista.
  useEffect(() => {
    if (!hit) return;
    const el = qtyRefs.current[`${hit.itemId}:${hit.index}`];
    if (!el) return;
    if (hit.toTop && regionRef.current) regionRef.current.scrollTop = 0;
    el.scrollIntoView({ block: "nearest", behavior: "instant" });
    el.focus({ preventScroll: true });
    el.select();
  }, [hit]);

  // Cuando una fila sube a «recientes» por perder el foco, lo que el usuario
  // tiene delante no debe moverse: se compensa el scroll (salvo estando
  // arriba, donde justamente se ve llegar la fila).
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const region = regionRef.current;
    if (!anchor || !region || !anchor.el.isConnected || region.scrollTop < 8) return;
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (delta) region.scrollTop += delta;
  }, [order.touched]);

  // Alto de la barra y del pie pegados → `scroll-padding`, para que lo que
  // se enfoque (Tab, escaneo) nunca quede tapado por ellos.
  useEffect(() => {
    const region = regionRef.current;
    const sticky = stickyRef.current;
    const foot = footRef.current;
    if (!region || !sticky || !foot) return;
    const measure = () => {
      region.style.setProperty("--count-top", `${sticky.offsetHeight + 4}px`);
      region.style.setProperty("--count-bottom", `${getComputedStyle(foot).position === "sticky" ? foot.offsetHeight + 4 : 0}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sticky);
    observer.observe(foot);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  // ── Manejadores de las filas ──
  function changeEntry(itemId: string, index: number, change: Partial<CountEntry>) {
    setQuantityError(null);
    setHintOpen(false);
    setEntries((prev) => ({ ...prev, [itemId]: (prev[itemId] ?? []).map((entry, partIndex) => partIndex === index ? { ...entry, ...change } : entry) }));
    // Solo se anota que la fila cambió: sube cuando se suelta, no al teclear.
    dispatchOrder({ type: "edit", itemId });
  }

  function enterQuantity(itemId: string, index: number) {
    const item = count.items.find((candidate) => candidate.id === itemId);
    const itemEntries = entries[itemId];
    if (!item || !itemEntries?.[index]) return;
    const kind = item.ingredient.measureKind;
    const value = parseCountEntry(itemEntries[index].raw, kind, itemEntries[index].unit);
    if (value == null || value === "invalid" || parseCountEntries(itemEntries, kind) === "invalid") {
      setQuantityError({ itemId, index });
      return;
    }
    setQuantityError(null);
    setScan("");
    if (panel && panel.kind !== "linked") setPanel(null);
    lookupRef.current++;
    setExpandedId(null);
    dispatchOrder({ type: "edit", itemId });
    dispatchOrder({ type: "commit", itemId });
    // Enter = «listo, siguiente código»: la fila quedó arriba y se ve.
    if (regionRef.current) regionRef.current.scrollTop = 0;
    scanRef.current?.focus({ preventScroll: true });
  }

  function removePart(itemId: string, index: number) {
    const remaining = (entries[itemId] ?? []).filter((_, partIndex) => partIndex !== index);
    if (!remaining.length) return;
    setEntries((prev) => ({ ...prev, [itemId]: remaining }));
    setQuantityError(null);
    dispatchOrder({ type: "edit", itemId });
    setHit({ itemId, index: Math.min(index, remaining.length - 1), seq: ++seqRef.current, toTop: false });
  }

  /** «+»: otra cantidad para el mismo insumo (bodega + barra), sin escanear. */
  function addPart(itemId: string) {
    const item = count.items.find((candidate) => candidate.id === itemId);
    if (!item || !canEdit || busy || !item.ingredient.trackInventory) return;
    const next = nextCountEntry(entries[itemId] ?? [], item.ingredient.measureKind);
    if (!next) { setPanel({ kind: "note", tone: "error", text: t("countPartsLimit", { count: MAX_COUNT_PARTS }) }); return; }
    setEntries((prev) => ({ ...prev, [itemId]: next.entries }));
    setQuantityError(null);
    setHintOpen(false);
    dispatchOrder({ type: "edit", itemId });
    setExpandedId(next.entries.length > 1 ? itemId : null);
    setHit({ itemId, index: next.index, seq: ++seqRef.current, toTop: false });
  }

  function leaveRow(itemId: string, next: Element | null) {
    // Cambiar de ventana no es «soltar la fila»: al volver se sigue escribiendo.
    if (!document.hasFocus()) return;
    const region = regionRef.current;
    if (region) {
      // Lo que va a quedar enfocado (o la primera fila a la vista) se queda quieto.
      let el: Element | null = next && region.contains(next) && !stickyRef.current?.contains(next) ? next : null;
      if (!el) {
        const limit = region.getBoundingClientRect().top + (stickyRef.current?.offsetHeight ?? 0);
        for (const row of region.querySelectorAll("[data-count-row]")) {
          if (row.getAttribute("data-count-row") !== itemId && row.getBoundingClientRect().bottom > limit) { el = row; break; }
        }
      }
      anchorRef.current = el ? { el, top: el.getBoundingClientRect().top } : null;
    }
    // Un campo que quedó en blanco (escaneo sin digitar) no es una cantidad.
    setEntries((prev) => {
      const current = prev[itemId];
      if (!current) return prev;
      const pruned = pruneBlankCountParts(current);
      return pruned.length === current.length ? prev : { ...prev, [itemId]: pruned };
    });
    dispatchOrder({ type: "commit", itemId });
  }

  const live = useRef({ changeEntry, enterQuantity, removePart, addPart, leaveRow });
  useLayoutEffect(() => { live.current = { changeEntry, enterQuantity, removePart, addPart, leaveRow }; });
  // Estables entre renders: con 50+ insumos solo se repinta la fila que cambia.
  const handlers = useMemo<CountRowHandlers>(() => ({
    setInputRef: (itemId, index, element) => { qtyRefs.current[`${itemId}:${index}`] = element; },
    onChange: (itemId, index, change) => live.current.changeEntry(itemId, index, change),
    onEnter: (itemId, index) => live.current.enterQuantity(itemId, index),
    onRemove: (itemId, index) => live.current.removePart(itemId, index),
    onAdd: (itemId) => live.current.addPart(itemId),
    onToggleParts: (itemId) => setExpandedId((current) => (current === itemId ? null : itemId)),
    onLeave: (itemId, next) => live.current.leaveRow(itemId, next),
    onCodes: (itemId) => setCodesFor(itemId),
  }), []);

  /** Payload PATCH completo, o null si hay alguna cantidad inválida. */
  function buildPayload(): { itemId: string; countedQty: number | null; countedParts: number[] }[] | null {
    const out: { itemId: string; countedQty: number | null; countedParts: number[] }[] = [];
    for (const item of count.items) {
      const parsed = parseCountEntries(entries[item.id] ?? [], item.ingredient.measureKind);
      if (parsed === "invalid") return null;
      out.push({ itemId: item.id, ...parsed });
    }
    return out;
  }

  async function patchDraft(): Promise<CountDetail | null> {
    const items = buildPayload();
    if (!items) { setErr(t("errQtyInvalid")); return null; }
    return requestCount("", { revision: count.revision, items });
  }

  /** «Guardar borrador»: guarda y cierra; con error se queda abierta. */
  async function saveDraft() {
    setErr(null); setBusy(true);
    const saved = await patchDraft();
    setBusy(false);
    if (!saved) return;
    storeOrder(count.id, countOrderReducer(order, { type: "commit" }), stage);
    onDraftSaved();
  }

  /** «Corregir conteo definitivo»: vuelve a dejar editable la revisión final. */
  async function editFinal() {
    setErr(null); setBusy(true);
    await patchDraft();
    setBusy(false);
  }

  async function advance(action: "preliminary" | "recount" | "review") {
    setErr(null); setBusy(true);
    try {
      const saved = action === "recount" ? count : await patchDraft();
      if (saved) await requestCount(action, { revision: saved.revision });
    } finally { setBusy(false); }
  }

  /**
   * Borra la sesión — la API solo lo permite en BORRADOR. Un conteo
   * cerrado ya generó ajustes y movió saldos: borrarlo dejaría el stock
   * mintiendo, por eso ni se ofrece el botón (el pie en modo lectura no lo
   * incluye) y, si igual llegara la respuesta, se muestra el 409 traducido.
   */
  async function deleteSession() {
    setErr(null);
    if (!window.confirm(t("deleteCountConfirm"))) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}`, {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: count.revision }),
      });
      if (!response.ok) { showError((await response.json().catch(() => ({}))).error); return; }
      storeOrder(count.id, null, stage);
      onDeleted();
    } catch { setErr(t("errSaveFailed")); }
    finally { setBusy(false); }
  }

  async function closeSession() {
    if (!count.finalReview) return;
    setErr(null); setBusy(true);
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}/close`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: count.revision, reviewToken: count.finalReview.token }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { showError(result.error); return; }
      acceptCount(result.count as CountDetail);
      setClosedResult(result.adjustments ?? 0);
      storeOrder(count.id, null, stage);
      onClosed();
    } catch { setErr(t("errSaveFailed")); }
    finally { setBusy(false); }
  }

  // ── Hoja de códigos de una fila ──
  const codesItem = codesFor ? count.items.find((item) => item.id === codesFor) ?? null : null;
  const pendingCode = panel?.kind === "unknown" ? panel.code : null;
  function codesSaved(update: IngredientBarcodeUpdate) {
    applyBarcodes(update);
    // El código que no era de nadie quedó en este insumo: al cerrar se cuenta.
    if (codesItem && pendingCode && update.id === codesItem.ingredient.id && ingredientBarcodeValues(update).includes(pendingCode)) {
      countAfterCodes.current = codesItem.id;
      setPanel({ kind: "linked", code: pendingCode, item: { id: codesItem.id, ingredientId: codesItem.ingredient.id, name: codesItem.ingredient.name }, previous: null });
    }
  }
  function closeCodes() {
    const itemId = countAfterCodes.current;
    countAfterCodes.current = null;
    setCodesFor(null);
    const item = itemId && canEdit ? count.items.find((candidate) => candidate.id === itemId) : null;
    if (item) focusItem(item, entries[item.id] ?? []);
  }

  /** Nombre o código repetido al crear: se ofrece el insumo que ya existe. */
  function conflictActions(conflict: IngredientConflict, formBusy: boolean) {
    const { ingredient } = conflict;
    const inCount = count.items.some((item) => item.ingredient.id === ingredient.id);
    return (
      <button
        type="button"
        disabled={formBusy || busy}
        className="mp-btn mp-btn--secondary mp-btn--sm"
        onClick={() => { setCreating(null); void bringIntoCount(ingredient); }}
      >
        <InvIcon name={ingredient.active ? "chevronRight" : "restore"} size={16} />
        {t(inCount ? "countGoToExisting" : ingredient.active ? "countScanAppend" : "countScanRestore", { name: ingredient.name })}
      </button>
    );
  }

  const meta = [formatDate(count.createdAt, { locale }), count.createdBy?.name ?? null, count.notes].filter(Boolean).join(" · ");
  const row = (item: CountItemRow) => (
    <CountRow
      key={item.id}
      item={item}
      entries={entries[item.id] ?? []}
      canEdit={canEdit}
      finalStage={finalStage}
      showPreliminary={showPreliminary}
      codesEnabled={!readOnly}
      busy={busy}
      locale={locale}
      hit={hit?.itemId === item.id}
      expanded={expandedId === item.id}
      errorIndex={quantityError?.itemId === item.id ? quantityError.index : null}
      codesAccent={pendingCode !== null}
      enterHintId={enterHintId}
      handlers={handlers}
    />
  );
  const chips: { value: DifferenceFilter; label: string; total: number; tone?: "danger" | "ok" }[] = [
    { value: "all", label: "filterAll", total: stats.counted + stats.pending },
    { value: "pending", label: "countPending", total: stats.pending },
    { value: "shortage", label: "countShortages", total: stats.shortages, tone: "danger" },
    { value: "surplus", label: "countSurpluses", total: stats.surpluses, tone: "ok" },
  ];

  return (
    <div
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-ink/40 md:items-center md:p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("countTitle")}
        className={"mp-tally" + (showPreliminary ? " mp-tally--prelim" : "") + (canEdit ? "" : " mp-tally--readonly")}
      >
        <div className="mp-tally__bar">
          <h2 className="font-display truncate text-xl md:text-2xl">{t("countTitle")}</h2>
          <span className={"mp-inv-pill shrink-0" + (readOnly ? "" : " mp-inv-pill--ink")}>{t(STAGE_LABEL[stage])}</span>
          <span className="hidden min-w-0 flex-1 truncate text-xs text-op-muted md:block">{meta}</span>
          <span className="flex-1 md:hidden" />
          {canEdit && (
            <button type="button" onClick={() => setCreating({})} disabled={busy} className="mp-btn mp-btn--secondary mp-btn--sm shrink-0" aria-label={t("newIngredient")}>
              <InvIcon name="plus" size={16} />
              <span className="hidden sm:inline">{t("newIngredient")}</span>
              <span className="sm:hidden">{t("countNewIngredientShort")}</span>
            </button>
          )}
          <button type="button" onClick={requestClose} disabled={busy} className="mp-icon-button h-11 w-11 shrink-0" aria-label={t("cancel")}>
            <InvIcon name="close" size={20} />
          </button>
        </div>

        <div ref={regionRef} role="region" aria-label={t("countScrollRegion")} className="mp-tally__scroll" style={{ overflowAnchor: "none" }}>
          <div className="mp-tally__body">
            <div ref={stickyRef} className="mp-tally__sticky">
              <div className="mp-tally__tools">
                {canEdit && (
                  <form onSubmit={handleScan} className="mp-tally-field mp-tally-field--scan" title={t("scanHint")}>
                    <InvIcon name="barcode" size={18} className="shrink-0" />
                    <input
                      ref={scanRef}
                      type="text"
                      value={scan}
                      aria-label={t("scanBarcodeLabel")}
                      // Los lectores HID escriben en el campo enfocado.
                      autoFocus
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      inputMode="text"
                      enterKeyHint="go"
                      disabled={busy}
                      onChange={(event) => setScan(event.target.value)}
                      placeholder={t("scanBarcodePlaceholder")}
                      maxLength={BARCODE_MAX_LENGTH}
                    />
                  </form>
                )}
                <label className="mp-tally-field mp-tally-field--search">
                  <InvIcon name="search" size={18} className="shrink-0" />
                  <input
                    type="search"
                    value={q}
                    autoComplete="off"
                    onChange={(event) => { setQ(event.target.value); setHit(null); setExpandedId(null); }}
                    placeholder={t("countSearchPlaceholder")}
                    aria-label={t("searchCountPlaceholder")}
                  />
                </label>
              </div>

              {panel && (
                <ScanPanelView
                  panel={panel}
                  busy={busy}
                  canEdit={canEdit}
                  onDismiss={() => { lookupRef.current++; setPanel(null); }}
                  onRetry={(code) => void explainCode(code)}
                  onLink={(code, from) => setPicker({ code, from })}
                  onCreate={(code) => setCreating({ barcode: code })}
                  onBring={(match) => void bringIntoCount(match.ingredient)}
                  onUndo={(linked) => void undoLink(linked)}
                />
              )}

              <div className="mp-tally-chips" role="group" aria-label={t("countFilterLabel")}>
                {chips.map((chip) => (
                  <button
                    key={chip.value}
                    type="button"
                    className="mp-tally-chip"
                    data-tone={chip.tone}
                    aria-pressed={differenceFilter === chip.value}
                    onClick={() => { setDifferenceFilter(chip.value); setHit(null); setExpandedId(null); }}
                  >
                    <span>{t(chip.label)}</span>{" "}
                    <b>{chip.total}</b>
                  </button>
                ))}
                <span className="mp-tally-stat"><span>{t("countEqual")}</span>{" "}<b>{stats.equal}</b></span>
                <span className="mp-tally-stat ml-auto pl-2">{t("summaryCounted", { count: stats.counted })}</span>
                {!readOnly && (
                  <button type="button" className="mp-tally-rowbtn" aria-expanded={hintOpen} aria-label={t("countHintToggle")} title={t("countHintToggle")} onClick={() => setHintOpen((open) => !open)}>
                    <InvIcon name="info" size={17} />
                  </button>
                )}
              </div>

              <div className="mp-tally-cols" aria-hidden="true">
                <span />
                <span>{t("countColItem")}</span>
                <span>{canEdit ? t("countColQty") : ""}</span>
                <span className="is-num">{t("countColTotal")}</span>
                {showPreliminary && <span className="is-num">{t("countColFirst")}</span>}
                <span className="is-num">{t("countColExpected")}</span>
                <span className="is-num">{t("countColDiff")}</span>
                <span />
              </div>
            </div>

            {/* El campo de cantidad se describe con esta ayuda (un solo texto para todas las filas). */}
            <p id={enterHintId} className="sr-only">{t("countQuantityEnterHint")}</p>

            {!readOnly && hintOpen && (
              <div className="mx-3 mt-2 flex items-start gap-2 rounded-xl border border-op-border bg-op-bg px-3 py-2 text-[13px] leading-relaxed">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t(STAGE_HINT[stage])}</p>
                  {canEdit && <p className="mt-1 text-xs text-op-muted">{t("countCompactHint")}</p>}
                  {(stage === "preliminary" || stage === "recount") && <p className="mt-1 text-xs text-op-muted">{t("countRecountSafety")}</p>}
                  <p className="mt-1 text-[11px] text-op-muted md:hidden">{meta}</p>
                </div>
                <button type="button" onClick={() => setHintOpen(false)} aria-label={t("closeSheet")} className="mp-icon-button -mr-1 shrink-0">
                  <InvIcon name="close" size={16} />
                </button>
              </div>
            )}

            {closedResult !== null && (
              <div role="status" className="mx-3 mt-2 rounded-xl border border-op-border bg-op-bg px-4 py-3 text-sm text-ok">
                {t("closeCountResult", { count: closedResult })}
              </div>
            )}

            {filtered.length === 0 ? (
              <div className="m-3 rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-6 text-center text-sm text-op-muted">
                {t("emptyFiltered")}
                {canEdit && q.trim() !== "" && (
                  <div className="mt-3">
                    <button type="button" disabled={busy} onClick={() => setCreating({ name: q.trim() })} className="mp-btn mp-btn--secondary mp-btn--sm max-w-full">
                      <InvIcon name="plus" size={16} />
                      <span className="truncate">{t("countCreateNamed", { name: q.trim() })}</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div>
                {recent.length > 0 && (
                  <section aria-label={t("countRecentGroup")}>
                    <h3 className="mp-tally-group">{t("countRecentGroup")}{" "}<b>{recent.length}</b></h3>
                    {recent.map(row)}
                  </section>
                )}
                {rest.length > 0 && (
                  <section aria-label={t(recent.length ? "countRestGroup" : "countAllGroup")}>
                    {recent.length > 0 && <h3 className="mp-tally-group">{t("countRestGroup")}{" "}<b>{rest.length}</b></h3>}
                    {rest.map(row)}
                  </section>
                )}
              </div>
            )}

            <div ref={footRef} className="mp-tally__foot">
              {err && (
                <div role="alert" className="mb-2 rounded-xl border border-danger/30 px-3 py-2 text-sm text-danger">
                  {err}
                  {conflict === "count" && <button type="button" disabled={busy} onClick={reloadCount} className="mt-1 block min-h-[44px] underline">{t("countReload")}</button>}
                  {conflict === "stock" && <button type="button" disabled={busy} onClick={() => advance("recount")} className="mt-1 block min-h-[44px] underline">{t("countRestartRecount")}</button>}
                </div>
              )}
              <div className="mp-tally__actions">
                {readOnly ? (
                  <button type="button" onClick={requestClose} className="mp-btn mp-btn--secondary">{t("closeSheet")}</button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={deleteSession}
                      disabled={busy}
                      aria-label={t("deleteCount")}
                      title={t("deleteCount")}
                      className="mp-btn mp-btn--ghost mp-inv-remove mr-auto !flex-none px-3"
                    >
                      <InvIcon name="trash" size={17} />
                      <span className="hidden sm:inline">{t("deleteCount")}</span>
                    </button>
                    {canEdit && <button type="button" onClick={saveDraft} disabled={busy || !!conflict} className="mp-btn mp-btn--secondary">{busy ? t("saving") : t("saveDraft")}</button>}
                    {stage === "initial" && <button type="button" onClick={() => advance("preliminary")} disabled={busy || !!conflict || stats.counted === 0} className="mp-btn mp-btn--primary">{t("countViewPreliminary")}</button>}
                    {stage === "preliminary" && <button type="button" onClick={() => advance("recount")} disabled={busy || !!conflict} className="mp-btn mp-btn--primary">{t("countStartRecount")}</button>}
                    {stage === "recount" && <button type="button" onClick={() => advance("review")} disabled={busy || !!conflict || stats.pending > 0 || stats.counted === 0} className="mp-btn mp-btn--primary">{t("countReviewFinal")}</button>}
                    {stage === "review" && (
                      <>
                        <button type="button" onClick={editFinal} disabled={busy || !!conflict} className="mp-btn mp-btn--secondary">{t("countEditFinal")}</button>
                        <button type="button" onClick={closeSession} disabled={busy || !!conflict} className="mp-btn mp-btn--primary">{busy ? t("closing") : t("countConfirmFinal")}</button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {codesItem && (
        <BarcodeSheet
          ingredient={codesItem.ingredient}
          suggestedCode={canEdit && codesItem.ingredient.active && codesItem.ingredient.trackInventory ? pendingCode : null}
          moveTargets={moveTargets}
          onSaved={codesSaved}
          onMoved={(source, target) => { applyBarcodes(source); applyBarcodes(target); }}
          onClose={closeCodes}
        />
      )}
      {picker && (
        <CountItemPicker
          title={t(picker.from ? "countScanMove" : "countScanLink")}
          intro={picker.from ? t("countPickMoveIntro", { code: picker.code, name: picker.from.name }) : t("countPickLinkIntro", { code: picker.code })}
          items={picker.from ? count.items.filter((item) => item.ingredient.id !== picker.from?.id) : count.items}
          busy={busy}
          onPick={(item) => void linkCode(picker.code, item, picker.from)}
          onClose={() => setPicker(null)}
        />
      )}
      {creating && (
        <CountNewIngredientDialog
          initialName={creating.name}
          initialBarcode={creating.barcode}
          categories={categories}
          scopeCategory={scopeCategory}
          conflictActions={conflictActions}
          onCreated={(ingredient) => void ingredientCreated(ingredient)}
          onCancel={() => setCreating(null)}
        />
      )}
    </div>
  );
}

/** Aviso bajo la barra de escaneo: qué pasó con el código leído y qué hacer. */
function ScanPanelView({ panel, busy, canEdit, onDismiss, onRetry, onLink, onCreate, onBring, onUndo }: {
  panel: ScanPanel;
  busy: boolean;
  canEdit: boolean;
  onDismiss: () => void;
  onRetry: (code: string) => void;
  onLink: (code: string, from: Named | null) => void;
  onCreate: (code: string) => void;
  onBring: (match: ScanMatch) => void;
  onUndo: (linked: Extract<ScanPanel, { kind: "linked" }>) => void;
}) {
  const t = useTranslations("opErp");
  const tone = panel.kind === "linked" || (panel.kind === "note" && panel.tone === "ok") ? " is-ok" : panel.kind === "note" ? " is-error" : "";
  let text: string;
  let actions: React.ReactNode = null;
  const action = "mp-btn mp-btn--secondary mp-btn--xs";

  if (panel.kind === "looking") {
    text = t("countScanLooking", { code: panel.code });
  } else if (panel.kind === "note") {
    text = panel.text;
  } else if (panel.kind === "linked") {
    text = t("countLinked", { code: panel.code, name: panel.item.name });
    actions = canEdit && (
      <>
        <button type="button" disabled={busy} className={action} onClick={() => onUndo(panel)}>
          <InvIcon name="restore" size={14} />{t("countLinkUndo")}
        </button>
        <button type="button" disabled={busy} className={action} onClick={() => onLink(panel.code, { id: panel.item.ingredientId, name: panel.item.name })}>
          <InvIcon name="swap" size={14} />{t("countLinkFix")}
        </button>
      </>
    );
  } else if (panel.kind === "unknown") {
    text = t(panel.failed ? "countScanUnknown" : "countScanFree", { code: panel.code });
    actions = canEdit && (
      <>
        <button type="button" disabled={busy} className={action} onClick={() => onLink(panel.code, null)}>
          <InvIcon name="barcode" size={14} />{t("countScanLink")}
        </button>
        <button type="button" disabled={busy} className={action} onClick={() => onCreate(panel.code)}>
          <InvIcon name="plus" size={14} />{t("countScanCreate")}
        </button>
        {panel.failed && <button type="button" disabled={busy} className={action} onClick={() => onRetry(panel.code)}>{t("retry")}</button>}
      </>
    );
  } else {
    const { match, code } = panel;
    const { ingredient } = match;
    const values = { code, name: ingredient.name, category: ingredient.category ?? t("countNoCategory"), scope: match.scopeCategory ?? "" };
    text = t(
      match.state === "archived" ? "countScanArchived"
        : match.state === "not_tracked" ? "countScanNotTracked"
          : match.state === "category_excluded" ? "countScanCategoryExcluded"
            : match.state === "outside_scope" ? "countScanOutsideScope"
              : "countScanAddedLater",
      values,
    );
    actions = canEdit && (
      <>
        {match.state === "archived" && (
          <button type="button" disabled={busy} className={action} onClick={() => onBring(match)}>
            <InvIcon name="restore" size={14} />{t("countScanRestore", { name: ingredient.name })}
          </button>
        )}
        {match.canAppend && (
          <button type="button" disabled={busy} className={action} onClick={() => onBring(match)}>
            <InvIcon name="plus" size={14} />{t("countScanAppend", { name: ingredient.name })}
          </button>
        )}
        <button type="button" disabled={busy} className={action} onClick={() => onLink(code, { id: ingredient.id, name: ingredient.name })}>
          <InvIcon name="swap" size={14} />{t("countScanMove")}
        </button>
      </>
    );
  }

  return (
    <div role={panel.kind === "looking" ? "status" : "alert"} className={"mp-tally-note" + tone}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words">{text}</p>
        {panel.kind !== "looking" && (
          <button type="button" onClick={onDismiss} aria-label={t("closeSheet")} className="mp-tally-rowbtn -my-1 -mr-1 !h-8 !w-8">
            <InvIcon name="close" size={15} />
          </button>
        )}
      </div>
      {actions && <div className="mp-tally-note__actions">{actions}</div>}
    </div>
  );
}
