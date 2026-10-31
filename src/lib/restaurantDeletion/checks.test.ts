import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { fakeClient } from "@/test/fakeDeletionClient";
import { REPLACEABLE_PENDING_METHODS } from "@/lib/payments/methods";
import { findBlockers } from "./checks";

type Where = Record<string, unknown>;
const NOW = new Date("2026-10-31T12:00:00.000Z");

/**
 * Los cobros y links pendientes se separan según haya plata en vuelo. La
 * suma tiene que ser la de antes: separar no puede relajar el bloqueo.
 */
describe("findBlockers: solicitudes vs. plata en vuelo", () => {
  it("separa los cobros pendientes por método y no pierde ninguno", async () => {
    const pending = { cash: 1, external_terminal: 1, kushki_pse: 2, kushki_card_terminal: 1 } as Record<string, number>;
    const { client } = fakeClient({
      count: (model, args) => {
        const where = (args.where ?? {}) as Where;
        if (model !== "payment" || where.status !== "pending") return 0;
        const method = where.method as { in?: string[]; notIn?: string[] };
        return Object.entries(pending)
          .filter(([m]) => (method.in ? method.in.includes(m) : !method.notIn?.includes(m)))
          .reduce((sum, [, n]) => sum + n, 0);
      },
    });
    const blockers = await findBlockers(client as unknown as Prisma.TransactionClient, "dani", NOW);
    expect(blockers).toEqual([
      { code: "payments_pending", count: 2 },
      { code: "payments_in_flight", count: 3 },
    ]);
    expect([...REPLACEABLE_PENDING_METHODS].sort()).toEqual(["cash", "demo_cash", "external_terminal"]);
  });

  it("separa los links vigentes según tengan un PSE iniciado", async () => {
    const { client } = fakeClient({
      count: (model, args) => {
        const where = (args.where ?? {}) as Where;
        // (El barrido de referencias cruzadas también cuenta links: ése no lleva `status`.)
        if (model !== "paymentLink" || where.status !== "pending") return 0;
        expect(where).toMatchObject({ restaurantId: "dani" });
        return where.providerRef === null ? 2 : 1;
      },
    });
    const blockers = await findBlockers(client as unknown as Prisma.TransactionClient, "dani", NOW);
    expect(blockers).toEqual([
      { code: "payment_links_pending", count: 2 },
      { code: "payment_links_in_flight", count: 1 },
    ]);
  });
});
