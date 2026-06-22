import type {
  SubscriptionProvider,
  CreateSubscriptionReq,
  CreateSubscriptionResult,
  ChargeNowReq,
  ChargeNowResult,
  CardMeta,
} from "@/lib/payments/subscription";
import { kushkiFetch } from "@/lib/payments/kushki/client";
import { getBillingCredentials, type KushkiMode } from "@/lib/platformConfig";

/**
 * Kushki One-click & scheduled payments con la cuenta de PLATAFORMA.
 *
 * Endpoints usados (base: api-uat.kushkipagos.com o api.kushkipagos.com):
 *   POST   /subscriptions/v1/card               → crear suscripción    // VERIFY vs sandbox
 *   POST   /subscriptions/v1/card/{id}          → cobro on-demand      // VERIFY vs sandbox: puede ser /subscriptions/v1/card/{id}/charge
 *   PUT    /subscriptions/v1/card/{id}          → cambiar tarjeta      // VERIFY vs sandbox: puede ser PATCH
 *   DELETE /subscriptions/v1/card/{id}          → cancelar             // VERIFY vs sandbox
 *   GET    /subscriptions/v1/card/search/{id}   → consultar            // VERIFY vs sandbox
 *
 * Auth: Private-Merchant-Id con KUSHKI_BILLING_PRIVATE_KEY (via kushkiFetch billing).
 * PCI: el PAN nunca llega aquí; solo el token generado por el browser.
 */
export class LiveSubscriptionProvider implements SubscriptionProvider {
  private readonly mode: KushkiMode | undefined;

  constructor(mode?: KushkiMode) {
    this.mode = mode;
  }

  /**
   * Resuelve la clave privada de cobro (DB-first con fallback a env).
   * Lanza si no está configurada — mejor fallar explícito que hacer un
   * cobro sin credenciales.
   */
  private async resolveBillingPrivateKey(): Promise<string> {
    const { privateKey } = await getBillingCredentials();
    if (!privateKey) {
      throw new Error(
        "billing_not_configured: falta la clave privada de cobro (configurala en /admin/configuracion)",
      );
    }
    return privateKey;
  }

  async createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult> {
    const body = {
      token: req.token,
      planName: req.planName,
      periodicity: "monthly",
      startDate: req.startDateIso, // YYYY-MM-DD futuro (no mismo día)
      contactDetails: req.contactDetails,
      // Mismo shape que el cobro de comensales que YA funciona con COP
      // (live.ts chargeWithToken): sin `ice` (campo de Ecuador) que puede
      // hacer que Kushki asuma contexto USD y rechace COP con K055.
      amount: {
        currency: req.currency,
        subtotalIva0: req.amountCents / 100,
        subtotalIva: 0,
        iva: 0,
      },
      metadata: req.metadata ?? {},
    };
    console.log("[billing] createCardSubscription req shape", {
      planName: req.planName,
      amountCents: req.amountCents,
      currency: req.currency,
      startDateIso: req.startDateIso,
      hasToken: !!req.token,
      contactEmail: req.contactDetails.email,
    });

    // VERIFY vs sandbox: confirmar que POST /subscriptions/v1/card acepta este body.
    const billingKey = await this.resolveBillingPrivateKey();
    const resp = await kushkiFetch<Record<string, unknown>>(
      "/subscriptions/v1/card",
      { method: "POST", auth: { kind: "billing", privateKey: billingKey }, mode: this.mode, body },
    );
    console.log("[billing] createCardSubscription resp shape", {
      subscriptionId: resp.subscriptionId,
      hasCard: !!(resp.card),
    });

    return {
      subscriptionId: String(resp.subscriptionId ?? ""),
      card: cardFrom(resp),
    };
  }

