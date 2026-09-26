import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import es from "../../../../../messages/es.json";
import { stationPrintHealth } from "@/lib/print/stationPrintHealth";

/**
 * Configuración → Impresoras de red, sección Facturas: sin impresora de
 * facturas en el agente, las facturas salen por el navegador (el driver de
 * Windows, que corta las largas en dos tiras) y la pantalla lo tiene que
 * decir, con el selector ahí mismo. El caso real: Barra, Caja y Cocina,
 * todas de comanda, sin ninguna elegida.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { PrintersClient } from "./PrintersClient";

type Props = ComponentProps<typeof PrintersClient>;
type Printer = Props["agents"][number]["printers"][number];

const comanda = (id: string, label: string, station: string): Printer => ({
  id,
  localKey: id,
  label,
  host: "192.168.1.50",
  port: 9100,
  kind: "comanda",
  station,
  barSubStation: null,
  paperWidthMm: 80,
  active: true,
  supportsQr: false,
});

function render(printers: Printer[], invoice: Partial<Props["invoiceSettings"]> = {}) {
  const props: Props = {
    agents: [
      {
        id: "agent-1",
        label: "PC de la caja",
        tokenTail: "abcd",
        lastSeenAt: "2026-09-26T12:00:00.000Z",
        agentVersion: "1.0.0",
        lastIp: "192.168.1.10",
        revokedAt: null,
        printers,
      },
    ],
    orphanPrinters: [],
    jobs: [],
    defaultPaperWidthMm: 80,
    serverNow: "2026-09-26T12:00:10.000Z",
    health: stationPrintHealth({
      kitchenPrintEnabled: true,
      barPrintEnabled: true,
      kitchenAutoFire: true,
      barAutoFire: true,
      barSubStations: [],
      printers: printers.map((p) => ({ ...p, station: p.station as never })),
    }),
    invoiceSettings: { printerId: null, autoPrint: true, einvoicing: true, ...invoice },
  };
  const intl = {
    locale: "es",
    timeZone: "America/Bogota",
    messages: es,
  } as unknown as ComponentProps<typeof NextIntlClientProvider>;
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, intl, createElement(PrintersClient, props)),
  );
}

const sonYMelona = [
  comanda("p-barra", "Barra", "bar"),
  comanda("p-caja", "Caja", "bar"),
  comanda("p-cocina", "Cocina", "kitchen"),
];

describe("sección Facturas — sin impresora de facturas en el agente", () => {
  it("avisa que salen por el navegador y que conviene elegir una del agente (p. ej. la de Caja)", () => {
    const html = render(sonYMelona);
    expect(html).toContain(es.opPrinters.invoiceBrowserWarning.replace(/"/g, "&quot;"));
    // Y recuerda lo del QR (con facturación electrónica).
    expect(html).toContain(es.opPrinters.invoiceQrReminder.replace(/"/g, "&quot;"));
  });

  it("con la Caja elegida (aunque sea de comanda) ya no avisa lo del navegador", () => {
    const html = render(sonYMelona, { printerId: "p-caja" });
    expect(html).not.toContain(es.opPrinters.invoiceBrowserWarning);
    // Pero la Caja no declaró QR: sigue el recordatorio de la prueba.
    expect(html).toContain(es.opPrinters.invoiceQrReminder.replace(/"/g, "&quot;"));
  });

  it("con la Caja elegida y el QR confirmado, ni aviso ni recordatorio", () => {
    const conQr = sonYMelona.map((p) => (p.id === "p-caja" ? { ...p, supportsQr: true } : p));
    const html = render(conQr, { printerId: "p-caja" });
    expect(html).not.toContain(es.opPrinters.invoiceBrowserWarning);
    expect(html).not.toContain(es.opPrinters.invoiceQrReminder);
  });

  it("sin facturación electrónica no hay recordatorio de QR", () => {
    const html = render(sonYMelona, { einvoicing: false });
    expect(html).toContain(es.opPrinters.invoiceBrowserWarning.replace(/"/g, "&quot;"));
    expect(html).not.toContain(es.opPrinters.invoiceQrReminder);
  });
});
