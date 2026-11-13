import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import es from "../../../../messages/es.json";
import en from "../../../../messages/en.json";
import pt from "../../../../messages/pt.json";
import { FreeLineLimitNotice } from "./FreeLineLimitNotice";
import { maxFreeLineCents } from "@/lib/freeLineLimit";

/**
 * El diálogo «Agregar cargo o servicio» apagaba «Agregar a la cuenta» sin
 * decir por qué cuando el valor pasaba el tope. Ahora, debajo del precio,
 * sale el máximo de ESA cuenta y qué hacer para cobrar más.
 */
function render(child: ReactElement, messages: typeof es = es, locale = "es") {
  // eslint-disable-next-line react/no-children-prop -- Required by the provider's props type.
  return renderToStaticMarkup(createElement(NextIntlClientProvider,
    { locale, timeZone: "America/Bogota", messages, children: child }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, "");

const EMPTY = { subtotalCents: 0, taxCents: 0, tipCents: 0 };
const maxIncluded = maxFreeLineCents(EMPTY, { taxKind: null, taxPct: null });

describe("FreeLineLimitNotice — el máximo de la cuenta, a la vista", () => {
  it("no muestra nada si el valor cabe (el cargo de $12.219.480 en una cuenta vacía)", () => {
    const html = render(createElement(FreeLineLimitNotice, {
      lineCents: 1_221_948_000, maxLineCents: maxIncluded, qty: 1,
    }));
    expect(html).toBe("");
  });

  it("si se pasa, dice el máximo en pesos enteros y qué hacer", () => {
    const html = render(createElement(FreeLineLimitNotice, {
      lineCents: 1_900_000_000, maxLineCents: maxIncluded, qty: 1,
    }));
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("El máximo para esta cuenta es $15.384.615.");
    expect(text(html)).toContain(es.opTables.freeLineMaxSplitHint);
  });

  it("con cantidad > 1 aclara que el máximo es del total (cantidad × precio)", () => {
    const html = render(createElement(FreeLineLimitNotice, {
      lineCents: 2 * 800_000_000, maxLineCents: 1_000_000_000, qty: 2,
    }));
    expect(text(html)).toContain("El máximo para esta cuenta es $10.000.000 en total (cantidad × precio).");
  });

  it.each([["en", en], ["pt", pt]] as const)("está traducido (%s)", (locale, messages) => {
    const html = render(createElement(FreeLineLimitNotice, {
      lineCents: 1_900_000_000, maxLineCents: maxIncluded, qty: 1,
    }), messages as unknown as typeof es, locale);
    expect(text(html)).toContain("$15.384.615");
    expect(text(html)).toContain(messages.opTables.freeLineMaxSplitHint);
    expect(text(html)).not.toContain("El máximo");
  });
});
