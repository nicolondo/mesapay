import { subscribeMockWebhook } from "./kushki/mock";
import { processKushkiWebhook } from "./webhookHandler";
import { settleTerminalApproval } from "./terminalApproval";
import { db } from "@/lib/db";
import { randomUUID } from "crypto";

/**
 * El datáfono simulado autorizó otro monto (KUSHKI_MOCK_TERMINAL_AUTHORIZED):
 * mismo camino que un aprobado real del Cloud Terminal (propina, parcial o
 * conciliar), para verlo en local sin Kushki.
 */
async function settleMockTerminalApproval(e: { paymentId: string; providerRef: string; amountCents: number; authorizedCents: number }) {
  try {
    const payment = await db.payment.findUnique({ where: { id: e.paymentId }, include: { order: { select: { restaurantId: true } } } });
    if (!payment) return;
    await settleTerminalApproval({
      restaurantId: payment.order.restaurantId,
      paymentId: e.paymentId,
      expectedCents: e.amountCents,
      providerRef: e.providerRef,
      authorizedCents: e.authorizedCents,
      approvalCode: "MOCK01",
      confirmed: true,
      source: "mock",
      eventId: `mock-${randomUUID()}`,
      raw: e,
    });
  } catch (err) {
    console.warn("[mock-bridge] no se pudo liquidar el aprobado simulado", err);
  }
}

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
    if (e.type === "terminal.approved" && e.authorizedCents !== undefined) {
      void settleMockTerminalApproval({ ...e, authorizedCents: e.authorizedCents });
    } else if (
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
