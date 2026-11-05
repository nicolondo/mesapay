"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney, isZeroDecimalCurrency } from "@/lib/format";
import { DISPLAY_UNITS } from "@/lib/erp/units";
import { comboboxKeyAction } from "@/lib/suppliers/supplierSearch";
import { Icon } from "@/components/ui/Icon";
import {
  defaultUnit,
  exactOption,
  PRES,
  rankOptions,
  suggestPrice,
  type OcIngredient,
  type OcOption,
} from "./draft";

const LIST_MAX_PX = 340;
const LIST_MIN_W = 380;

/**
 * Buscador de insumos de una fila (patrón combobox de WAI-ARIA: ↑/↓, Enter,
 * Esc, Tab). Arriba lo de ESTE proveedor — su lista de precios y lo que ya
 * se le pidió, con el último precio y la presentación —, después el resto
 * de los insumos y, al final, «Crear insumo». En la tabla la lista flota
 * (posición fija, no la recorta el scroll de la tabla); en la hoja del
 * celular va en el flujo, a todo lo ancho.
 */
export function IngredientPicker({
  options,
  value,
  onPick,
  onCreate,
  currency,
  floating = false,
  autoFocus = false,
  id,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  className,
  onOpenChange,
}: {
  options: readonly OcOption[];
  value: OcIngredient | null;
  onPick: (o: OcOption) => void;
  onCreate: (text: string) => void;
  currency: string;
  floating?: boolean;
  autoFocus?: boolean;
  id?: string;
  ariaLabel: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const listId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // null = el campo muestra el insumo elegido; string = lo que se escribe.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpenState] = useState(false);
  const [active, setActive] = useState(-1);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  const ranked = useMemo(() => rankOptions(options, query ?? "", 60), [options, query]);
  const trimmed = (query ?? "").trim();
  const typed = query !== null && trimmed !== "";
  const createIndex = ranked.length;
  const optionCount = ranked.length + 1;
  const activeValid = open && active >= 0 && active < optionCount;
  const optId = (i: number) => `${listId}-o${i}`;
  const firstOther = ranked.findIndex((o) => !o.fromSupplier);
  const hasSupplierGroup = ranked.length > 0 && ranked[0]!.fromSupplier;

  const text = query ?? value?.name ?? "";
  const money = (c: number) => formatMoney(c, { currency, locale });

  // En una hoja recién abierta, `showModal()` enfoca el primer [autofocus]
  // (así el teclado del celular sube con el toque); si la hoja ya estaba
  // abierta («Agregar otro»), se enfoca a mano.
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  // La opción resaltada con el teclado, siempre a la vista.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Lista flotante: se ubica bajo el campo (o encima si no cabe) y sigue al
  // campo si la tabla se desplaza. Es medida del DOM, no estado.
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
      const width = Math.min(Math.max(r.width, LIST_MIN_W), window.innerWidth - r.left - 12);
      list.style.position = "fixed";
      list.style.left = `${Math.max(8, r.left)}px`;
      list.style.width = `${width}px`;
      if (below >= 220 || below >= above) {
        list.style.top = `${r.bottom + 4}px`;
        list.style.bottom = "auto";
        list.style.maxHeight = `${Math.max(160, Math.min(LIST_MAX_PX, below))}px`;
      } else {
        list.style.top = "auto";
        list.style.bottom = `${vh - r.top + 4}px`;
        list.style.maxHeight = `${Math.max(160, Math.min(LIST_MAX_PX, above))}px`;
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
    setOpen(false);
    setActive(-1);
  }

  function choose(index: number) {
    if (index === createIndex) {
      closeList();
      onCreate(trimmed);
      return;
    }
    const o = ranked[index];
    if (!o) return;
    setQuery(null);
    closeList();
    onPick(o);
  }

  function onType(next: string) {
    setQuery(next);
    setOpen(true);
    setActive(next.trim() !== "" ? 0 : -1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const { action, preventDefault } = comboboxKeyAction({
      key: e.key,
      open,
      active,
      optionCount,
      createIndex,
      typed,
    });
    // preventDefault también le dice a la tabla que la tecla ya se usó
    // (y, en Esc, que no cierre el diálogo).
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
        setQuery(null);
        break;
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (wrapperRef.current?.contains(e.relatedTarget as Node | null)) return;
    closeList();
    if (query === null) return;
    // Escribió el nombre completo sin elegirlo: se toma.
    const exact = exactOption(options, query);
    if (exact && exact.ingredient.id !== value?.id) {
      setQuery(null);
      onPick(exact);
    } else if (value || trimmed === "") {
      setQuery(null);
    }
  }

  function meta(o: OcOption): string {
    // La misma unidad con la que va a entrar la fila (pickIngredient).
    const unit = defaultUnit(o.ingredient.measureKind, o.supplierItem != null, o.history);
    const price = suggestPrice(o.ingredient, o.supplierItem, o.history ?? undefined, unit, isZeroDecimalCurrency(currency) ? 100 : 1);
    const parts: string[] = [];
    if (o.supplierItem) parts.push(o.supplierItem.presentationLabel);
    if (price) {
      const amount = unit === PRES ? money(price.cents) : t("ocPricePer", { price: money(price.cents), unit });
      parts.push(price.source === "reference" ? t("ocOptReference", { price: amount }) : t("ocOptLastPrice", { price: amount }));
    }
    if (o.history) parts.push(t("ocOptOrders", { count: o.history.orders }));
    return parts.join(" · ");
  }

  return (
    <div ref={wrapperRef} className={"relative " + (className ?? "")} onBlur={onBlur}>
      <input
        ref={(el) => {
          inputRef.current = el;
          if (el && autoFocus) el.setAttribute("autofocus", "");
        }}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeValid ? optId(active) : undefined}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={ariaDescribedBy}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="next"
        value={text}
        placeholder={t("ocSearchPlaceholder")}
        onChange={(e) => onType(e.target.value)}
        onFocus={(e) => {
          if (!value && !open) {
            setOpen(true);
            setActive(-1);
          } else e.currentTarget.select();
        }}
        onClick={() => {
          if (!open) {
            setOpen(true);
            setActive(-1);
          }
        }}
        onKeyDown={onKeyDown}
        data-oc-input="item"
        className={
          floating
            ? "w-full h-9 px-2 rounded-md border border-transparent bg-transparent text-sm font-medium text-op-text placeholder:font-normal placeholder:text-op-muted hover:border-op-border focus:border-op-text/40 focus:bg-op-surface focus:outline-none aria-[invalid=true]:border-danger/60 aria-[invalid=true]:bg-danger/5"
            : "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-base text-op-text placeholder:text-op-muted focus:outline-none focus:border-op-text/40 aria-[invalid=true]:border-danger/60"
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
        {hasSupplierGroup && (
          <li role="presentation" className="px-3 pt-2 pb-1 font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("ocGroupSupplier")}
          </li>
        )}
        {ranked.map((o, i) => (
          <OptionRow
            key={o.ingredient.id}
            id={optId(i)}
            index={i}
            active={i === active}
            selected={o.ingredient.id === value?.id}
            name={o.ingredient.name}
            unitHint={DISPLAY_UNITS[o.ingredient.measureKind].map((u) => u.symbol).join("/")}
            meta={meta(o)}
            header={i === firstOther && firstOther > 0 ? t("ocGroupOthers") : null}
            onChoose={() => choose(i)}
            onHover={() => {
              if (active !== i) setActive(i);
            }}
          />
        ))}
        {ranked.length === 0 && (
          <li role="presentation" className="px-3 py-3 text-sm text-op-muted">
            {t("noIngredientMatches")}
          </li>
        )}
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
            "sticky bottom-0 flex items-center gap-2 min-h-[44px] px-3 py-2 cursor-pointer select-none text-sm font-medium text-op-accent border-t border-op-border " +
            (active === createIndex ? "bg-op-bg" : "bg-op-surface")
          }
        >
          <Icon name="plus" width={16} height={16} className="shrink-0" />
          <span className="min-w-0 break-words">
            {trimmed ? t("ocCreateIngredient", { name: trimmed }) : t("ocCreateIngredientEmpty")}
          </span>
        </li>
      </ul>
      <div aria-live="polite" className="sr-only">
        {open && typed ? t("ocResults", { count: ranked.length }) : ""}
      </div>
    </div>
  );
}

function OptionRow({
  id,
  index,
  active,
  selected,
  name,
  unitHint,
  meta,
  header,
  onChoose,
  onHover,
}: {
  id: string;
  index: number;
  active: boolean;
  selected: boolean;
  name: string;
  unitHint: string;
  meta: string;
  header: string | null;
  onChoose: () => void;
  onHover: () => void;
}) {
  return (
    <>
      {header && (
        <li role="presentation" className="px-3 pt-3 pb-1 border-t border-op-border font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {header}
        </li>
      )}
      <li
        id={id}
        role="option"
        aria-selected={active}
        data-index={index}
        onClick={onChoose}
        onMouseMove={onHover}
        className={
          "flex items-center gap-3 min-h-[44px] px-3 py-1.5 cursor-pointer select-none " +
          (active ? "bg-op-bg" : "")
        }
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug truncate">
            {name}
            <span className="ml-2 font-mono text-[10px] text-op-muted">{unitHint}</span>
          </span>
          {meta && <span className="block text-[11px] text-op-muted leading-snug truncate tabular-nums">{meta}</span>}
        </span>
        {selected && (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-op-accent">
            <path d="m5 12 5 5L19 7" />
          </svg>
        )}
      </li>
    </>
  );
}
