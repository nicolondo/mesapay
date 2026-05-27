"use client";

import { useState } from "react";

/**
 * Lista de mesas con su link directo (el que codifica el QR) y un
 * botón para copiar al portapapeles. Pensado para casos donde el
 * operador quiere mandar el link por chat / pegar en un menú digital
 * en vez de imprimir el QR físico.
 *
 * Marcada `no-print` desde el caller: en la hoja impresa solo van
 * los QRs, esta lista queda fuera.
 */
export function CopyLinkList({
  items,
}: {
  items: Array<{ id: string; label: string; url: string }>;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copy(id: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Algunos browsers viejos sin clipboard API → fallback a
      // textarea + execCommand. Suficientemente robusto para el
      // 99.9% de los casos.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* silently swallow — peor caso el feedback de "copiado" no aparece */
      }
      document.body.removeChild(ta);
    }
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((curr) => (curr === id ? null : curr));
    }, 1500);
  }

  if (items.length === 0) return null;

  return (
    <div className="border border-op-border rounded-2xl bg-op-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-op-border">
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-op-muted">
          Links para compartir
        </div>
        <p className="text-xs text-op-muted mt-0.5">
          Mismo link que codifica el QR de cada mesa. Útil si querés
          mandarlo por chat o pegarlo en otro lado.
        </p>
      </div>
      <ul className="divide-y divide-op-border">
        {items.map((it) => (
          <li
            key={it.id}
            className="px-4 py-2.5 flex items-center gap-3 text-sm"
          >
            <div className="font-mono text-[11px] tracking-wider uppercase w-20 shrink-0 text-op-muted">
              {it.label}
            </div>
            <div className="flex-1 min-w-0 font-mono text-[11px] truncate text-ink-3">
              {it.url}
            </div>
            <button
              type="button"
              onClick={() => copy(it.id, it.url)}
              className={
                "h-8 px-3 rounded-full text-xs font-medium shrink-0 transition-colors " +
                (copiedId === it.id
                  ? "bg-ok/15 text-ok"
                  : "bg-ink text-bone hover:opacity-90")
              }
            >
              {copiedId === it.id ? "Copiado" : "Copiar"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
