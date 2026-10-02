import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: m.context, isDenied: (ctx: object) => "error" in ctx }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));
vi.mock("./CreditNotesClient", () => ({ CreditNotesClient: () => null }));
import Page from "./page";
beforeEach(() => vi.resetAllMocks());
describe("credit note page access", () => {
  it.each([401, 403, 400])("denies a failed ERP gate (%s)", async status => {
    m.context.mockResolvedValue({ error: "denied", status });
    await expect(Page()).rejects.toThrow("notFound");
    expect(m.context).toHaveBeenCalledWith(["einvoicing"]);
  });
  it("renders only after the scoped admin/module gate succeeds", async () => {
    m.context.mockResolvedValue({ restaurantId: "r", country: "CO", userId: "u" });
    expect(await Page()).toBeTruthy();
    expect(m.context).toHaveBeenCalledWith(["einvoicing"]);
  });
});
