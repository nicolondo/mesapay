import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import es from "../../../messages/es.json";

/**
 * «Recordar mis datos» compacta. El dueño: «quiero que sea desplegable, no
 * que aparezca todo completo ocupando espacio, y que por defecto esté
 * activo». Acá (render estático, sin DOM): la casilla sale MARCADA, el
 * desplegable sale CERRADO (aria-expanded=false y la región `hidden`), y
 * abierto muestra el resumen con el enlace a la política. El abrir/cerrar
 * con clic y con teclado en un navegador real está en
 * e2e/invoice-remember-consent.spec.ts.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { RememberConsent, SavedDataDisclosure } from "./RememberConsent";
import { InvoiceFormSheet } from "./InvoiceFormSheet";

function render(node: ReturnType<typeof createElement>) {
  const intl = { locale: "es", timeZone: "America/Bogota", messages: es } as unknown as ComponentProps<typeof NextIntlClientProvider>;
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl, node));
}

/** El atributo de un elemento por su etiqueta y un fragmento que lo identifica. */
function tag(html: string, startsWith: string): string {
  const i = html.indexOf(startsWith);
  expect(i, startsWith).toBeGreaterThanOrEqual(0);
  return html.slice(i, html.indexOf(">", i) + 1);
}

describe("RememberConsent", () => {
  it("cerrado por defecto: sólo la fila de la casilla y el control; el resumen no ocupa espacio", () => {
    const html = render(createElement(RememberConsent, { checked: true, onCheckedChange: () => {}, restaurantName: "Casa de prueba" }));
    expect(html).toContain("Recordar mis datos para mis próximas facturas en Casa de prueba");
    const button = tag(html, "<button");
    expect(button).toContain('aria-expanded="false"');
    expect(html).toContain("¿Qué guardamos?");
    // La región existe (aria-controls apunta a ella) pero va oculta.
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
    expect(controls).toBeTruthy();
    const region = tag(html, `<div id="${controls}"`);
    expect(region).toContain("hidden");
    expect(tag(html, '<input')).toContain("checked");
  });

  it("abierto muestra qué se guarda, que se ve enmascarado, que se puede desmarcar y la política", () => {
    const html = render(createElement(RememberConsent, { checked: true, onCheckedChange: () => {}, defaultOpen: true }));
    const button = tag(html, "<button");
    expect(button).toContain('aria-expanded="true"');
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
    expect(tag(html, `<div id="${controls}"`)).not.toContain("hidden");
    expect(html).toContain("solo verás una parte de tus datos");
    expect(html).toContain("Si desmarcas la casilla, la factura sale igual");
    expect(html).toMatch(/<a href="\/privacidad" target="_blank"[^>]*>Política de privacidad<\/a>/);
    // Sin nombre del comercio, el texto genérico.
    expect(html).toContain("Recordar mis datos para mis próximas facturas en este comercio");
  });

  it("el personal lo ve en tercera persona", () => {
    const html = render(createElement(RememberConsent, { checked: true, onCheckedChange: () => {}, operatorMode: true, defaultOpen: true }));
    expect(html).toContain("Guardar los datos del cliente para sus próximas facturas");
    expect(html).toContain("¿Qué se guarda?");
    expect(html).toContain("Pídele autorización al cliente");
  });

  it("desmarcada se pinta desmarcada (el estado lo manda el formulario)", () => {
    const html = render(createElement(RememberConsent, { checked: false, onCheckedChange: () => {} }));
    expect(tag(html, "<input")).not.toContain("checked");
  });
});

describe("SavedDataDisclosure (datos enmascarados)", () => {
  it("cerrado por defecto y, abierto, explica el enmascarado con la política", () => {
    const closed = render(createElement(SavedDataDisclosure));
    expect(tag(closed, "<button")).toContain('aria-expanded="false"');
    const open = render(createElement(SavedDataDisclosure, { defaultOpen: true }));
    expect(tag(open, "<button")).toContain('aria-expanded="true"');
    expect(open).toContain("solo te mostramos una parte de tus datos");
    expect(open).toContain('href="/privacidad"');
  });
});

describe("InvoiceFormSheet: la casilla viene MARCADA y el desplegable CERRADO", () => {
  const initial = { status: "pending" as const, customerName: "Ana Prueba", docType: "CC" as const, docNumber: "1020304050", email: "ana@prueba.test" };

  it.each([false, true])("operatorMode=%s", (operatorMode) => {
    const html = render(
      createElement(InvoiceFormSheet, { tenantSlug: "casa", orderId: "order-1", initial, operatorMode, onClose: () => {} }),
    );
    // Con una solicitud previa abre directo el formulario.
    expect(html).toContain("Ana Prueba");
    const checkbox = /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? "";
    expect(checkbox).toContain("checked");
    const toggle = /<button[^>]*aria-expanded="(true|false)"[^>]*>/.exec(html);
    expect(toggle?.[1]).toBe("false");
    // Ningún párrafo explicativo largo a la vista: el resumen va plegado.
    expect(html).not.toContain("Tus datos solo se comparten con el restaurante");
  });
});
