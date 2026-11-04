"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import { accountLabel, exactAccount, rankAccounts, type AccountSearchItem } from "@/lib/accounts/accountSearch";
import { comboboxKeyAction } from "@/lib/suppliers/supplierSearch";

export type AccountOption = AccountSearchItem;

export type AccountComboboxProps = {
  /** Cuentas que se pueden elegir (ya filtradas: imputables, del tipo que toque). */
  accounts: readonly AccountOption[];
  /** Código elegido, o null (= la opción vacía, si hay). */
  value: string | null;
  onChange: (code: string | null, account: AccountOption | null) => void;
  /**
   * Primera opción, que deja el campo en null: «Automática (por la
   * categoría)». Sin ella, null es simplemente «sin cuenta».
   */
  emptyLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Va en el `<input>` visible, para `<label htmlFor>`. */
  id?: string;
  /** Si se da, agrega `<input type="hidden" name value={código}>`. */
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};

/** Opciones pintadas a la vez; el resto aparece al escribir. */
const LIST_LIMIT = 60;
const LIST_MIN_PX = 168;
const LIST_MAX_PX = 320;

/**
 * Campo de cuenta del PUC con autocompletado: se escribe el código (prefijo:
 * «5135») o palabras del nombre («servicios agua»), sin acentos ni
 * mayúsculas, y se elige de la lista «código · nombre». Mismo patrón que
 * `SupplierCombobox` (WAI-ARIA combobox: ↑/↓, Enter, Esc, Tab; mouse y
 * táctil; letra de 16 px en celular para que iOS no haga zoom; la lista va
 * en el flujo para caber en los sheets).
 *
 * Diferencia a propósito con el de proveedores: escribir NO cambia la
 * cuenta elegida. Sólo elegir de la lista (o borrar con ✕) la cambia; si
 * se sale del campo sin elegir, vuelve a mostrar la que había — salvo que
 * lo escrito sea un código exacto, que se toma.
 */
export function AccountCombobox({
  accounts,
  value,
  onChange,
  emptyLabel,
  placeholder,
  disabled = false,
  required = false,
  id,
  name,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: AccountComboboxProps) {
  const t = useTranslations("accountCombobox");
  const listId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // null = el campo muestra la cuenta elegida; string = lo que se escribe.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // Si el anfitrión fija otra cuenta, el campo deja de mostrar lo escrito.
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setQuery(null);
  }

  const selected = value ? (accounts.find((a) => a.code === value) ?? null) : null;
  // Una cuenta guardada que ya no está en la lista (inactiva) se sigue mostrando.
  const shownValue = selected ? accountLabel(selected) : value ? value : (emptyLabel ?? "");
  const text = query ?? shownValue;
  const typed = query !== null && query.trim() !== "";

  const ranked = useMemo(() => rankAccounts(accounts, typed ? query! : ""), [accounts, query, typed]);
  const shown = ranked.length > LIST_LIMIT ? ranked.slice(0, LIST_LIMIT) : ranked;
  // La opción vacía va primero mientras no se esté buscando.
  const withEmpty = emptyLabel !== undefined && !typed;
  const offset = withEmpty ? 1 : 0;
  const optionCount = shown.length + offset;
  const activeValid = open && active >= 0 && active < optionCount;
  const optId = (i: number) => `${listId}-opt-${i}`;

  function openList(nextActive: number) {
    if (disabled) return;
    setOpen(true);
    setActive(nextActive);
  }

  function closeList() {
    setOpen(false);
    setActive(-1);
  }

  function choose(index: number) {
    setQuery(null);
    closeList();
    if (withEmpty && index === 0) {
      if (value !== null) onChange(null, null);
      return;
    }
    const a = shown[index - offset];
    if (a && a.code !== value) onChange(a.code, a);
  }

  function onType(next: string) {
    setQuery(next);
    setOpen(true);
    // Resalta la mejor coincidencia: Enter la toma.
    setActive(next.trim() !== "" ? 0 : -1);
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
      createIndex: -1,
      typed,
    });
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
    if (query === null) return;
    const exact = exactAccount(accounts, query);
    setQuery(null);
    if (exact && exact.code !== value) onChange(exact.code, exact);
  }

  // Mismo ajuste de alto que el de proveedores: la lista en el flujo, a la
  // vista y del alto de lo visible (con teclado, visualViewport).
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
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const trimmed = (query ?? "").trim();
  const check = (
    <span className="shrink-0 text-op-accent">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m5 12 5 5L19 7" />
      </svg>
      <span className="sr-only">{t("current")}</span>
    </span>
  );

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
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        inputMode="search"
        required={required}
        disabled={disabled}
        value={text}
        placeholder={placeholder ?? t("placeholder")}
        onChange={(e) => onType(e.target.value)}
        onFocus={(e) => {
          // Al entrar se selecciona todo: escribir reemplaza lo que se ve.
          if (query === null) e.currentTarget.select();
        }}
        onClick={() => {
          if (!open) openList(-1);
        }}
        onKeyDown={onKeyDown}
        className="w-full min-h-[44px] pl-3 pr-11 rounded-lg border border-op-border bg-op-bg text-base sm:text-sm text-op-text placeholder:text-op-muted focus:outline-none focus:border-op-text/40 disabled:opacity-60 scroll-mt-16"
      />
      {name !== undefined && <input type="hidden" name={name} value={value ?? ""} />}
      {value !== null && !disabled && (
        <button
          type="button"
          aria-label={emptyLabel ? t("reset", { label: emptyLabel }) : t("clear")}
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
        onMouseDown={(e) => e.preventDefault()}
        className="mt-1 overflow-y-auto overscroll-contain rounded-[var(--radius-btn)] border border-op-border bg-op-surface shadow-sm"
        style={{ maxHeight: LIST_MAX_PX }}
      >
        {withEmpty && (
          <li
            id={optId(0)}
            role="option"
            aria-selected={active === 0}
            data-index={0}
            onClick={() => choose(0)}
            onMouseMove={() => {
              if (active !== 0) setActive(0);
            }}
            className={"flex items-center gap-3 min-h-[44px] px-3 py-2 cursor-pointer select-none border-b border-op-border " + (active === 0 ? "bg-op-bg" : "")}
          >
            <span className="min-w-0 flex-1 text-sm italic">{emptyLabel}</span>
            {value === null ? check : null}
          </li>
        )}
        {shown.map((a, i) => {
          const index = i + offset;
          return (
            <li
              key={a.code}
              id={optId(index)}
              role="option"
              aria-selected={index === active}
              data-index={index}
              onClick={() => choose(index)}
              onMouseMove={() => {
                if (active !== index) setActive(index);
              }}
              className={"flex items-center gap-3 min-h-[44px] px-3 py-2 cursor-pointer select-none " + (index === active ? "bg-op-bg" : "")}
            >
              <span className="shrink-0 font-mono text-xs text-op-muted tabular-nums">{a.code}</span>
              <span className="min-w-0 flex-1 text-sm leading-snug line-clamp-2 break-words">{a.name}</span>
              {a.code === value ? check : null}
            </li>
          );
        })}
        {shown.length === 0 && (
          <li role="presentation" className="px-3 py-3 text-sm text-op-muted">
            {typed ? t("noMatches", { query: trimmed }) : t("empty")}
          </li>
        )}
        {ranked.length > shown.length && (
          <li role="presentation" className="px-3 py-2 text-xs text-op-muted">
            {t("moreHint", { count: ranked.length })}
          </li>
        )}
      </ul>
    </div>
  );
}
