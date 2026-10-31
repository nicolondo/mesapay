"use client";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  groupResults,
  prepareHelpIndex,
  searchHelp,
  splitHighlights,
  suggestQuery,
  type HelpIndexEntry,
  type HighlightRange,
} from "@/lib/help/search";
import { supportMailto } from "@/lib/help/constants";
import { HelpIcon } from "./HelpIcon";

export type HelpSearchCategory = { id: string; title: string; icon: string };
export type HelpSuggestion = { c: string; s: string; t: string };

/**
 * Buscador del centro de ayuda. Recibe el índice ya armado por el servidor
 * (sólo el idioma activo) y busca en el navegador, sin dependencias.
 *
 * - Foco automático (opcional) y atajo "/" desde cualquier parte de la página.
 * - Resultados agrupados por categoría, con lo encontrado resaltado.
 * - Teclado: ↑ ↓ se mueven, Enter abre, Esc borra.
 * - La búsqueda queda en la URL (?q=) para compartirla.
 * - Sin búsqueda se ve `children` (las categorías de la portada).
 */
export function HelpSearch({
  index,
  categories,
  basePath,
  initialQuery = "",
  suggestions,
  autoFocus = false,
  showSupport = true,
  children,
}: {
  index: HelpIndexEntry[];
  categories: HelpSearchCategory[];
  basePath: string;
  initialQuery?: string;
  suggestions: HelpSuggestion[];
  autoFocus?: boolean;
  /** En la app del mesero no se ofrece escribir a soporte: se le pide al encargado. */
  showSupport?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("help");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const deferred = useDeferredValue(query);
  // El resultado marcado se guarda junto con la búsqueda a la que pertenece:
  // al cambiar la búsqueda vuelve solo al primero (Enter abre el primero).
  const [cursor, setCursor] = useState({ q: deferred, i: 0 });
  const active = cursor.q === deferred ? cursor.i : 0;
  const setActive = (next: number | ((i: number) => number)) =>
    setCursor((c) => {
      const current = c.q === deferred ? c.i : 0;
      return { q: deferred, i: typeof next === "function" ? next(current) : next };
    });

  const prepared = useMemo(() => prepareHelpIndex(index), [index]);
  const results = useMemo(() => searchHelp(prepared, deferred), [prepared, deferred]);
  // Cada resultado lleva su posición en la lista plana (la que recorre el
  // teclado), aunque se pinte agrupado por categoría.
  const groups = useMemo(() => {
    let n = 0;
    return groupResults(results).map((g) => ({
      category: g.category,
      items: g.results.map((r) => ({ r, i: n++ })),
    }));
  }, [results]);
  const flat = useMemo(() => groups.flatMap((g) => g.items.map((x) => x.r)), [groups]);
  const suggestion = useMemo(
    () => (deferred.trim() && results.length === 0 ? suggestQuery(prepared, deferred) : null),
    [prepared, deferred, results.length],
  );
  const catById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const hasQuery = deferred.trim().length > 0;
  const hrefOf = (e: HelpIndexEntry) => `${basePath}/${e.c}/${e.s}`;

  // Atajo "/" para enfocar el buscador desde cualquier parte de la página.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ?q= en la URL, sin recargar ni agregar historial en cada tecla.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const url = new URL(window.location.href);
      const q = deferred.trim();
      if (q) url.searchParams.set("q", q);
      else url.searchParams.delete("q");
      const next = url.pathname + url.search + url.hash;
      if (next !== window.location.pathname + window.location.search + window.location.hash) {
        window.history.replaceState(null, "", next);
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [deferred]);

  // El resultado marcado siempre a la vista.
  useEffect(() => {
    if (!hasQuery) return;
    document.getElementById(`help-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, hasQuery]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Escape") {
      if (query) {
        e.preventDefault();
        setQuery("");
      } else {
        inputRef.current?.blur();
      }
    }
  }

  const supportHref = supportMailto(
    t("supportMailSubject", { query: deferred.trim() }),
    t("supportMailBody", { query: deferred.trim() }),
  );

  return (
    <div>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const target = flat[active] ?? flat[0];
          if (target) router.push(hrefOf(target.entry));
        }}
      >
        <label htmlFor="help-search" className="sr-only">
          {t("searchLabel")}
        </label>
        <div className="relative">
          <HelpIcon
            name="search"
            className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-op-muted"
          />
          <input
            id="help-search"
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={hasQuery}
            aria-controls="help-results"
            aria-autocomplete="list"
            aria-activedescendant={hasQuery && flat.length > 0 ? `help-option-${active}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            autoFocus={autoFocus}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("searchPlaceholder")}
            className="h-14 w-full rounded-2xl border border-op-border bg-op-surface pl-12 pr-14 text-base text-op-text shadow-sm outline-none placeholder:text-op-muted focus:border-op-accent focus:ring-2 focus:ring-op-accent/20 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={t("searchClear")}
              className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-op-muted hover:bg-op-bg hover:text-op-text"
            >
              <HelpIcon name="close" className="h-4 w-4" />
            </button>
          ) : (
            <kbd
              aria-hidden="true"
              title={t("searchShortcutHint")}
              className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-op-border bg-op-bg px-2 py-0.5 font-mono text-xs text-op-muted sm:block"
            >
              {"/"}
            </kbd>
          )}
        </div>
      </form>

      {!hasQuery ? (
        children
      ) : results.length === 0 ? (
        <NoResults
          query={deferred.trim()}
          suggestion={suggestion}
          onSuggestion={(s) => {
            setQuery(s);
            inputRef.current?.focus();
          }}
          suggestions={suggestions}
          basePath={basePath}
          supportHref={showSupport ? supportHref : null}
        />
      ) : (
        <div className="mt-6">
          <p aria-live="polite" className="text-sm text-op-muted">
            {t("resultsCount", { count: results.length, query: deferred.trim() })}
            <span className="hidden sm:inline">
              {" · "}
              {t("resultsKeyboardHint")}
            </span>
          </p>
          {results[0]?.partial && (
            <p className="mt-1 text-sm text-op-muted">{t("resultsPartial")}</p>
          )}
          <div
            id="help-results"
            role="listbox"
            aria-label={t("resultsLabel")}
            className="mt-4 space-y-6"
          >
            {groups.map((g) => {
              const cat = catById.get(g.category);
              return (
                <div
                  key={g.category}
                  role="group"
                  aria-labelledby={`help-group-${g.category}`}
                >
                  <div
                    id={`help-group-${g.category}`}
                    className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted"
                  >
                    <HelpIcon name={cat?.icon ?? "help"} className="h-4 w-4" />
                    {cat?.title ?? g.category}
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-op-border bg-op-surface">
                    {g.items.map(({ r, i }) => {
                      const selected = i === active;
                      return (
                        <Link
                          key={r.entry.s}
                          id={`help-option-${i}`}
                          role="option"
                          aria-selected={selected}
                          href={hrefOf(r.entry)}
                          onMouseEnter={() => setActive(i)}
                          className={
                            "flex items-start gap-3 border-b border-op-border px-4 py-3 last:border-b-0 " +
                            (selected ? "bg-op-bg" : "hover:bg-op-bg")
                          }
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium text-op-text">
                              <Highlighted text={r.entry.t} ranges={r.titleRanges} />
                            </span>
                            <span className="mt-0.5 block text-sm leading-relaxed text-op-muted [overflow-wrap:anywhere]">
                              <Highlighted text={r.snippet.text} ranges={r.snippet.ranges} />
                            </span>
                          </span>
                          <HelpIcon
                            name="chevron"
                            className={
                              "mt-1 h-4 w-4 shrink-0 " +
                              (selected ? "text-op-text" : "text-op-muted")
                            }
                          />
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: HighlightRange[] }) {
  return (
    <>
      {splitHighlights(text, ranges).map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-[3px] bg-[#F3D27A]/60 text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function NoResults({
  query,
  suggestion,
  onSuggestion,
  suggestions,
  basePath,
  supportHref,
}: {
  query: string;
  suggestion: string | null;
  onSuggestion: (s: string) => void;
  suggestions: HelpSuggestion[];
  basePath: string;
  supportHref: string | null;
}) {
  const t = useTranslations("help");
  return (
    <div id="help-results" aria-live="polite" className="mt-6 rounded-2xl border border-op-border bg-op-surface p-5">
      <h2 className="text-base font-semibold text-op-text [overflow-wrap:anywhere]">
        {t("noResultsTitle", { query })}
      </h2>
      {suggestion && (
        <p className="mt-2 text-sm">
          {t.rich("didYouMean", {
            suggestion,
            q: (chunks) => (
              <button
                type="button"
                onClick={() => onSuggestion(suggestion)}
                className="font-semibold text-op-accent underline underline-offset-4"
              >
                {chunks}
              </button>
            ),
          })}
        </p>
      )}
      <p className="mt-2 text-sm text-op-muted">{t("noResultsTips")}</p>

      {suggestions.length > 0 && (
        <>
          <h3 className="mt-5 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted">
            {t("suggestedTitle")}
          </h3>
          <ul className="mt-2 space-y-1">
            {suggestions.map((s) => (
              <li key={`${s.c}/${s.s}`}>
                <Link
                  href={`${basePath}/${s.c}/${s.s}`}
                  className="text-sm font-medium text-op-text underline-offset-4 hover:underline"
                >
                  {s.t}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-5 border-t border-op-border pt-4">
        {supportHref ? (
          <>
            <p className="text-sm text-op-muted">{t("noResultsSupport")}</p>
            <a
              href={supportHref}
              className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-bone hover:bg-ink/90"
            >
              <HelpIcon name="mail" className="h-4 w-4" />
              {t("noResultsSupportCta")}
            </a>
          </>
        ) : (
          <p className="text-sm text-op-muted">{t("meseroAskManager")}</p>
        )}
      </div>
    </div>
  );
}
