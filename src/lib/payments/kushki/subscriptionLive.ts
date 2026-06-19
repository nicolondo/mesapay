import type {
  SubscriptionProvider,
  CreateSubscriptionReq,
  CreateSubscriptionResult,
  ChargeNowReq,
  ChargeNowResult,
  CardMeta,
} from "@/lib/payments/subscription";
import { env } from "@/lib/env";

const BASE =
  env.KUSHKI_MODE === "production"
    ? "https://api.kushkipagos.com"
    : "https://api-uat.kushkipagos.com";

function privateKey(): string {
  const k = env.KUSHKI_BILLING_PRIVATE_KEY;
  if (!k) throw new Error("billing_not_configured: falta KUSHKI_BILLING_PRIVATE_KEY");
  return k;
}

/** Kushki One-click & scheduled payments con la cuenta de PLATAFORMA.
 *  Endpoints (confirmar contra doc/partner al activar producción):
 *   POST   /subscriptions/v1/card                 → crear (Private-Merchant-Id)
 *   POST   /subscriptions/v1/card/{id} (charge)   → cobro one-click
 *   PATCH  /subscriptions/v1/card/{id}            → cambiar tarjeta
 *   DELETE /subscriptions/v1/card/{id}            → cancelar
 *   GET    /subscriptions/v1/card/search/{id}     → consultar */
// TODO(fase 3, ir a producción): rutear por kushkiFetch (./client.ts) para retries/errores tipados y tomar el modo (mock|sandbox|production) por constructor como LiveKushkiProvider, en vez de fetch crudo + process.env.KUSHKI_MODE. Las formas de respuesta (cardFrom, approved/declined) están sin verificar contra Kushki real.
export class LiveSubscriptionProvider implements SubscriptionProvider {
  private async req(path: string, method: string, body?: unknown) {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", "Private-Merchant-Id": privateKey() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`kushki_subscription_error:${r.status}:${JSON.stringify(json)}`);
    return json as Record<string, unknown>;
  }

  async createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult> {
    const resp = await this.req("/subscriptions/v1/card", "POST", {
      token: req.token,
      planName: req.planName,
      periodicity: "monthly",
      startDate: req.startDateIso,
      contactDetails: req.contactDetails,
      amount: {
        currency: req.currency,
        subtotalIva0: req.amountCents / 100,
        subtotalIva: 0,
        iva: 0,
        ice: 0,
      },
      metadata: req.metadata ?? {},
    });
    return {
      subscriptionId: String(resp.subscriptionId ?? ""),
      card: cardFrom(resp),
    };
  }

  async chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult> {
    const resp = await this.req(`/subscriptions/v1/card/${req.subscriptionId}`, "POST", {
      amount: {
        currency: req.currency,
        subtotalIva0: req.amountCents / 100,
        subtotalIva: 0,
        iva: 0,
        ice: 0,
      },
      metadata: req.metadata ?? {},
    });
    const ticket = resp.ticketNumber ?? resp.transactionReference;
    return ticket
      ? { status: "approved", transactionId: String(ticket) }
      : { status: "declined", transactionId: null };
  }

  async updateSubscriptionCard(req: {
    subscriptionId: string;
    token: string;
  }): Promise<{ card: CardMeta }> {
    const resp = await this.req(`/subscriptions/v1/card/${req.subscriptionId}`, "PATCH", {
      token: req.token,
    });
    return { card: cardFrom(resp) };
  }

  async cancelSubscription(req: { subscriptionId: string }): Promise<{ ok: boolean }> {
    await this.req(`/subscriptions/v1/card/${req.subscriptionId}`, "DELETE");
    return { ok: true };
  }

  async getSubscription(req: {
    subscriptionId: string;
  }): Promise<{ status: string; card: CardMeta } | null> {
    const resp = await this.req(`/subscriptions/v1/card/search/${req.subscriptionId}`, "GET");
    return { status: String(resp.status ?? "active"), card: cardFrom(resp) };
  }
}

function cardFrom(resp: Record<string, unknown>): CardMeta {
  const c = (resp.card ?? {}) as Record<string, unknown>;
  return {
    brand: (c.brand as string) ?? null,
    last4: (c.lastFourDigits as string) ?? null,
    expMonth: c.expiryMonth ? Number(c.expiryMonth) : null,
    expYear: c.expiryYear ? Number(c.expiryYear) : null,
  };
}
