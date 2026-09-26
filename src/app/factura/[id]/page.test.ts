import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { getEmailTranslator } from "@/lib/emailIntl";
import { renderInvoiceEmail, type InvoiceSnapshot } from "@/lib/invoice";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  locale: "es",
  session: null as null | { user: { id: string; role: string } },
  activeRestaurantId: null as string | null,
  printButtonProps: null as null | Record<string, unknown>,
}));
vi.mock("@/lib/db", () => ({ db: { simpleInvoice: { findUnique: mocks.findUnique } } }));
vi.mock("@/auth", () => ({ auth: async () => mocks.session }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => mocks.activeRestaurantId,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (await getEmailTranslator(mocks.locale, namespace)).t,
  getLocale: async () => mocks.locale,
}));
vi.mock("./PrintButton", () => ({
  PrintButton: (props: Record<string, unknown>) => {
    mocks.printButtonProps = props;
    return null;
  },
}));
import FacturaPage from "./page";

const snapshot: InvoiceSnapshot = {
  restaurantName: "RESTAURANTE DE MUESTRA", logoUrl: null,
  legalName: "RESTAURANTE DE MUESTRA SAS", taxId: "900000001", legalAddress: "Calle de muestra 123",
  legalCity: "Medellín", legalPhone: null, dianResolution: null,
  dianResolutionFrom: null, dianResolutionTo: null, dianResolutionDate: null,
  invoicePrefix: "MUESTRA", shortCode: "DEMO", tableLabel: "Mesa 1",
  paidAtIso: "2026-09-10T18:00:00.000Z",
  items: [{ qty: 1, name: "Plato de muestra", priceCents: 2_500_000 }],
  subtotalCents: 2_500_000, tipCents: 0, totalCents: 2_500_000,
};

beforeEach(() => {
  mocks.locale = "es";
  mocks.session = null;
  mocks.activeRestaurantId = null;
  mocks.printButtonProps = null;
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue({
    id: "inv-1", restaurantId: "rest-1", orderId: "order-1",
    invoiceNumber: 1, snapshot, order: { shortCode: "DEMO" }, dianDocument: null,
    restaurant: { enabledModules: [], dianConfig: null, legalEntity: null },
  });
});

async function render() {
  const page = await FacturaPage({ params: Promise.resolve({ id: "inv-1" }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(page);
}

describe("factura web — advertencia de propina", () => {
  it.each(["es", "en", "pt"])("incluye el aviso completo en %s aunque no haya propina ni documento DIAN", async (locale) => {
    mocks.locale = locale;
    const page = await FacturaPage({ params: Promise.resolve({ id: "preview-only" }), searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);
    const { t } = await getEmailTranslator(locale, "emailInvoice");
    const title = t("tipNoticeTitle");
    const body = t("tipNoticeBody");
    expect(title).not.toContain("tipNoticeTitle");
    expect(body).not.toContain("tipNoticeBody");
    expect(html).toContain(title);
    expect(html).toContain(body);
    expect(html.replace(/<[^>]*>/g, "").split(title)).toHaveLength(2);
    if (process.env.TIP_NOTICE_PREVIEW === "1" && locale === "es") {
      writeFileSync("/tmp/mesapay-tip-preview.html", '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body>' + html + "</body></html>");
      const email = await renderInvoiceEmail({ snapshot, invoiceNumber: 1, invoiceUrl: "https://example.invalid/factura/muestra", locale });
      writeFileSync("/tmp/mesapay-tip-email-preview.html", email.html);
    }
  });
});

describe("factura web — impresión por el agente sólo para el staff", () => {
  it("el comensal (sin sesión) imprime la página y nada más: sin agente", async () => {
    await render();
    expect(mocks.printButtonProps?.agent).toBeNull();
  });

  it.each(["operator", "mesero"])("el %s del comercio imprime por el agente (factura de esa cuenta)", async (role) => {
    mocks.session = { user: { id: "u", role } };
    mocks.activeRestaurantId = "rest-1";
    await render();
    expect(mocks.printButtonProps?.agent).toEqual({
      kind: "invoice",
      orderId: "order-1",
      href: "/factura/inv-1",
    });
  });

  it("staff de OTRO comercio, o un rol que no cobra: sin agente", async () => {
    mocks.session = { user: { id: "u", role: "operator" } };
    mocks.activeRestaurantId = "rest-vecino";
    await render();
    expect(mocks.printButtonProps?.agent).toBeNull();
    mocks.session = { user: { id: "u", role: "kitchen" } };
    mocks.activeRestaurantId = "rest-1";
    await render();
    expect(mocks.printButtonProps?.agent).toBeNull();
  });
});

describe("factura web — formato compacto", () => {
  const conModificadores: InvoiceSnapshot = {
    ...snapshot,
    items: [
      {
        qty: 1,
        name: "Hamburguesa Melona",
        priceCents: 3_600_000,
        modifiers: ["Término: 1/2", "Guarniciones: Ensalada fresca"],
        notes: "sin cebolla",
      },
    ],
  };

  it("modificadores y nota en UN renglón, separados por ' · ', sin guiones", async () => {
    mocks.findUnique.mockResolvedValue({
      ...(await mocks.findUnique()),
      snapshot: conModificadores,
    });
    const html = await render();
    expect(html).toContain(
      '<div class="idetail">Término: 1/2 · Guarniciones: Ensalada fresca · &quot;sin cebolla&quot;</div>',
    );
    expect(html).not.toContain("- Término");
  });

  it("el precio va ANTES del nombre en el HTML (flota a la derecha del primer renglón)", async () => {
    const html = await render();
    const amount = html.indexOf('class="amount"');
    const name = html.indexOf("Plato de muestra");
    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThan(name);
  });

  it("declara el ancho del papel del comercio para la página de impresión (80 por defecto, 58 si es de 58)", async () => {
    expect(await render()).toContain('data-print-width-mm="80"');
    const row = await mocks.findUnique();
    mocks.findUnique.mockResolvedValue({
      ...row,
      restaurant: { ...row.restaurant, printPaperWidthMm: 58 },
    });
    const html = await render();
    expect(html).toContain('data-print-width-mm="58"');
    expect(html).toContain("width:58mm");
  });

  it("NIT, dirección y ciudad en un solo párrafo; rótulo, y número y fecha en la misma fila", async () => {
    const html = await render();
    expect(html).toContain('<div class="meta">NIT 900000001 · Calle de muestra 123 · Medellín</div>');
    const text = html.replace(/<[^>]*>/g, "|");
    // El rótulo solo; debajo, número y fecha en la MISMA fila.
    expect(text).toMatch(/Comprobante\|+MUESTRA1\|+10\/09\/26/);
  });

  it("factura electrónica aceptada: rótulo legal arriba, consumidor final, QR, CUFE y representación impresa", async () => {
    const row = await mocks.findUnique();
    mocks.findUnique.mockResolvedValue({
      ...row,
      dianDocument: { state: "accepted", cufe: "abc123" },
      restaurant: { ...row.restaurant, enabledModules: ["einvoicing"] },
    });
    const html = await render();
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Factura electrónica de venta MUESTRA1 ");
    expect(text).toContain("Cliente: Consumidor final");
    expect(html).toContain('class="dian-qr"');
    expect(text).toContain("CUFE: abc123");
    expect(text).toContain("Representación impresa de la factura electrónica de venta");
  });
});
