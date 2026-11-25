import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * "Actualmente, en la página de mesas las mesas que están ocupadas están en
 * la parte de arriba, o sea que se desaparecen de su ubicación original,
 * quisiera que esto siga así, pero que no se desaparezcan de su ubicación
 * original para poderlas ver en orden también."
 *
 * Render estático de la vista de tarjetas: la sección «Activas (N)» de
 * arriba sigue como estaba y debajo sale el salón COMPLETO en orden
 * natural, con las ocupadas en su sitio. Una mesa ocupada se dibuja dos
 * veces, pero es una sola mesa: una sola ficha abierta a la vez.
 */

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...props
  }: ComponentProps<"a"> & { href: string; prefetch?: boolean | null }) =>
    createElement("a", { href, "data-prefetch": String(prefetch), ...props }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/operator/tables",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(",")}` : key,
}));
// El plegado vive en localStorage (por equipo y comercio); acá se fija a
// mano para poder renderear los dos estados. Por defecto, desplegada.
const memory = vi.hoisted(() => ({ collapsed: false }));
vi.mock("./activeSectionMemory", () => ({
  useActiveSectionCollapsed: () => [memory.collapsed, () => {}],
}));

import { MesasGrid, type TileData } from "./MesasGrid";
import type { TableVisualState } from "@/lib/walkoutRisk";

const T0 = Date.parse("2026-11-24T20:00:00Z");

function free(number: number): TileData {
  return { id: `t${number}`, number, label: null, qrToken: `qr${number}`, state: "free" };
}

/** Mesa con cuenta abierta. `visualState` es lo que decide su urgencia. */
function active(
  number: number,
  visualState: TableVisualState = "eating",
  agingMinutes = 5,
): TileData {
  return {
    id: `t${number}`,
    number,
    label: null,
    qrToken: `qr${number}`,
    state: "active",
    visualState,
    risk: { level: "none", agingMinutes, reason: "none" },
    order: {
      id: `o${number}`,
      shortCode: `ORD-${number}`,
      status: "open",
      itemCount: 2,
      subtotalCents: 50_000,
      grossSubtotalCents: 50_000,
      discountCents: 0,
      discountPct: null,
      discountOrigin: null,
      review: null,
      customer: null,
      invoiceRequest: null,
      invoiceIntent: null,
      invoice: null,
      outstandingCents: 50_000,
      needsWaiter: false,
      rounds: [],
      pendingPayments: [],
    },
  };
}

function render(
  tiles: TileData[],
  opts: { openTileId?: string; counterMode?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(MesasGrid, {
      initialTime: T0,
      phonePaidHighlightMinutes: 3,
      tiles,
      initialOpenTileId: opts.openTileId,
      manualPendingCount: 0,
      canOpenManual: false,
      tenantSlug: "test",
      counterMode: opts.counterMode ?? false,
      isMeseroView: false,
      chargeLocked: false,
      moveLocked: false,
      compPolicy: { locked: false, allowedRoles: ["operator"] },
      viewerRole: "operator",
      freeTables: [],
      allTables: [],
      country: "CO",
      salesTax: null,
    }),
  );
}

const tileOrder = (html: string) =>
  [...html.matchAll(/tileTableShort:(\d+)/g)].map((m) => Number(m[1]));

