import type {
  SubscriptionProvider,
  CreateSubscriptionReq,
  CreateSubscriptionResult,
  ChargeNowReq,
  ChargeNowResult,
  CardMeta,
} from "@/lib/payments/subscription";

const MOCK_CARD: CardMeta = { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };

/** Simula Kushki sin red. Cobro declinado determinístico: montos cuyos
 *  últimos 2 dígitos de pesos son "13" → declined (para probar dunning). */
export class MockSubscriptionProvider implements SubscriptionProvider {
  async createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult> {
    return { subscriptionId: `mock_sub_${req.planName}_${req.startDateIso}`, card: MOCK_CARD };
  }
  async chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult> {
    const declined = Math.floor(req.amountCents / 100) % 100 === 13;
    return declined
      ? { status: "declined", transactionId: null, message: "Tarjeta rechazada (mock)" }
      : { status: "approved", transactionId: `mock_tx_${req.subscriptionId}` };
  }
  async updateSubscriptionCard(): Promise<{ card: CardMeta }> {
    return { card: MOCK_CARD };
  }
  async cancelSubscription(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async getSubscription(_req: { subscriptionId: string }): Promise<{ status: string; card: CardMeta } | null> {
    return { status: "active", card: MOCK_CARD };
  }
}
