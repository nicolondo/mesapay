import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const m = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: m.context, isDenied: (ctx: object) => "error" in ctx }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));
vi.mock("./CreditNotesClient", () => ({ CreditNotesClient: () => null }));
import Page from "./page";
import { creditNotePreselectHref, preselectedInvoiceId } from "@/lib/dian/creditNoteLink";
const noParams = () => ({ searchParams: Promise.resolve({}) });
beforeEach(() => vi.resetAllMocks());
describe("credit note page access", () => {
  it.each([401, 403, 400])("denies a failed ERP gate (%s)", async status => {
    m.context.mockResolvedValue({ error: "denied", status });
    await expect(Page(noParams())).rejects.toThrow("notFound");
    expect(m.context).toHaveBeenCalledWith(["einvoicing"]);
  });
  it("renders only after the scoped admin/module gate succeeds", async () => {
    m.context.mockResolvedValue({ restaurantId: "r", country: "CO", userId: "u" });
    expect(await Page(noParams())).toBeTruthy();
    expect(m.context).toHaveBeenCalledWith(["einvoicing"]);
  });
});

describe("preselección de la factura (Anular con nota crédito desde Facturas)", () => {
  beforeEach(() => m.context.mockResolvedValue({ restaurantId: "r", country: "CO", userId: "u" }));

  it("el enlace de Facturas y la página hablan el mismo parámetro", async () => {
    const href = creditNotePreselectHref("cm9invoice00001");
    expect(href).toBe("/operator/facturas/notas-credito?factura=cm9invoice00001");
    const query = Object.fromEntries(new URL(href, "https://x.test").searchParams);
    const el = (await Page({ searchParams: Promise.resolve(query) })) as ReactElement<{ initialInvoiceId: string | null }>;
    expect(el.props.initialInvoiceId).toBe("cm9invoice00001");
  });

  it("sin parámetro abre como siempre, sin factura elegida", async () => {
    const el = (await Page(noParams())) as ReactElement<{ initialInvoiceId: string | null }>;
    expect(el.props.initialInvoiceId).toBeNull();
  });

  it("un valor que no tiene forma de id se ignora (no viaja a la API)", () => {
    expect(preselectedInvoiceId({ factura: "../../x" })).toBeNull();
    expect(preselectedInvoiceId({ factura: "a b" })).toBeNull();
    expect(preselectedInvoiceId({ factura: "" })).toBeNull();
    expect(preselectedInvoiceId({ factura: "x".repeat(65) })).toBeNull();
    expect(preselectedInvoiceId({ factura: ["inv_1", "inv_2"] })).toBe("inv_1");
    expect(preselectedInvoiceId({ factura: " inv-1 " })).toBe("inv-1");
  });
});
