import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * "Cuando una mesa acaba de pagar directamente desde el móvil quiero que
 * salga en verde de primera en la lista de mesas por los siguientes 3
 * minutos." Render estático de la grilla: qué tile va primero, con qué
 * rótulo y con qué verde, y qué pasa cuando vence el tiempo.
 */

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...props
  }: ComponentProps<"a"> & { href: string; prefetch?: boolean | null }) =>
    // `prefetch` no es un atributo HTML: va como data-* para no ensuciar el <a>.
    createElement("a", { href, "data-prefetch": String(prefetch), ...props }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/operator/tables",
  useSearchParams: () => new URLSearchParams(),
}));
// Las claves salen tal cual; con parámetros, "clave:valor" para distinguir
// la mesa 9 de la 1 en el HTML.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(",")}` : key,
}));

import { MesasGrid, type TileData } from "./MesasGrid";

const T0 = Date.parse("2026-11-02T20:00:00Z");
const min = (n: number) => n * 60_000;

function free(number: number): TileData {
  return { id: `t${number}`, number, label: null, qrToken: `qr${number}`, state: "free" };
}
function recentlyPaid(number: number, paidAgoMin: number, paidFromPhone: boolean): TileData {
  return {
    id: `t${number}`,
    number,
    label: null,
    qrToken: `qr${number}`,
    state: "recently_paid",
    paidAt: new Date(T0 - min(paidAgoMin)).toISOString(),
    paidFromPhone,
  };
}

function render(tiles: TileData[], opts: { now?: number; minutes?: number } = {}) {
  return renderToStaticMarkup(
    createElement(MesasGrid, {
      initialTime: opts.now ?? T0,
      phonePaidHighlightMinutes: opts.minutes ?? 3,
      tiles,
      manualTiles: [],
      canOpenManual: false,
      tenantSlug: "test",
      counterMode: false,
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

describe("MesasGrid — mesa que acaba de pagar desde el celular", () => {
  it("sale de primera, en verde fuerte y con «Pagó desde el celular · hace 1 min»", () => {
    const html = render([free(1), recentlyPaid(9, 1, true), free(3)]);
    expect(tileOrder(html)).toEqual([9, 1, 3]);
    expect(html).toContain("tilePaidFromPhone");
    expect(html).toContain("elapsedAgo:1");
    expect(html).toContain("bg-ok text-bone");
    expect(html).not.toContain("bg-ok/10");
  });

  it("recién pagada en este instante dice «ahora»", () => {
    const html = render([recentlyPaid(9, 0, true)]);
    expect(html).toContain("tilePaidFromPhone");
    expect(html).toContain("tileNow");
  });

  it("al vencer los 3 minutos vuelve a su sitio y al verde claro de siempre", () => {
    const tiles = [free(1), recentlyPaid(9, 1, true), free(3)];
    // Mismos tiles del servidor, dos minutos y medio después (reloj del cliente).
    const html = render(tiles, { now: T0 + min(2.5) });
    expect(tileOrder(html)).toEqual([1, 3, 9]);
    expect(html).not.toContain("tilePaidFromPhone");
    expect(html).toContain("bg-ok/10");
    expect(html).toContain("tileMinutesAgo:3");
  });

  it("la que cobró el mesero nunca sube ni se resalta, aunque sea de hace un minuto", () => {
    const html = render([free(1), recentlyPaid(9, 1, false)]);
    expect(tileOrder(html)).toEqual([1, 9]);
    expect(html).not.toContain("tilePaidFromPhone");
    expect(html).toContain("bg-ok/10");
  });

  it("con el ajuste en 0 (apagado) se comporta como cualquier recién pagada", () => {
    const html = render([free(1), recentlyPaid(9, 1, true)], { minutes: 0 });
    expect(tileOrder(html)).toEqual([1, 9]);
    expect(html).not.toContain("tilePaidFromPhone");
  });

  it("respeta los minutos del comercio y el filtro «Recién pagadas» la incluye", () => {
    const html = render([free(1), recentlyPaid(9, 10, true)], { minutes: 15 });
    expect(tileOrder(html)).toEqual([9, 1]);
    expect(html).toContain("tilePaidFromPhone");
    expect(html).toContain("elapsedAgo:10");
  });

  it("una recién pagada de hace más de 15 minutos ya se dibuja libre sin esperar al servidor", () => {
    const html = render([recentlyPaid(9, 16, false)]);
    expect(html).toContain("tileFree");
    expect(html).not.toContain("bg-ok/10");
  });
});
