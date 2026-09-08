"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Autocompletado de municipio colombiano contra el catálogo DIVIPOLA
 * del DANE.
 *
 * POR QUÉ EXISTE: el código DANE del municipio viaja en la factura
 * electrónica y la DIAN resuelve con él el punto de facturación. Nadie
 * escribe "05266" de memoria sin equivocarse, así que el operador
 * BUSCA "Envigado" y el componente devuelve el código. Muestra
 * "Municipio, Departamento" porque hay nombres repetidos (5 "San Juan",
 * 3 "Providencia"): sin el departamento el operador elige a ciegas.
 *
 * Las opciones llegan del server (/api/operator/dane/municipios); el
 * catálogo entero (~100 KB) NUNCA se manda al navegador.
 *
 * Es genérico a propósito — no sabe nada de "datos legales" ni de la
 * pantalla de identidad. Recibe un valor y avisa cuando cambia; sirve
 * en cualquier formulario que necesite un municipio con código.
 */

export type MunicipioOption = {
  /** Código DANE del municipio (5 dígitos). */
  code: string;
  name: string;
  /** Código DANE del departamento (2 dígitos). */
  deptCode: string;
  deptName: string;
  /** "Envigado, Antioquia" — lo arma el server. */
  label: string;
};

export function MunicipioAutocomplete({
  value,
  onChange,
  disabled = false,
  placeholder,
  inputClassName,
}: {
  /**
   * Valor actual. `label` es opcional: si viene solo el código (lo
   * normal al cargar lo guardado en DB), el componente lo resuelve
   * contra el endpoint y muestra el nombre.
   */
  value: { code: string; label?: string | null } | null;
  onChange: (m: MunicipioOption | null) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Para que cada pantalla use sus propias clases de input. */
  inputClassName?: string;
}) {
  const t = useTranslations("daneCity");
  const listId = useId();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<MunicipioOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Cache código → nombre, para poder mostrar "Envigado, Antioquia"
  // cuando el padre solo tiene guardado "05266". Es cache y no estado
  // derivado: así el nombre a mostrar se calcula en el render y no hace
  // falta sincronizarlo con un efecto.
  const [labelByCode, setLabelByCode] = useState<Record<string, string>>({});
  const boxRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Descarta respuestas viejas que llegan tarde y pisarían a las nuevas.
  const reqIdRef = useRef(0);

  const selectedCode = value?.code ?? null;
  const selectedLabel = selectedCode
    ? (value?.label ?? labelByCode[selectedCode] ?? null)
    : null;

  // Hidratar el nombre cuando solo tenemos el código guardado en DB.
  useEffect(() => {
    if (!selectedCode || value?.label || labelByCode[selectedCode]) return;
    let cancelled = false;
    fetch(
      `/api/operator/dane/municipios?code=${encodeURIComponent(selectedCode)}`,
    )
      .then((r) => (r.ok ? r.json() : { results: [] }))
      .then((j: { results: MunicipioOption[] }) => {
        if (cancelled) return;
        setLabelByCode((prev) => ({
          ...prev,
          // Sin red o código desconocido mostramos el código pelado:
          // peor es dejar el campo en blanco y que parezca sin cargar.
          [selectedCode]: j.results[0]?.label ?? selectedCode,
        }));
      })
      .catch(() => {
        if (!cancelled) {
          setLabelByCode((prev) => ({ ...prev, [selectedCode]: selectedCode }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCode, value?.label, labelByCode]);

  // Al desmontar, cancelamos lo que quede en vuelo.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  /**
   * Búsqueda con debounce. Va acá y no en un useEffect porque la
   * dispara el operador al escribir (un evento), no el render.
   */
  function runSearch(raw: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const q = raw.trim();
    const id = ++reqIdRef.current;
    if (q.length < 2) {
      setOptions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    timerRef.current = setTimeout(() => {
      fetch(`/api/operator/dane/municipios?q=${encodeURIComponent(q)}`, {
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((j: { results: MunicipioOption[] }) => {
          if (id !== reqIdRef.current) return;
          setOptions(j.results);
          setHighlight(0);
          setLoading(false);
        })
        .catch(() => {
          // AbortError incluido: si abortamos es porque ya hay otra
          // búsqueda en curso, no hay nada que reportar.
        });
    }, 200);
  }

  // Cerrar al hacer click afuera, sin descartar lo ya elegido.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function close() {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    reqIdRef.current++;
    setOpen(false);
    setQuery("");
    setOptions([]);
    setLoading(false);
  }

  function pick(m: MunicipioOption) {
    setLabelByCode((prev) => ({ ...prev, [m.code]: m.label }));
    onChange(m);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (options[highlight]) {
        e.preventDefault();
        pick(options[highlight]);
      }
    } else if (e.key === "Escape") {
      close();
    }
  }

  const cls =
    inputClassName ??
    "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";

  // Con municipio elegido y sin buscar, mostramos el nombre; al enfocar
  // se vacía para escribir. Así el campo se lee como un campo normal.
  const inputValue = open ? query : (selectedLabel ?? "");

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={inputValue}
        placeholder={placeholder ?? t("placeholder")}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
          runSearch(e.target.value);
        }}
        onKeyDown={onKeyDown}
        className={cls}
      />

      {selectedCode && !open && (
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[10px] text-op-muted">
            {t("daneCode", { code: selectedCode })}
          </span>
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-[10px] text-danger hover:underline"
            >
              {t("clear")}
            </button>
          )}
        </div>
      )}

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-auto rounded-lg border border-op-border bg-op-surface shadow-lg"
        >
          {query.trim().length < 2 ? (
            <li className="px-3 py-2 text-xs text-op-muted">{t("typeMore")}</li>
          ) : loading ? (
            <li className="px-3 py-2 text-xs text-op-muted">
              {t("searching")}
            </li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-xs text-op-muted">
              {t("noResults")}
            </li>
          ) : (
            options.map((m, i) => (
              <li key={m.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(m)}
                  className={
                    "w-full text-left px-3 py-2 flex items-center justify-between gap-3 " +
                    (i === highlight ? "bg-op-bg" : "")
                  }
                >
                  <span className="text-sm truncate">{m.label}</span>
                  <span className="font-mono text-[10px] text-op-muted shrink-0">
                    {m.code}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
