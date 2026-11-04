"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import {
  comboboxKeyAction,
  exactSupplierByName,
  rankSuppliers,
  type SupplierSearchItem,
} from "@/lib/suppliers/supplierSearch";

/** Proveedor tal como lo recibe el campo: `{ id, name, taxId?, aliases? }`. */
export type SupplierOption = SupplierSearchItem;

export type SupplierComboboxProps = {
  /** Proveedores del comercio (idealmente con `taxId` para buscar por NIT). */
  suppliers: readonly SupplierOption[];
  /** Id del proveedor elegido, o null. */
  value: string | null;
  /** Al elegir o al borrar (escribir encima también borra la selección). */
  onChange: (id: string | null, supplier: SupplierOption | null) => void;
  /** «+ Crear proveedor»: recibe lo escrito (puede venir vacío). */
  onCreateRequested?: (text: string) => void;
  /** Muestra «Crear proveedor». Por defecto, sí si hay `onCreateRequested`. */
  allowCreate?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Valida en el `<form>`: exige elegir de la lista, no sólo escribir. */
  required?: boolean;
  /** Va en el `<input>` visible, para `<label htmlFor>`. */
  id?: string;
  /** Si se da, agrega `<input type="hidden" name value={id}>` para formularios. */
  name?: string;
  /** Clases del contenedor (ancho, margen). */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

const RECENT_KEY = "mesapay.recentSuppliers";
const RECENT_MAX = 6;
/** Opciones pintadas a la vez; el resto aparece al escribir. */
const LIST_LIMIT = 50;
const LIST_MIN_PX = 168;
const LIST_MAX_PX = 320;

/** Usados hace poco en este dispositivo (ids únicos: sirven para todo comercio). */
function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(id: string): string[] {
  const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Sin storage (modo privado): sólo se pierde el orden de recientes.
  }
  return next;
}

/**
 * Campo de proveedor con autocompletado: se escribe el nombre o el NIT
 * (con o sin DV, puntos o guiones) y se elige de la lista, en vez de
 * buscarlo en un desplegable largo. Sin acentos ni mayúsculas; primero lo
 * que empieza igual, luego inicio de palabra, luego "contiene". Con el
 * campo vacío muestra primero los proveedores usados hace poco en este
 * dispositivo y luego el resto en orden alfabético.
 *
 * La lista llega PRECARGADA (`suppliers`): un comercio tiene decenas o
 * pocos cientos de proveedores, así que se filtra en memoria al instante
 * (la lógica pura vive en `@/lib/suppliers/supplierSearch`). La última
 * opción es siempre «+ Crear proveedor «lo escrito»», que sólo AVISA al
 * formulario anfitrión (`onCreateRequested`); el formulario de alta lo
 * pone el anfitrión.
 *
 * Accesible según el patrón combobox de WAI-ARIA (↑/↓, Enter, Esc, Tab),
 * con mouse y táctil; letra de 16 px en celular (iOS no hace zoom) y la
 * lista se ajusta al alto visible cuando abre el teclado.
 *
 * @example
 * const [supplierId, setSupplierId] = useState<string | null>(null);
 *
 * <label htmlFor="exp-supplier">{t("supplier")}</label>
 * <SupplierCombobox
 *   id="exp-supplier"
 *   name="supplierId"                    // opcional: <input hidden> para <form>
 *   suppliers={suppliers}                // [{ id, name, taxId }]
 *   value={supplierId}
 *   onChange={(id) => setSupplierId(id)}
 *   onCreateRequested={(text) => {
 *     setNewSupplierName(text);          // prellenar el alta inline
 *     setCreatingSupplier(true);
 *   }}
 * />
 * // Tras crear el proveedor: agrégalo a `suppliers` y llama
 * // setSupplierId(nuevo.id) — el campo muestra su nombre solo.
 */
