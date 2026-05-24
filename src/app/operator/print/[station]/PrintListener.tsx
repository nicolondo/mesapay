"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Station = "kitchen" | "bar";

type Ticket = {
  restaurantName: string;
  paperWidthMm: number;
  station: Station;
  barSubStation: string | null;
  roundSeq: number;
  placedAt: string;
  order: {
    shortCode: string;
    orderType: "dineIn" | "pickup";
    tableNumber: number;
    pickupName: string | null;
    notes: string | null;
    servingMode: "asReady" | "together";
  };
  items: {
    qty: number;
    name: string;
    modifiers: string[];
    notes: string | null;
    guestName: string | null;
  }[];
};

type PrintEntry = {
  id: string; // roundId + station + sub
  printedAt: number;
  shortCode: string;
  itemCount: number;
};

export function PrintListener({
  tenantSlug,
  tenantName,
  station,
  barSubStation,
  stationEnabled,
  paperWidthMm,
  availableSubStations,
}: {
  tenantSlug: string;
  tenantName: string;
  station: Station;
  barSubStation: string | null;
  stationEnabled: boolean;
  paperWidthMm: number;
  availableSubStations: string[];
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [history, setHistory] = useState<PrintEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [primed, setPrimed] = useState(false);
  // Coalesce events: if the same round fires twice in quick succession
  // (e.g. SSE arrives + we re-process on tab focus), we don't print
  // duplicates. The key is `${roundId}-${station}-${sub ?? ""}`.
  const recentlyPrintedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!stationEnabled) return;
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));
    es.addEventListener("message", (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data?.type !== "ticket.printable") return;
        if (data.station !== station) return;
        // Sub-station filter: when this printer is bound to a specific
        // sub, only fire on matching events. When this printer is the
        // "all bar" view (no sub configured here), fire on everything.
        if (
          barSubStation !== null &&
          data.barSubStation !== barSubStation
        )
          return;
        const dedupeKey = `${data.roundId}-${station}-${data.barSubStation ?? ""}`;
        if (recentlyPrintedRef.current.has(dedupeKey)) return;
        recentlyPrintedRef.current.add(dedupeKey);
        // Forget the dedupe key after a few seconds — long enough to
        // swallow SSE duplicates, short enough that reordering a kitchen
        // ticket later still prints.
        setTimeout(
          () => recentlyPrintedRef.current.delete(dedupeKey),
          15_000,
        );
        printTicket(data.roundId, data.barSubStation);
      } catch {
        /* ignore malformed events */
      }
    });
    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug, station, barSubStation, stationEnabled]);

  async function printTicket(roundId: string, sub: string | null) {
    const qs = new URLSearchParams({ roundId, station });
    if (sub) qs.set("barSubStation", sub);
    try {
      const res = await fetch(`/api/operator/print/ticket?${qs.toString()}`);
      if (!res.ok) return;
      const ticket = (await res.json()) as Ticket;
      renderAndPrint(ticket);
      setHistory((prev) =>
        [
          {
            id: `${roundId}-${Date.now()}`,
            printedAt: Date.now(),
            shortCode: ticket.order.shortCode,
            itemCount: ticket.items.length,
          },
          ...prev,
        ].slice(0, 12),
      );
    } catch {
      /* swallow — the listener stays alive */
    }
  }

  function renderAndPrint(ticket: Ticket) {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const html = buildTicketHtml(ticket);
    iframe.srcdoc = html;
    // The print() call needs to wait for the iframe to load, otherwise
    // we'd print an empty document. The iframe's onload fires once
    // the srcdoc has rendered.
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        /* some browsers throw if printing is blocked; the user can use
           the manual button below as fallback */
      }
    };
  }

  function testPrint() {
    setPrimed(true);
    renderAndPrint(buildSampleTicket(station, barSubStation, paperWidthMm, tenantName));
  }

  const title =
    station === "kitchen"
      ? "Impresora — Cocina"
      : barSubStation
        ? `Impresora — Bar · ${barSubStation}`
        : "Impresora — Bar";

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <div className="flex items-center gap-3 text-sm text-op-muted mb-2">
        <Link href="/operator" className="hover:text-ink">
          Operador
        </Link>
        <span>›</span>
        <span className="text-ink">{title}</span>
      </div>
      <div className="font-display text-3xl mb-1">{title}</div>
      <p className="text-sm text-op-muted mb-6">
        Dejá esta pestaña abierta en el computador con la impresora térmica
        conectada como impresora predeterminada. Los tickets se imprimen
        solos al llegar.
      </p>

      {!stationEnabled ? (
        <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-5 text-sm text-[#7F5A1F]">
          La impresión para esta estación está apagada. Activala en{" "}
          <Link
            href="/operator/settings/estaciones"
            className="underline font-medium"
          >
            Configuración › Estaciones
          </Link>
          .
        </div>
      ) : (
        <>
          {/* Status card */}
          <div className="rounded-2xl border border-op-border bg-op-surface p-5 mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    "inline-block w-2.5 h-2.5 rounded-full " +
                    (connected ? "bg-ok animate-pulse" : "bg-op-muted")
                  }
                />
                <span className="text-sm font-medium">
                  {connected
                    ? "Escuchando pedidos…"
                    : "Sin conexión, intentando reconectar"}
                </span>
              </div>
              <div className="text-xs text-op-muted mt-1">
                Papel: {paperWidthMm}mm · {tenantName}
              </div>
            </div>
            <button
              type="button"
              onClick={testPrint}
              className="h-10 px-4 rounded-xl border border-op-border bg-op-bg text-sm font-medium"
            >
              Imprimir prueba
            </button>
          </div>

          {/* First-run tip about silent printing */}
          {!primed && (
            <div className="rounded-xl border border-op-border bg-paper p-4 mb-4 text-xs text-op-muted">
              <strong className="text-ink-3">Tip de impresión silenciosa:</strong>{" "}
              en el primer ticket aparecerá el diálogo de impresión.
              Activá la opción “Imprimir sin diálogo” o iniciá Chrome con{" "}
              <code className="font-mono bg-op-surface px-1 py-0.5 rounded">
                --kiosk-printing
              </code>{" "}
              y los siguientes saldrán automáticamente. En Mac la opción es
              <em> Sistema › Impresoras › Impresión sin avisos</em>.
            </div>
          )}

          {availableSubStations.length > 0 && station === "bar" && (
            <div className="mb-4 flex gap-2 flex-wrap text-xs">
              <span className="text-op-muted">Esta impresora:</span>
              {barSubStation ? (
                <span className="font-mono tracking-wider uppercase text-ink-3 bg-paper px-2 py-1 rounded">
                  {barSubStation}
                </span>
              ) : (
                <span className="font-mono tracking-wider uppercase text-ink-3 bg-paper px-2 py-1 rounded">
                  TODO EL BAR
                </span>
              )}
              <span className="text-op-muted">· Cambiar:</span>
              <Link
                href={`/operator/print/bar`}
                className="underline text-op-muted"
              >
                Todo
              </Link>
              {availableSubStations.map((s) => (
                <Link
                  key={s}
                  href={`/operator/print/bar?sub=${encodeURIComponent(s)}`}
                  className="underline text-op-muted"
                >
                  {s}
                </Link>
              ))}
            </div>
          )}

          {/* History */}
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted mb-2">
              Últimos tickets
            </div>
            {history.length === 0 && (
              <div className="text-sm text-op-muted py-6 text-center border border-dashed border-op-border rounded-xl">
                Aún no se ha impreso nada en esta sesión.
              </div>
            )}
            <ul className="space-y-1.5">
              {history.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between bg-op-surface border border-op-border rounded-lg px-3 py-2 text-sm"
                >
                  <span className="font-mono">{h.shortCode}</span>
                  <span className="text-op-muted">
                    {h.itemCount} {h.itemCount === 1 ? "ítem" : "ítems"} ·{" "}
                    {new Date(h.printedAt).toLocaleTimeString("es-CO", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* The actual print iframe — off-screen so it never shows. */}
      <iframe
        ref={iframeRef}
        title="Impresión"
        aria-hidden
        className="fixed -left-[9999px] top-0 w-[400px] h-[800px] border-0"
      />
    </div>
  );
}

/**
 * Build the printable HTML for a thermal ticket. We use @page sizing
 * so most browsers render at the printer's actual paper width and
 * skip the standard A4 margins.
 */
function buildTicketHtml(ticket: Ticket): string {
  const width = ticket.paperWidthMm;
  const dest =
    ticket.order.orderType === "pickup"
      ? `RECOGER · ${ticket.order.pickupName ?? ticket.order.shortCode}`
      : `MESA ${ticket.order.tableNumber}`;
  const stationName =
    ticket.station === "kitchen"
      ? "COCINA"
      : ticket.barSubStation
        ? `BAR · ${ticket.barSubStation.toUpperCase()}`
        : "BAR";
  const time = new Date(ticket.placedAt).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Inline styles + a small @page rule. The width is set on body so
  // browsers that don't respect @page still render at the right width.
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Ticket</title>
<style>
  @page { size: ${width}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${width}mm;
    font-family: 'Menlo', 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.25;
    color: #000;
    padding: 4mm 3mm;
  }
  .station {
    font-size: 18px;
    font-weight: 700;
    text-align: center;
    border-bottom: 1px dashed #000;
    padding-bottom: 4px;
    margin-bottom: 6px;
    letter-spacing: 0.04em;
  }
  .dest {
    font-size: 22px;
    font-weight: 700;
    text-align: center;
    margin-bottom: 4px;
  }
  .meta {
    text-align: center;
    font-size: 10px;
    margin-bottom: 6px;
  }
  hr {
    border: 0;
    border-top: 1px dashed #000;
    margin: 4px 0;
  }
  .item {
    margin: 3px 0;
  }
  .qty {
    font-weight: 700;
  }
  .name {
    font-size: 14px;
    font-weight: 700;
  }
  .modifiers, .notes {
    font-size: 11px;
    margin-left: 6mm;
  }
  .guest {
    font-size: 10px;
    margin-left: 6mm;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ordernotes {
    margin-top: 6px;
    font-style: italic;
    font-size: 11px;
  }
  .foot {
    margin-top: 8px;
    text-align: center;
    font-size: 9px;
    color: #444;
  }
</style></head>
<body>
  <div class="station">${escapeHtml(stationName)}</div>
  <div class="dest">${escapeHtml(dest)}</div>
  <div class="meta">${escapeHtml(ticket.order.shortCode)} · R${ticket.roundSeq} · ${time}${ticket.order.servingMode === "together" ? " · FUERTES JUNTOS" : ""}</div>
  <hr/>
  ${ticket.items
    .map(
      (i) => `
    <div class="item">
      <span class="name"><span class="qty">${i.qty}×</span> ${escapeHtml(i.name)}</span>
      ${i.modifiers.length ? `<div class="modifiers">· ${i.modifiers.map(escapeHtml).join(" · ")}</div>` : ""}
      ${i.notes ? `<div class="notes">"${escapeHtml(i.notes)}"</div>` : ""}
      ${i.guestName ? `<div class="guest">${escapeHtml(i.guestName)}</div>` : ""}
    </div>
  `,
    )
    .join("")}
  ${ticket.order.notes ? `<hr/><div class="ordernotes">Mesa: ${escapeHtml(ticket.order.notes)}</div>` : ""}
  <hr/>
  <div class="foot">${escapeHtml(ticket.restaurantName)}</div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSampleTicket(
  station: Station,
  sub: string | null,
  paperWidth: number,
  tenantName: string,
): Ticket {
  return {
    restaurantName: tenantName,
    paperWidthMm: paperWidth,
    station,
    barSubStation: sub,
    roundSeq: 1,
    placedAt: new Date().toISOString(),
    order: {
      shortCode: "PRUEBA",
      orderType: "dineIn",
      tableNumber: 7,
      pickupName: null,
      notes: null,
      servingMode: "asReady",
    },
    items: [
      {
        qty: 1,
        name: "Ticket de prueba",
        modifiers: [],
        notes: "Si ves este texto, la impresora está bien conectada.",
        guestName: null,
      },
    ],
  };
}
