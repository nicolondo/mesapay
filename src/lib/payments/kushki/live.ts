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
import { getKushkiModeSync } from "../../platformConfig";
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
    const amount = req.amount.amountCents / 100;
    const body = {
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
      bankId: req.bankCode,
      ...(req.paymentDescription
        ? { paymentDescription: req.paymentDescription }
        : {}),
    };

    // Logging defensivo: la API real de PSE no está 100% documentada
    // todavía, así que dejamos rastro del request y la respuesta para
    // ajustar mappings si Kushki devuelve algo distinto a lo asumido.
    console.log("[kushki/pse] init request", {
      bankId: req.bankCode,
      amount,
      doc: req.buyer.docType + req.buyer.docNumber,
    });

    let resp: Record<string, unknown>;
    try {
      resp = await kushkiFetch<Record<string, unknown>>("/transfer/v1/init", {
        method: "POST",
        auth: { kind: "submerchant", privateKey: req.merchantId },
        body,
      });
    } catch (err) {
      console.error("[kushki/pse] init FAILED", err);
      throw err;
    }

    console.log("[kushki/pse] init response", JSON.stringify(resp).slice(0, 500));

    // Kushki puede devolver el redirect en distintos nombres según el
    // producto (PSE clásico vs Avanza vs Transfer-Async). Probamos las
    // claves más comunes en orden de probabilidad.
    const token =
      (typeof resp.token === "string" && resp.token) ||
      (typeof resp.transactionToken === "string" && resp.transactionToken) ||
      (typeof resp.transferId === "string" && resp.transferId) ||
      "";

    const explicitRedirect =
      (typeof resp.redirectUrl === "string" && resp.redirectUrl) ||
      (typeof resp.url === "string" && resp.url) ||
      (typeof resp.pseUrl === "string" && resp.pseUrl) ||
      (typeof resp.bankUrl === "string" && resp.bankUrl) ||
      "";

    if (!explicitRedirect && !token) {
      // Kushki no devolvió ni token ni URL — algo está muy mal.
      console.error("[kushki/pse] no redirect+token in response", resp);
      throw new Error(
        "Kushki PSE init devolvió respuesta sin token ni redirectUrl. " +
          "Ver logs para shape exacto.",
      );
    }

    const redirectUrl =
      explicitRedirect ||
      // Fallback con el patrón hosted estándar de Kushki PSE. Si el
      // path real es otro lo ajustamos cuando lo veamos en los logs.
      `${getKushkiModeSync() === "production" ? "https://transferencias.kushkipagos.com" : "https://transferencias-uat.kushkipagos.com"}/?token=${encodeURIComponent(token)}`;

    return {
      providerRef: token || explicitRedirect.slice(-40),
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
