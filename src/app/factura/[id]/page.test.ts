import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { getEmailTranslator } from "@/lib/emailIntl";
import { renderInvoiceEmail, type InvoiceSnapshot } from "@/lib/invoice";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), locale: "es" }));
vi.mock("@/lib/db", () => ({ db: { simpleInvoice: { findUnique: mocks.findUnique } } }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (await getEmailTranslator(mocks.locale, namespace)).t,
  getLocale: async () => mocks.locale,
}));
vi.mock("./PrintButton", () => ({ PrintButton: () => null }));
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
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue({
    invoiceNumber: 1, snapshot, order: { shortCode: "DEMO" }, dianDocument: null,
    restaurant: { enabledModules: [], dianConfig: null, legalEntity: null },
  });
});

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
