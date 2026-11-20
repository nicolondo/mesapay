import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import es from "../../../messages/es.json";
import en from "../../../messages/en.json";
import pt from "../../../messages/pt.json";
import type { CancelledItemView } from "@/lib/orders/cancelledItems";
import { CancelledItemsDisclosure } from "./CancelledItemsDisclosure";

const catalogs = { es, en, pt };

function render(child: ReactElement, locale: keyof typeof catalogs = "es") {
  // eslint-disable-next-line react/no-children-prop -- Required by the provider's props type.
  return renderToStaticMarkup(createElement(NextIntlClientProvider,
    { locale, timeZone: "America/Bogota", messages: catalogs[locale], children: child }));
}

const items: CancelledItemView[] = [
  {
    id: "a",
    name: "Limonada",
    qty: 1,
    amountCents: 1_000_000,
    cancelledAt: "2026-11-20T01:10:00.000Z",
    kind: "round",
    roundSeq: 2,
    reason: "Ingrediente faltante",
    actor: { type: "staff", name: "Cocina", email: "cocina@demo.test" },
  },
  {
    id: "b",
    name: "Lomito",
    qty: 2,
    amountCents: 6_400_000,
    cancelledAt: "2026-11-20T01:30:00.000Z",
    kind: "cancel",
    roundSeq: 1,
    reason: null,
    actor: { type: "email", email: "ex-mesero@demo.test" },
  },
  {
    id: "c",
    name: "Postre",
    qty: 1,
    amountCents: 1_500_000,
    cancelledAt: null,
    kind: "comp",
    roundSeq: 1,
    reason: "Cortesía",
    actor: { type: "unknown" },
  },
];

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("CancelledItemsDisclosure", () => {
  it("no pinta nada sin platos cancelados", () => {
    expect(render(createElement(CancelledItemsDisclosure, { items: [], currency: "COP" }))).toBe("");
  });

  it("es un desplegable cerrado con el conteo, la hora, quién y el motivo", () => {
    const html = render(createElement(CancelledItemsDisclosure, { items, currency: "COP" }));
    expect(html).toMatch(/^<details\b/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    const body = text(html);
    expect(body).toContain("Platos cancelados (3)");
    expect(body).toContain("Limonada");
    expect(body).toContain("Ronda 2 cancelada");
    expect(body).toContain("por Cocina");
    expect(body).toContain("Motivo: Ingrediente faltante");
    // 01:10 UTC = 8:10 p. m. en Bogotá, la zona del comercio.
    expect(html).toContain('dateTime="2026-11-20T01:10:00.000Z"');
    expect(body).toMatch(/8:10/);
    expect(body).toContain("por ex-mesero@demo.test");
    expect(body).toContain("No cobrado");
    expect(body).toContain("por el sistema (sin usuario registrado)");
    expect(body).toContain("hora sin registrar");
    expect(body).toContain(es.cancelledItems.notCounted);
    // El valor va tachado y no hay ningún total de lo cancelado.
    expect(html).toMatch(/line-through[^>]*>\$\s?64,000</);
    expect(body).not.toContain("95,000");
    expect(html.match(/data-testid="cancelled-item"/g)).toHaveLength(3);
  });

  it.each(["en", "pt"] as const)("está traducido en %s", (locale) => {
    const body = text(render(createElement(CancelledItemsDisclosure, { items, currency: "COP" }), locale));
    expect(body).toContain(catalogs[locale].cancelledItems.summary.replace("{count}", "3"));
    expect(body).toContain(catalogs[locale].cancelledItems.kindRound.replace("{seq}", "2"));
    expect(body).not.toContain("Platos cancelados");
  });
});
