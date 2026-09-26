import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import es from "../../../../../../../messages/es.json";

/**
 * "Imprimir factura" en la pantalla de "listo": el STAFF imprime por el
 * agente (un botón que encola); el COMENSAL abre la vista para imprimir en
 * su propio equipo y NUNCA encola nada en el local. Lo decide `staffPrint`,
 * que el server arma desde la sesión — no `operatorMode`, que es sólo el
 * tono del texto.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const staffButton = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("@/components/print/StaffPrintButton", () => ({
  StaffPrintButton: (props: Record<string, unknown>) => {
    staffButton.props = props;
    return createElement("button", { "data-staff-print": "1" }, String(props.label));
  },
}));

import { InvoiceRequestPanel } from "./InvoiceRequestPanel";

const base = {
  tenantSlug: "sonymelona",
  orderId: "order-1",
  existing: null,
  // Pidieron la genérica sin correo y la factura ya existe.
  simpleRequestEmail: "",
  issuedInvoiceUrl: "https://mesapay.co/factura/inv-1",
  orderPaid: true,
};

function render(props: Record<string, unknown>) {
  const intl = {
    locale: "es",
    timeZone: "America/Bogota",
    messages: es,
  } as unknown as ComponentProps<typeof NextIntlClientProvider>;
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      intl,
      createElement(InvoiceRequestPanel, { ...base, ...props } as never),
    ),
  );
}

beforeEach(() => {
  staffButton.props = null;
});

describe("pantalla de 'listo' — quién imprime por el agente", () => {
  it("el COMENSAL ve el link a la vista para imprimir en su equipo: ningún botón que encole", () => {
    const html = render({});
    expect(html).toContain('href="https://mesapay.co/factura/inv-1?print=1"');
    expect(html).not.toContain("data-staff-print");
    expect(staffButton.props).toBeNull();
  });

  it("aunque la URL diga op=1 (operatorMode), sin staffPrint del server sigue siendo el link", () => {
    const html = render({ operatorMode: true });
    expect(html).not.toContain("data-staff-print");
    expect(html).toContain("?print=1");
  });

  it("el STAFF imprime por el agente: la factura de esa cuenta, con la vista como ruta de este origen", () => {
    const html = render({ operatorMode: true, staffPrint: { canConfigurePrinters: false } });
    expect(html).toContain("data-staff-print");
    expect(html).not.toContain("?print=1");
    expect(staffButton.props).toMatchObject({
      doc: { kind: "invoice", orderId: "order-1", href: "/factura/inv-1" },
      label: "Imprimir factura",
      canConfigurePrinters: false,
    });
  });
});