export function SupplierCombobox({
  suppliers,
  value,
  onChange,
  onCreateRequested,
  allowCreate,
  placeholder,
  disabled = false,
  required = false,
  id,
  name,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: SupplierComboboxProps) {
  const t = useTranslations("supplierCombobox");
  const listId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // null = el campo muestra el proveedor elegido; string = lo que se escribe.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recentIds, setRecentIds] = useState<string[]>([]);

  // Si el anfitrión fija otro proveedor (p. ej. el recién creado), el campo
  // deja de mostrar lo escrito y muestra su nombre.
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    if (value !== null) setQuery(null);
  }

  const selected = value ? (suppliers.find((s) => s.id === value) ?? null) : null;
  const text = query ?? selected?.name ?? "";
  const typed = query !== null && query.trim() !== "";
  const canCreate = (allowCreate ?? true) && onCreateRequested !== undefined;

  const ranked = useMemo(
    () => rankSuppliers(suppliers, query ?? "", { recentIds }),
    [suppliers, query, recentIds],
  );
  const shown = ranked.length > LIST_LIMIT ? ranked.slice(0, LIST_LIMIT) : ranked;
  const createIndex = canCreate ? shown.length : -1;
  const optionCount = shown.length + (canCreate ? 1 : 0);
  const activeValid = open && active >= 0 && active < optionCount;
  const optId = (i: number) => `${listId}-opt-${i}`;

  function openList(nextActive: number) {
    if (disabled) return;
    if (!open) setRecentIds(readRecent());
    setOpen(true);
    setActive(nextActive);
  }

  function closeList() {
    setOpen(false);
    setActive(-1);
  }

  function choose(index: number) {
    if (index === createIndex) {
      closeList();
      onCreateRequested?.((query ?? "").trim());
      return;
    }
    const s = shown[index];
    if (!s) return;
    setRecentIds(rememberRecent(s.id));
    setQuery(null);
    closeList();
    if (s.id !== value) onChange(s.id, s);
  }

  function onType(next: string) {
    setQuery(next);
    if (!open) setRecentIds(readRecent());
    setOpen(true);
    // Resalta la mejor coincidencia (o «Crear» si no hay): Enter la toma.
    setActive(next.trim() !== "" ? 0 : -1);
    if (value !== null) onChange(null, null);
  }

  function clear() {
    if (value !== null) onChange(null, null);
    setQuery("");
    inputRef.current?.focus();
    openList(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    const { action, preventDefault } = comboboxKeyAction({
      key: e.key,
      open,
      active,
      optionCount,
      createIndex,
      typed,
    });
    // preventDefault en Esc también evita que se cierre el <dialog> anfitrión.
    if (preventDefault) e.preventDefault();
    switch (action.kind) {
      case "open":
        openList(action.active);
        break;
      case "move":
        setActive(action.active);
        break;
      case "pick":
        choose(action.index);
        break;
      case "close":
        closeList();
        break;
      case "clearText":
        setQuery(null);
        break;
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (wrapperRef.current?.contains(e.relatedTarget as Node | null)) return;
    closeList();
    if (query === null || value !== null) return;
    // Escribió el nombre completo sin elegirlo: lo tomamos.
    const exact = exactSupplierByName(suppliers, query);
    if (exact) {
      setRecentIds(rememberRecent(exact.id));
      setQuery(null);
      onChange(exact.id, exact);
    } else if (query.trim() === "") {
      setQuery(null);
    }
  }

  // La lista va EN EL FLUJO (no flotando): dentro de los sheets con scroll
  // de los formularios, una lista flotante queda recortada por el borde del
  // sheet; en el flujo, el sheet crece y su scroll la alcanza. Al abrir se
  // asegura que se vea (en táctil, el campo sube al tope para dejarle sitio
  // bajo el teclado de iOS) y su alto se ajusta a lo visible: con teclado,
  // lo visible es visualViewport, no la ventana. Se escribe directo en el
  // estilo: es medida del DOM, no estado de React.
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    const list = listRef.current;
    if (!input || !list) return;
    const vv = window.visualViewport;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const visibleBottom = () => (vv ? vv.offsetTop + vv.height : window.innerHeight);
    const fit = () => {
      const space = visibleBottom() - input.getBoundingClientRect().bottom - 12;
      list.style.maxHeight = `${Math.max(LIST_MIN_PX, Math.min(LIST_MAX_PX, Math.floor(space)))}px`;
    };
    const reveal = () => {
      fit();
      if (list.getBoundingClientRect().bottom <= visibleBottom() - 4) return;
      if (coarse) input.scrollIntoView({ block: "start" });
      else list.scrollIntoView({ block: "nearest" });
      fit();
    };
    const frame = requestAnimationFrame(reveal);
    // En táctil el teclado tarda en subir: se vuelve a mirar cuando ya está.
    const timer = coarse ? setTimeout(reveal, 350) : undefined;
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    window.addEventListener("scroll", fit, true);
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      window.removeEventListener("scroll", fit, true);
    };
  }, [open]);

  // La opción resaltada con el teclado siempre a la vista.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // `required` exige elegir de la lista: escribir un nombre no basta.
  useEffect(() => {
    inputRef.current?.setCustomValidity(required && value === null && typed ? t("pickOne") : "");
  }, [required, value, typed, t]);

  const trimmed = (query ?? "").trim();

  return (
    <div ref={wrapperRef} className={"relative " + (className ?? "")} onBlur={onBlur}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeValid ? optId(active) : undefined}
        aria-label={ariaLabel ?? (ariaLabelledBy || id ? undefined : t("listLabel"))}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        required={required}
        disabled={disabled}
        value={text}
        placeholder={placeholder ?? t("placeholder")}
        onChange={(e) => onType(e.target.value)}
        onClick={() => {
          if (!open) openList(-1);
        }}
        onKeyDown={onKeyDown}
        className="w-full min-h-[44px] pl-3 pr-11 rounded-lg border border-op-border bg-op-bg text-base sm:text-sm text-op-text placeholder:text-op-muted focus:outline-none focus:border-op-text/40 disabled:opacity-60 scroll-mt-16"
      />
      {name !== undefined && <input type="hidden" name={name} value={value ?? ""} />}
      {text !== "" && !disabled && (
        <button
          type="button"
          aria-label={t("clear")}
          // mousedown: conserva el foco en el campo (y el teclado en celular).
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          className="absolute right-1 top-[22px] -translate-y-1/2 w-10 h-10 inline-flex items-center justify-center rounded-[var(--radius-btn)] text-op-muted hover:text-op-text hover:bg-op-text/5"
        >
          <Icon name="close" width={16} height={16} />
        </button>
      )}

      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("listLabel")}
        hidden={!open}
        // Tocar o arrastrar la lista no le quita el foco al campo.
        onMouseDown={(e) => e.preventDefault()}
        className="mt-1 overflow-y-auto overscroll-contain rounded-[var(--radius-btn)] border border-op-border bg-op-surface shadow-sm"
        style={{ maxHeight: LIST_MAX_PX }}
      >
        {shown.map((s, i) => (
          <li
            key={s.id}
            id={optId(i)}
            role="option"
            aria-selected={i === active}
            data-index={i}
            onClick={() => choose(i)}
            onMouseMove={() => {
              if (active !== i) setActive(i);
            }}
            className={
              "flex items-center gap-3 min-h-[44px] px-3 py-2 cursor-pointer select-none " +
              (i === active ? "bg-op-bg" : "")
            }
          >
            <span className="min-w-0 flex-1 text-sm leading-snug line-clamp-2 break-words">
              {s.name}
            </span>
            {s.taxId ? (
              <span className="shrink-0 font-mono text-[11px] text-op-muted">
                {t("nit", { taxId: s.taxId })}
              </span>
            ) : null}
            {s.id === value ? (
              <span className="shrink-0 text-op-accent">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m5 12 5 5L19 7" />
                </svg>
                <span className="sr-only">{t("current")}</span>
              </span>
            ) : null}
          </li>
        ))}
        {shown.length === 0 && (
          <li role="presentation" className="px-3 py-3 text-sm text-op-muted">
            {typed ? t("noMatches", { query: trimmed }) : t("empty")}
          </li>
        )}
        {ranked.length > shown.length && (
          <li role="presentation" className="px-3 py-2 text-xs text-op-muted">
            {t("moreHint", { count: suppliers.length })}
          </li>
        )}
        {canCreate && (
          <li
            id={optId(createIndex)}
            role="option"
            aria-selected={active === createIndex}
            data-index={createIndex}
            onClick={() => choose(createIndex)}
            onMouseMove={() => {
              if (active !== createIndex) setActive(createIndex);
            }}
            className={
              // Fija al pie de la lista: siempre a la vista, aunque haya scroll.
              "sticky bottom-0 flex items-center gap-2 min-h-[44px] px-3 py-2 cursor-pointer select-none text-sm font-medium text-op-accent " +
              (shown.length > 0 ? "border-t border-op-border " : "") +
              (active === createIndex ? "bg-op-bg" : "bg-op-surface")
            }
          >
            <Icon name="plus" width={16} height={16} className="shrink-0" />
            <span className="min-w-0 break-words">
              {trimmed ? t("create", { query: trimmed }) : t("createNew")}
            </span>
          </li>
        )}
      </ul>
      <div aria-live="polite" className="sr-only">
        {open && typed ? t("results", { count: ranked.length }) : ""}
      </div>
    </div>
  );
}
