import { subscribeMockWebhook } from "./kushki/mock";
import { processKushkiWebhook } from "./webhookHandler";
import { randomUUID } from "crypto";
import { getKushkiModeSync } from "../platformConfig";

/**
 * In mock mode the Kushki "webhook" never reaches our HTTP endpoint because
 * there's no real Kushki. Instead, the mock provider emits events to an
 * in-process bus. This bridge subscribes to that bus and feeds the same
 * shared processor the real webhook route uses.
 *
 * The bridge is installed lazily — first call to ensureMockBridge() — so we
 * don't spin up listeners in production processes.
 */

let installed = false;

export function ensureMockBridge(): void {
  if (installed) return;
  if (getKushkiModeSync() !== "mock") return;
  installed = true;
  subscribeMockWebhook((e) => {
    if (
      e.type === "terminal.approved" ||
      e.type === "terminal.declined"
    ) {
      void processKushkiWebhook({
        eventId: `mock-${randomUUID()}`,
        type: e.type,
        paymentId: e.paymentId,
        orderId: e.orderId,
        providerRef: e.providerRef,
        amountCents: e.amountCents,
        raw: e,
      });
    } else if (e.type === "merchant.activated") {
      void processKushkiWebhook({
        eventId: `mock-${randomUUID()}`,
        type: "merchant.activated",
        restaurantId: e.merchantId,
        raw: e,
      });
    }
  });
}
