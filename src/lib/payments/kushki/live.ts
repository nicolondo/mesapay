import type {
  PaymentProvider,
  OnboardingSubmission,
  MerchantSummary,
  ChargeRequest,
  ChargeResult,
  PseBank,
  PseInitRequest,
  PseInitResult,
  TerminalPushRequest,
  TerminalPushResult,
  WalletBalance,
  WalletMovement,
  DispersionRequest,
  DispersionResult,
} from "../types";
import { env } from "../../env";
import { kushkiFetch } from "./client";
import {
  SubmerchantCreateResponseSchema,
  type SubmerchantCreateResponse,
  ChargeResponseSchema,
  type ChargeResponse,
  TerminalPushResponseSchema,
  type TerminalPushResponse,
  BalanceResponseSchema,
  type BalanceResponse,
  MovementResponseSchema,
  DispersionResponseSchema,
  type DispersionResponse,
} from "./schemas";

/**
 * Live Kushki provider. The wire shapes here are based on Kushki's public
 * REST documentation (api-docs.kushkipagos.com) and the marketplace partner
 * pattern. Exact paths and field names may need 1-line tweaks once we have
 * partner-grade docs from Kushki — keep all transport details in this file.
 */
export class LiveKushkiProvider implements PaymentProvider {
  async submitOnboarding(
    submission: OnboardingSubmission,
  ): Promise<MerchantSummary> {
    const resp = await kushkiFetch<SubmerchantCreateResponse>("/partners/v1/submerchants", {
      method: "POST",
      auth: { kind: "partner" },
      body: {
        legalName: submission.legalName,
        taxId: submission.taxId,
        contactEmail: submission.contactEmail,
        contactPhone: submission.contactPhone,
        bankInfo: {
          bankName: submission.bankInfo.bankName,
          accountType: submission.bankInfo.accountType,
          accountNumber: submission.bankInfo.accountNumber,
          holderName: submission.bankInfo.holderName,
          holderDocType: submission.bankInfo.holderDocType,
          holderDocNumber: submission.bankInfo.holderDocNumber,
        },
        documents: submission.documents.map((d) => ({
          kind: d.kind,
          url: d.fileUrl,
          fileName: d.fileName,
          mimeType: d.mimeType,
        })),
      },
      schema: SubmerchantCreateResponseSchema,
    });
    return {
      merchantId: resp.merchantId,
      publicKey: resp.publicMerchantId,
      privateKey: resp.privateMerchantId,
      status: resp.status,
      notes: resp.notes,
    };
  }

  async getMerchantStatus(merchantId: string): Promise<MerchantSummary> {
    const resp = await kushkiFetch<SubmerchantCreateResponse>(`/partners/v1/submerchants/${merchantId}`, {
      method: "GET",
      auth: { kind: "partner" },
      schema: SubmerchantCreateResponseSchema,
    });
    return {
      merchantId: resp.merchantId,
      publicKey: resp.publicMerchantId,
      privateKey: resp.privateMerchantId,
      status: resp.status,
      notes: resp.notes,
    };
  }

  async chargeWithToken(req: ChargeRequest): Promise<ChargeResult> {
    // Kushki tokens carry the payment instrument (Apple Pay or saved
    // card — Google Pay isn't offered by Kushki Colombia). We charge
    // with the sub-merchant's private key so funds route to the right
    // wallet.
    const resp = await kushkiFetch<ChargeResponse>("/card/v1/charges", {
      method: "POST",
      auth: { kind: "submerchant", privateKey: req.merchantId },
      body: {
        token: req.token,
        amount: { subtotalIva: 0, subtotalIva0: req.amount.amountCents / 100, iva: 0, currency: req.amount.currency },
        metadata: req.metadata,
      },
      schema: ChargeResponseSchema,
    });
    return {
      providerRef: resp.transactionReference,
      status:
        resp.status === "APPROVAL"
          ? "approved"
          : resp.status === "DECLINED"
            ? "declined"
            : "pending",
      message: resp.responseText,
      raw: resp,
    };
  }

  /**
   * Lista de bancos PSE. Endpoint `GET transfer-subscriptions/v1/bankList`
   * con header `Public-Merchant-Id`. Devuelve `[{ code, name }]`.
   *
   * Para PSE simple (no recurrente), Kushki muestra el bank picker en
   * su página hosted después del init — no es estrictamente necesario
   * usar esta lista. La dejamos por si en el futuro queremos mostrar
   * un dropdown "preview" antes de redirigir.
   */
  async listPseBanks(publicKey: string): Promise<PseBank[]> {
    const resp = await kushkiFetch<
      Array<{ code?: string; id?: string; name: string }>
    >("/transfer-subscriptions/v1/bankList", {
      method: "GET",
      auth: { kind: "submerchant_public", publicKey },
    });
    const arr = Array.isArray(resp) ? resp : [];
    return arr.map((b) => ({
      code: String(b.code ?? b.id ?? ""),
      name: b.name,
    }));
  }

