"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { comboboxKeyAction } from "@/lib/suppliers/supplierSearch";
import {
  formatUnitCost,
  rankIngredients,
  unitSymbols,
  type IngredientOption,
} from "../recipeModel";
import { WarningIcon } from "./icons";

const LIST_MAX_PX = 320;
const LIST_MIN_W = 420;

/**
 * Buscador para agregar un insumo (o una sub-receta: un insumo elaborado)
 * a la receta — patrón combobox de WAI-ARIA: ↑/↓ recorren, Enter agrega,
 * Esc cierra la lista (o borra lo escrito). Cada opción muestra su unidad y
 * su costo vigente, o «Sin costo». En la tabla la lista flota (no la recorta
 * el scroll del diálogo); en el celular va en el flujo.
 */
export function IngredientCombobox({
  options,
  subRecipeIds,
  currency,
  onPick,
  placeholder,
  ariaLabel,
  floating = false,
  autoFocus = false,
  inputClassName,
}: {
  options: readonly IngredientOption[];
  subRecipeIds: ReadonlySet<string>;
  currency: string;
  onPick: (o: IngredientOption) => void;
  placeholder: string;
  ariaLabel: string;
  floating?: boolean;
  autoFocus?: boolean;
  inputClassName?: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const listId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  // En el flujo (hoja del celular) la lista siempre está a la vista.
  const [open, setOpen] = useState(!floating);
  const [active, setActive] = useState(-1);

  const ranked = useMemo(() => rankIngredients(options, query), [options, query]);
  const typed = query.trim() !== "";
  const optId = (i: number) => `${listId}-o${i}`;
  const activeValid = open && active >= 0 && active < ranked.length;

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  // La opción resaltada con el teclado, siempre a la vista.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Lista flotante: debajo del campo (o encima si no cabe), y lo sigue si el
  // diálogo se desplaza. Es medida del DOM, no estado.
  useLayoutEffect(() => {
    if (!open || !floating) return;
    const input = inputRef.current;
    const list = listRef.current;
    if (!input || !list) return;
    const place = () => {
      const r = input.getBoundingClientRect();
      const vh = window.innerHeight;
      const below = vh - r.bottom - 12;
      const above = r.top - 12;
      const width = Math.min(
        Math.max(r.width, LIST_MIN_W),
        window.innerWidth - r.left - 12,
      );
      list.style.position = "fixed";
      list.style.left = `${Math.max(8, r.left)}px`;
      list.style.width = `${width}px`;
      if (below >= 200 || below >= above) {
        list.style.top = `${r.bottom + 4}px`;
        list.style.bottom = "auto";
        list.style.maxHeight = `${Math.max(140, Math.min(LIST_MAX_PX, below))}px`;
      } else {
        list.style.top = "auto";
        list.style.bottom = `${vh - r.top + 4}px`;
        list.style.maxHeight = `${Math.max(140, Math.min(LIST_MAX_PX, above))}px`;
      }
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, floating]);

  function closeList() {
    if (floating) setOpen(false);
    setActive(-1);
  }

  function choose(index: number) {
    const o = ranked[index];
    if (!o) return;
    setQuery("");
    closeList();
    onPick(o);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const { action, preventDefault } = comboboxKeyAction({
      key: e.key,
      open,
      active,
      optionCount: ranked.length,
      createIndex: -1,
      typed,
    });
    // preventDefault también evita que Esc cierre el diálogo.
    if (preventDefault) e.preventDefault();
    switch (action.kind) {
      case "open":
        setOpen(true);
        setActive(action.active);
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
        setQuery("");
        break;
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (wrapperRef.current?.contains(e.relatedTarget as Node | null)) return;
    closeList();
  }

  return (
    <div ref={wrapperRef} className="relative" onBlur={onBlur}>
      <input
        ref={(el) => {
          inputRef.current = el;
          // En una hoja recién abierta, showModal() enfoca el [autofocus]
          // (así el teclado del celular sube con el mismo toque).
          if (el && autoFocus) el.setAttribute("autofocus", "");
        }}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeValid ? optId(active) : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(e.target.value.trim() !== "" ? 0 : -1);
        }}
        onFocus={() => {
          if (!open) {
            setOpen(true);
            setActive(-1);
          }
        }}
        onClick={() => {
          if (!open) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        data-recipe-add=""
        className={
          inputClassName ??
          "w-full min-h-[44px] px-3 rounded-[var(--radius-btn)] border border-op-border bg-op-bg text-base text-op-text placeholder:text-op-muted focus:outline-none focus:border-op-text/40"
        }
      />
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        hidden={!open}
        onMouseDown={(e) => e.preventDefault()}
        className={
          "overflow-y-auto overscroll-contain rounded-[var(--radius-btn)] border border-op-border bg-op-surface " +
          (floating ? "z-[60] shadow-[var(--shadow-3)]" : "mt-1 shadow-sm")
        }
        style={floating ? undefined : { maxHeight: LIST_MAX_PX }}
      >
        {ranked.map((o, i) => {
          const isSub = subRecipeIds.has(o.id);
          return (
            <li
              key={o.id}
              id={optId(i)}
              role="option"
              aria-selected={i === active}
              data-index={i}
              onClick={() => choose(i)}
              onMouseMove={() => {
                if (active !== i) setActive(i);
              }}
              className={
                "flex items-center gap-3 min-h-[44px] px-3 py-1.5 cursor-pointer select-none " +
                (i === active ? "bg-op-bg" : "")
              }
            >
              <span className="min-w-0 flex-1 flex items-center gap-2">
                <span className="text-sm leading-snug truncate">{o.name}</span>
                <span className="font-mono text-[10px] text-op-muted shrink-0">
                  {unitSymbols(o.measureKind)}
                </span>
                {isSub && <SubRecipeTag />}
              </span>
              {o.costPerBase != null ? (
                <span className="text-[12px] text-op-muted tabular-nums shrink-0">
                  {formatUnitCost(o.costPerBase, o.measureKind, currency, locale)}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[12px] text-[#7F5A1F] shrink-0">
                  <WarningIcon size={12} />
                  {t("noCostBadge")}
                </span>
              )}
            </li>
          );
        })}
        {ranked.length === 0 && (
          <li role="presentation" className="px-3 py-3 text-sm text-op-muted">
            {options.length === 0 ? t("rdNoMoreIngredients") : t("noIngredientMatches")}
          </li>
        )}
      </ul>
      <div aria-live="polite" className="sr-only">
        {open && typed ? t("rdResults", { count: ranked.length }) : ""}
      </div>
    </div>
  );
}

/** Etiqueta «Sub-receta»: el insumo es una preparación propia. */
export function SubRecipeTag() {
  const t = useTranslations("opErp");
  return (
    <span className="inline-flex items-center h-[18px] px-1.5 rounded-md bg-op-accent/10 text-op-accent text-[10px] font-medium shrink-0">
      {t("rdSubRecipeTag")}
    </span>
  );
}
