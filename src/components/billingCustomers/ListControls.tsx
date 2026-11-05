"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";

/**
 * Piezas compartidas por las dos pestañas de /operator/clientes (clientes
 * para facturación y comensales registrados): encabezado, pestañas,
 * buscador, selectores, paginación y la tabla de escritorio.
 *
 * Los filtros viven en la URL: cada cambio navega (push para filtros y
 * páginas, así el botón atrás funciona; replace para lo que se teclea en el
 * buscador) y el servidor vuelve a consultar. Mientras llega la respuesta la
 * lista se atenúa (`pending`).
 */
export function useListNavigation() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function go(href: string, mode: "push" | "replace" = "push") {
    startTransition(() => {
      if (mode === "replace") router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    });
  }
  function refresh() {
    startTransition(() => router.refresh());
  }
  return { pending, go, refresh };
}

export function CustomersHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-x-4 gap-y-3 mb-4 sm:items-end">
      <div className="min-w-0">
        <h1 className="font-display text-2xl lg:text-3xl tracking-[-0.015em]">{title}</h1>
        {/* En el celular la bajada se omite: las pestañas ya dicen qué hay y la lista sube. */}
        <p className="hidden sm:block text-sm text-op-muted mt-1 max-w-2xl">{subtitle}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export type TabItem = { href: string; label: string; count: number; active: boolean };

/** Pestañas como enlaces (cada una es una URL), con el total de cada lista. */
export function CustomersTabs({ items, label }: { items: TabItem[]; label: string }) {
  return (
    <nav aria-label={label} className="mb-5">
      <div className="mp-seg w-full sm:w-auto">
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            prefetch={false}
            aria-current={it.active ? "page" : undefined}
            data-active={it.active ? "true" : undefined}
            className="mp-seg__i flex-1 sm:flex-none justify-center"
          >
            <span>{it.label}</span>
            <span className="font-mono text-[11px] tabular text-op-muted">{it.count}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

const SEARCH_DEBOUNCE_MS = 350;

/**
 * Buscador que busca mientras se escribe (con una pausa corta) y también con
 * Enter. Si la URL cambia por otro lado —atrás, "Limpiar filtros"— el texto
 * se pone al día; lo que se está escribiendo no se pisa con la respuesta de
 * una búsqueda propia.
 */
export function SearchBox({
  id,
  label,
  placeholder,
  value,
  onSearch,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onSearch: (q: string) => void;
}) {
  const [text, setText] = useState(value);
  // Lo último que pedimos a la URL y lo último que la URL nos devolvió.
  const [requested, setRequested] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== requested) {
      setRequested(value);
      setText(value);
    }
  }
  function submit(q: string) {
    setRequested(q);
    onSearch(q);
  }
  // El temporizador del efecto llama a la versión más reciente de `submit`.
  const searchLater = useEffectEvent((q: string) => submit(q));
  useEffect(() => {
    const q = text.trim();
    if (q === requested) return;
    const timer = setTimeout(() => searchLater(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, requested]);
  return (
    <form
      role="search"
      className="relative min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        const q = text.trim();
        if (q !== requested) submit(q);
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-op-muted"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        id={id}
        type="search"
        autoComplete="off"
        value={text}
        maxLength={120}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-[var(--radius-btn)] border border-op-border-2 bg-op-surface pl-10 pr-3 text-base sm:text-sm text-op-text placeholder:text-op-muted focus:outline-none focus:border-op-accent focus:ring-2 focus:ring-op-accent/25"
      />
    </form>
  );
}

/** Selector nativo con su etiqueta visible arriba (filtros y orden). */
export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-11 w-full rounded-[var(--radius-btn)] border border-op-border-2 bg-op-surface px-3 text-sm text-op-text focus:outline-none focus:border-op-accent focus:ring-2 focus:ring-op-accent/25"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Control segmentado de filtro (Todos / Empresas / Personas). */
export function SegmentedFilter<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">{label}</div>
      <div role="group" aria-label={label} className="mp-seg w-full @xl:w-auto p-[3px]!">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            data-active={value === o.value ? "true" : undefined}
            onClick={() => onChange(o.value)}
            className="mp-seg__i flex-1 @xl:flex-none justify-center px-3!"
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** «Mostrando 1–50 de 128» con Anterior / Siguiente (enlaces: la página vive en la URL). */
export function ListPagination({
  from,
  to,
  total,
  prevHref,
  nextHref,
}: {
  from: number;
  to: number;
  total: number;
  prevHref: string | null;
  nextHref: string | null;
}) {
  const t = useTranslations("opCustomers");
  if (total === 0) return null;
  return (
    <nav aria-label={t("paginationLabel")} className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-op-muted tabular" aria-live="polite">
        {t("pageRange", { from, to, total })}
      </span>
      {(prevHref || nextHref) && (
        <span className="flex gap-2">
          {prevHref ? (
            <Link href={prevHref} prefetch={false} scroll={false} className="mp-btn mp-btn--secondary mp-btn--sm">
              <span aria-hidden>{"←"}</span>
              {t("pagePrev")}
            </Link>
          ) : (
            <span aria-disabled className="mp-btn mp-btn--secondary mp-btn--sm opacity-45 pointer-events-none">
              <span aria-hidden>{"←"}</span>
              {t("pagePrev")}
            </span>
          )}
          {nextHref ? (
            <Link href={nextHref} prefetch={false} scroll={false} className="mp-btn mp-btn--secondary mp-btn--sm">
              {t("pageNext")}
              <span aria-hidden>{"→"}</span>
            </Link>
          ) : (
            <span aria-disabled className="mp-btn mp-btn--secondary mp-btn--sm opacity-45 pointer-events-none">
              {t("pageNext")}
              <span aria-hidden>{"→"}</span>
            </span>
          )}
        </span>
      )}
    </nav>
  );
}

export function Th({ children, align, className = "" }: { children?: ReactNode; align?: "right"; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-3 py-3 first:pl-4 last:pr-4 font-mono text-[10px] font-normal tracking-[0.14em] uppercase text-op-muted whitespace-nowrap ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, align, className = "" }: { children?: ReactNode; align?: "right"; className?: string }) {
  return <td className={`px-3 py-3 first:pl-4 last:pr-4 align-top ${align === "right" ? "text-right" : ""} ${className}`}>{children}</td>;
}

/** Lista vacía o sin coincidencias, con la salida que corresponda. */
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-op-border-2 bg-op-surface/60 px-6 py-12 text-center">
      <p className="font-medium text-op-text">{title}</p>
      {body && <p className="mt-1 text-sm text-op-muted max-w-md mx-auto">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