  /**
   * Inicia una transacción PSE.
   *
   * Endpoint: `POST /transfer/v1/init`
   * Auth: header `Private-Merchant-Id` con la private key del sub-merchant
   * Body schema (basado en Kushki Android SDK Transfer.kt + docs):
   *   {
   *     amount: { subtotalIva, subtotalIva0, iva },
   *     callbackUrl,            // URL absoluta a la que Kushki redirige al terminar
   *     userType,               // "0" natural | "1" jurídica
   *     documentType,           // "CC" | "CE" | "NIT" | "PA"
   *     documentNumber,
   *     email,
   *     currency,               // "COP"
   *     paymentDescription      // opcional, aparece en extracto bancario
   *   }
   * Respuesta esperada: { token, redirectUrl } o similar — armamos
   * la URL del banco con el token si Kushki no la devuelve directa.
   */
  async initiatePse(req: PseInitRequest): Promise<PseInitResult> {
    // PSE en COP no tiene IVA aplicable a productos servicios para
    // el flujo de tokenización — Kushki recibe el monto bruto como
    // subtotalIva0 (productos exentos) e iva=0. Si el comercio tiene
    // IVA discriminado, se ajusta acá; por ahora aceptamos el cobro
    // como subtotal exento.
    const amount = req.amount.amountCents / 100;
    const resp = await kushkiFetch<{
      token?: string;
      redirectUrl?: string;
      url?: string;
      transactionToken?: string;
    }>("/transfer/v1/init", {
      method: "POST",
      auth: { kind: "submerchant", privateKey: req.merchantId },
      body: {
        amount: {
          subtotalIva: 0,
          subtotalIva0: amount,
          iva: 0,
        },
        callbackUrl: req.callbackUrl,
        userType: req.buyer.personType === "juridica" ? "1" : "0",
        documentType: req.buyer.docType,
        documentNumber: req.buyer.docNumber,
        email: req.buyer.email,
        currency: req.amount.currency,
        ...(req.paymentDescription
          ? { paymentDescription: req.paymentDescription }
          : {}),
      },
    });

    // Kushki devuelve un `token` y opcionalmente una `redirectUrl`. Si
    // sólo devuelve token, armamos la URL del flujo PSE hosted con el
    // patrón estándar de Kushki — Kushki muestra el bank picker ahí.
    const token = resp.token ?? resp.transactionToken ?? "";
    const explicitRedirect = resp.redirectUrl ?? resp.url ?? "";
    const redirectUrl =
      explicitRedirect ||
      // Fallback al patrón hosted estándar. Si Kushki cambia el path
      // basta editarlo acá. En el wire log del onboarding partner se
      // confirma este path; mientras tanto lo dejamos como pattern.
      `${env.KUSHKI_MODE === "production" ? "https://transferencias.kushkipagos.com" : "https://transferencias-uat.kushkipagos.com"}/?token=${encodeURIComponent(token)}`;

    return {
      providerRef: token,
      redirectUrl,
      status: "pending",
    };
  }

  async pushToTerminal(req: TerminalPushRequest): Promise<TerminalPushResult> {
    const resp = await kushkiFetch<TerminalPushResponse>("/smartpos/v1/transactions", {
      method: "POST",
      auth: { kind: "submerchant", privateKey: req.merchantId },
      body: {
        deviceId: req.deviceId,
        amount: req.amount.amountCents,
        currency: req.amount.currency,
        metadata: req.metadata,
      },
      schema: TerminalPushResponseSchema,
    });
    return {
      providerRef: resp.transactionReference,
      status: resp.status,
      message: resp.message,
    };
  }

  async cancelTerminalTransaction(
    merchantId: string,
    providerRef: string,
  ): Promise<void> {
    await kushkiFetch(`/smartpos/v1/transactions/${providerRef}/cancel`, {
      method: "POST",
      auth: { kind: "submerchant", privateKey: merchantId },
    });
  }

  async getBalance(merchantId: string): Promise<WalletBalance> {
    const resp = await kushkiFetch<BalanceResponse>(`/wallet/v1/balance`, {
      method: "GET",
      auth: { kind: "submerchant", privateKey: merchantId },
      schema: BalanceResponseSchema,
    });
    return {
      availableCents: Math.round(resp.availableAmount * 100),
      pendingCents: Math.round(resp.pendingAmount * 100),
      currency: resp.currency,
    };
  }

  async listMovements(
    merchantId: string,
    opts: { sinceMs?: number; limit?: number },
  ): Promise<WalletMovement[]> {
    const sinceIso = opts.sinceMs ? new Date(opts.sinceMs).toISOString() : "";
    const query = new URLSearchParams();
    if (sinceIso) query.set("from", sinceIso);
    if (opts.limit) query.set("limit", String(opts.limit));
    const path = `/wallet/v1/movements${query.size ? "?" + query.toString() : ""}`;
    const resp = await kushkiFetch<unknown>(path, {
      method: "GET",
      auth: { kind: "submerchant", privateKey: merchantId },
    });
    const arr = Array.isArray(resp) ? resp : [];
    const out: WalletMovement[] = [];
    for (const row of arr) {
      const r = MovementResponseSchema.safeParse(row);
      if (!r.success) continue;
      out.push({
        externalRef: r.data.externalReference,
        kind: r.data.type,
        amountCents: Math.round(r.data.amount * 100),
        balanceAfterCents: Math.round(r.data.balanceAfter * 100),
        description: r.data.description,
        occurredAt: new Date(r.data.occurredAt),
      });
    }
    return out;
  }

  async disburse(req: DispersionRequest): Promise<DispersionResult> {
    const resp = await kushkiFetch<DispersionResponse>(`/wallet/v1/dispersions`, {
      method: "POST",
      auth: { kind: "submerchant", privateKey: req.merchantId },
      body: {
        amount: req.amount.amountCents,
        currency: req.amount.currency,
        bankInfo: req.bankInfo,
        reference: req.reference,
      },
      schema: DispersionResponseSchema,
    });
    return {
      providerRef: resp.dispersionId,
      status: resp.status,
      estimatedSettlementAt: resp.estimatedSettlementAt
        ? new Date(resp.estimatedSettlementAt)
        : undefined,
    };
  }
}
