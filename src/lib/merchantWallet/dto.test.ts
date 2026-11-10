import { expect, it } from "vitest";
import type { Payout } from "@prisma/client";
import { merchantPayoutDTO } from "./dto";
it("does not expose legacy provider text, account fingerprint or callback secrets", () => {
  const dto = merchantPayoutDTO({ id: "p1", amountCents: 100, currency: "COP", status: "approved", providerRef: "ref", idempotencyKey: null, responseText: "private provider text", webhookSecretEnc: "secret" } as Payout);
  expect(dto.responseText).toBeNull(); expect(JSON.stringify(dto)).not.toContain("private provider text"); expect(JSON.stringify(dto)).not.toContain("secret");
});
