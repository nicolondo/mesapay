import { subscribeMockWebhook } from "./kushki/mock";
import { processKushkiWebhook } from "./webhookHandler";
import { randomUUID } from "crypto";

/**
 * In mock mode the Kushki "webhook" never reaches our HTTP endpoint because
 * there's no real Kushki. Instead, the mock provider emits events to an
 * in-process bus. This bridge subscribes to that bus and feeds the same
 * shared processor the real webhook route uses.
 *
 * The bridge is installed lazily — first call to ensureMockBridge(). NO lo
 * gateamos por el modo GLOBAL: ahora el modo es por-comercio, así que un
 * comercio en "mock" puede convivir con un global "sandbox". El listener es
 * ocioso salvo que el MockKushkiProvider emita —y eso sólo ocurre cuando se
 * resolvió mock para ese comercio—, así que instalarlo siempre es inocuo.
 */

let installed = false;

export function ensureMockBridge(): void {
  if (installed) return;
  installed = true;
  subscribeMockWebhook((e) => {
    if (
      e.type === "terminal.approved" ||
      e.type === "terminal.declined" ||
      e.type === "pse.approved" ||
      e.type === "pse.declined"
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