/** `active: null` = no se dibujó la sección de arriba. */
function sections(html: string): { active: number[] | null; all: number[] } {
  const cut = html.indexOf("allTablesHeading");
  if (cut < 0) return { active: null, all: tileOrder(html) };
  return {
    active: tileOrder(html.slice(0, cut)),
    all: tileOrder(html.slice(cut)),
  };
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("MesasGrid — las ocupadas arriba sin desaparecer de su sitio", () => {
  it("la mesa ocupada sale arriba Y otra vez en su lugar de siempre", () => {
    const html = render([free(1), active(2), free(3)]);
    expect(sections(html)).toEqual({ active: [2], all: [1, 2, 3] });
  });

  it("la lista completa va por número, sin importar la urgencia", () => {
    // La 7 pide la cuenta (va de primera arriba), la 2 está comiendo.
    const html = render([free(1), active(2), free(5), active(7, "needs_payment")]);
    expect(sections(html)).toEqual({ active: [7, 2], all: [1, 2, 5, 7] });
  });

  it("sin mesas ocupadas no hay sección de arriba: la lista de siempre", () => {
    const html = render([free(3), free(1), free(2)]);
    expect(sections(html)).toEqual({ active: null, all: [1, 2, 3] });
  });

  it("los encabezados salen por i18n, con el conteo de activas", () => {
    const html = render([free(1), active(2), active(4, "danger")]);
    expect(html).toContain("activeHeading:2");
    expect(html).toContain("allTablesHeading");
    expect(html).toContain("allTablesHint");
  });

  it("con todo el salón ocupado la lista completa igual va por número", () => {
    const html = render([active(2, "danger"), active(1)]);
    expect(sections(html)).toEqual({ active: [2, 1], all: [1, 2] });
  });

  it("en Mostrador no hay doble vista: una sola tarjeta, sin encabezados", () => {
    // El salón de un mostrador es UNA tarjeta («Mostrador»); repetirla bajo
    // «Activas» y «Todas las mesas» no dice nada.
    const html = render([active(1)], { counterMode: true });
    expect(html).not.toContain("activeHeading");
    expect(html).not.toContain("allTablesHeading");
    expect(count(html, "tileCounterShort")).toBe(1);
  });

  it("los encabezados de sección son h2 (van bajo el h1 de la página)", () => {
    const html = render([free(1), active(2)]);
    // El de «Activas» envuelve el botón que pliega; el otro es texto.
    expect(html).toMatch(/<h2[^>]*>\s*<button[^>]*>.*?activeHeading:1.*?<\/button>\s*<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>allTablesHeading<\/h2>/);
  });

  it("las dos apariciones son la misma mesa: una sola ficha abierta", () => {
    const html = render([free(1), active(2), free(3)], { openTileId: "t2" });
    // El sheet se monta una vez (en la lista completa), no una por aparición.
    expect(count(html, "orderStatusTitle")).toBe(1);
  });

  it("sin ficha abierta no se monta ningún sheet", () => {
    const html = render([free(1), active(2)]);
    expect(count(html, "orderStatusTitle")).toBe(0);
  });

  it("la ficha se anuncia como diálogo y puede recibir el foco", () => {
    // El patrón de diálogo que sostiene la contención del foco: la ficha
    // se monta al final de la grilla, lejos del botón que la abrió, así
    // que tiene que capturar el foco y devolverlo al cerrar (ver
    // TableDetailSheet + focusTrap).
    const html = render([free(1), active(2), free(3)], { openTileId: "t2" });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('tabindex="-1"');
    expect(count(html, 'role="dialog"')).toBe(1);
  });

  it("`?open=` de una mesa sin cuenta no abre ninguna ficha", () => {
    const html = render([free(1), active(2)], { openTileId: "t1" });
    expect(count(html, "orderStatusTitle")).toBe(0);
  });
});

/**
 * "Quiero que las mesas activas en la página de mesas se puedan ocultar y
 * desplegar." Plegada, el encabezado con el contador se queda a la vista
 * y las tarjetas no se dibujan; la lista completa no se entera.
 */
describe("MesasGrid — «Activas» se pliega y se despliega", () => {
  afterEach(() => {
    memory.collapsed = false;
  });

  /** El `id` del grid de «Activas», que es lo que el botón controla. */
  const controls = (html: string) =>
    html.match(/aria-controls="([^"]+)"[^>]*class="mp-table-section-toggle"/)?.[1] ??
    html.match(/class="mp-table-section-toggle"[^>]*aria-controls="([^"]+)"/)?.[1] ??
    null;

  it("desplegada por defecto: aria-expanded y las tarjetas dibujadas", () => {
    const html = render([free(1), active(2), free(3)]);
    expect(html).toContain('aria-expanded="true"');
    expect(sections(html)).toEqual({ active: [2], all: [1, 2, 3] });
  });

  it("plegada: queda el encabezado con el contador y ninguna tarjeta", () => {
    memory.collapsed = true;
    const html = render([free(1), active(2), active(7, "needs_payment"), free(3)]);
    // El contador sigue diciendo cuántas hay, sin ocupar pantalla.
    expect(html).toContain("activeHeading:2");
    expect(html).toContain('aria-expanded="false"');
    // Arriba, cero tarjetas; la lista completa, intacta.
    expect(sections(html)).toEqual({ active: [], all: [1, 2, 3, 7] });
  });

  it("el botón controla el grid de «Activas» por id, y plegado va hidden", () => {
    const expanded = render([free(1), active(2)]);
    const id = controls(expanded);
    expect(id).toBeTruthy();
    expect(expanded).toContain(`class="mp-table-grid" id="${id}"`);
    expect(expanded).not.toContain(`id="${id}" hidden`);

    memory.collapsed = true;
    const collapsed = render([free(1), active(2)]);
    expect(collapsed).toContain(`id="${controls(collapsed)}" hidden`);
  });

  it("plegada con una mesa urgente, el encabezado lo insinúa", () => {
    memory.collapsed = true;
    const html = render([free(1), active(2, "danger")]);
    // Punto del mismo tono que el tile (rojo + pulse) y el motivo en texto.
    expect(html).toContain("mp-table-section-dot");
    expect(html).toContain("bg-[#C9302C]");
    expect(html).toContain("animate-pulse");
    expect(html).toContain("activeUrgentHint");
  });

  it("plegada sin nada urgente, el encabezado va limpio", () => {
    memory.collapsed = true;
    const html = render([free(1), active(2, "eating")]);
    expect(html).not.toContain("mp-table-section-dot");
    expect(html).not.toContain("activeUrgentHint");
  });

  it("desplegada no insinúa nada: las tarjetas ya lo dicen", () => {
    const html = render([free(1), active(2, "danger")]);
    expect(html).not.toContain("mp-table-section-dot");
    expect(html).not.toContain("activeUrgentHint");
  });

  it("cada aparición de una mesa ocupada se identifica, para rescatar el foco", () => {
    // Si el botón que abrió la ficha se desmonta (se plegó «Activas»,
    // incluso desde otra pestaña), el foco busca la otra aparición VISIBLE
    // de la misma mesa por este atributo. Ver `restoreActiveFocus`.
    const expanded = render([free(1), active(2)]);
    expect(count(expanded, 'data-table-id="t2"')).toBe(2);

    memory.collapsed = true;
    const collapsed = render([free(1), active(2)]);
    // Plegada queda sólo la de «Todas», que es justo adonde va el foco.
    expect(count(collapsed, 'data-table-id="t2"')).toBe(1);
    // Y si tampoco estuviera, queda el encabezado como último recurso.
    expect(collapsed).toContain("mp-table-section-toggle");
  });

  it("en Mostrador no hay sección, así que tampoco hay nada que plegar", () => {
    memory.collapsed = true;
    const html = render([active(1)], { counterMode: true });
    expect(html).not.toContain("mp-table-section-toggle");
    expect(count(html, "tileCounterShort")).toBe(1);
  });
});