  async chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult> {
    const body = {
      // Sin `ice` (Ecuador) — alineado con el cobro de comensales que
      // funciona con COP.
      amount: {
        currency: req.currency,
        subtotalIva0: req.amountCents / 100,
        subtotalIva: 0,
        iva: 0,
      },
      metadata: req.metadata ?? {},
    };
    console.log("[billing] chargeSubscriptionNow req shape", {
      subscriptionId: req.subscriptionId,
      amountCents: req.amountCents,
      currency: req.currency,
    });

    // VERIFY vs sandbox: confirmar el path de cobro on-demand.
    // Puede ser /subscriptions/v1/card/{id}/charge en vez de /subscriptions/v1/card/{id} (POST distinto al de crear)
    // El body de arriba es best-guess.
    const billingKey = await this.resolveBillingPrivateKey();
    const resp = await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/${req.subscriptionId}`,
      { method: "POST", auth: { kind: "billing", privateKey: billingKey }, mode: this.mode, body },
    );

    // VERIFY vs sandbox: confirmar qué campo indica aprobación.
    // Intentamos ticketNumber, transactionReference, transactionId.
    const ticket =
      (resp.ticketNumber ?? resp.transactionReference ?? resp.transactionId) as string | undefined;
    const approved = ticket != null;
    console.log("[billing] chargeSubscriptionNow resp shape", {
      hasTicket: approved,
      ticket,
      status: resp.ticketStatus ?? resp.status,
    });

    return approved
      ? { status: "approved", transactionId: String(ticket) }
      : { status: "declined", transactionId: null, message: String(resp.message ?? resp.text ?? "declined") };
  }

  async updateSubscriptionCard(req: { subscriptionId: string; token: string }): Promise<{ card: CardMeta }> {
    console.log("[billing] updateSubscriptionCard req shape", {
      subscriptionId: req.subscriptionId,
      hasToken: !!req.token,
    });

    // VERIFY vs sandbox: confirmar que PUT /subscriptions/v1/card/{id} acepta { token }.
    // Puede ser PATCH en vez de PUT.
    const billingKey = await this.resolveBillingPrivateKey();
    const resp = await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/${req.subscriptionId}`,
      { method: "PUT", auth: { kind: "billing", privateKey: billingKey }, mode: this.mode, body: { token: req.token } },
    );
    console.log("[billing] updateSubscriptionCard resp shape", { hasCard: !!(resp.card) });
    return { card: cardFrom(resp) };
  }

  async cancelSubscription(req: { subscriptionId: string }): Promise<{ ok: boolean }> {
    console.log("[billing] cancelSubscription req shape", {
      subscriptionId: req.subscriptionId,
    });

    // VERIFY vs sandbox: confirmar que DELETE /subscriptions/v1/card/{id} cancela.
    const billingKey = await this.resolveBillingPrivateKey();
    await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/${req.subscriptionId}`,
      { method: "DELETE", auth: { kind: "billing", privateKey: billingKey }, mode: this.mode },
    );
    console.log("[billing] cancelSubscription ok");
    return { ok: true };
  }

  async getSubscription(req: { subscriptionId: string }): Promise<{ status: string; card: CardMeta } | null> {
    console.log("[billing] getSubscription req shape", {
      subscriptionId: req.subscriptionId,
    });

    // VERIFY vs sandbox: confirmar path GET /subscriptions/v1/card/search/{id}.
    const billingKey = await this.resolveBillingPrivateKey();
    const resp = await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/search/${req.subscriptionId}`,
      { method: "GET", auth: { kind: "billing", privateKey: billingKey }, mode: this.mode },
    );
    console.log("[billing] getSubscription resp shape", {
      status: resp.status ?? resp.subscriptionStatus,
      hasCard: !!(resp.card),
    });
    return { status: String(resp.status ?? resp.subscriptionStatus ?? "active"), card: cardFrom(resp) };
  }
}

/**
 * Extrae metadatos de tarjeta del response de Kushki.
 * Tolerante a variantes de nombres de campo (cardBrand, brand, lastFourDigits, last4, etc.).
 * VERIFY vs sandbox: confirmar los nombres exactos en las respuestas reales.
 */
function cardFrom(resp: Record<string, unknown>): CardMeta {
  const c = ((resp.card ?? resp.cardInfo ?? {}) as Record<string, unknown>);
  return {
    brand: (c.brand ?? c.cardBrand ?? resp.cardBrand) as string | null ?? null,
    last4: (c.lastFourDigits ?? c.last4 ?? resp.lastFourDigits) as string | null ?? null,
    expMonth: Number((c.expiryMonth ?? c.expMonth ?? resp.expiryMonth) ?? 0) || null,
    expYear: Number((c.expiryYear ?? c.expYear ?? resp.expiryYear) ?? 0) || null,
  };
}
