import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "sandbox" }));
vi.mock("@/lib/env", () => ({ requireKushkiKey: () => "unused" }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), kushkiFetch: mocked.fetch }));
import { KushkiHttpError } from "./client";
import { LiveKushkiProvider } from "./live";

beforeEach(() => vi.resetAllMocks());
describe("merchant wallet incoming balance", () => {
  it("keeps the available amount while representing unreported incoming funds as unknown", async () => {
    mocked.fetch.mockResolvedValue({ currentBalance: 1250.55, currency: "COP", balanceDate: 1675874081783 });
    expect(await new LiveKushkiProvider("production").getBalance("merchant-test-key")).toEqual({
      availableCents: 125055, currency: "COP", pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null,
    });
    expect(mocked.fetch).toHaveBeenCalledWith("/wallet/v1/merchant/balance", expect.objectContaining({ mode: "production", method: "GET", auth: { kind: "submerchant", privateKey: "merchant-test-key" } }));
  });
  it("does not infer no incoming payments from an empty available wallet", async () => {
    mocked.fetch.mockRejectedValueOnce(new KushkiHttpError(400, '{"code":"WLT400"}', "test"));
    expect(await new LiveKushkiProvider("sandbox").getBalance("merchant-test-key")).toEqual({
      availableCents: 0, currency: "COP", pendingCents: null, pendingStatus: "not_reported", pendingUpdatedAt: null,
    });
  });
  it("preserves provider failures instead of reporting zero balances", async () => {
    for (const error of [
      new KushkiHttpError(403, '{"code":"AUTH"}', "test"),
      new KushkiHttpError(403, '{"code":"WLT400"}', "test"),
      new KushkiHttpError(400, 'not a response: WLT400', "test"),
    ]) {
      mocked.fetch.mockRejectedValueOnce(error);
      await expect(new LiveKushkiProvider("production").getBalance("merchant-test-key")).rejects.toBe(error);
    }
  });
});
