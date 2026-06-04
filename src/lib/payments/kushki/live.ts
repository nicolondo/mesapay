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
  pushPaymentToCloudTerminal,
  cancelCloudTerminalPayment,
} from "./cloudTerminal";
import {
  SubmerchantCreateResponseSchema,
  type SubmerchantCreateResponse,
  ChargeResponseSchema,
  type ChargeResponse,
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

// Cache in-memory de la lista de bancos PSE por publicKey. La lista cambia
// rarísimo y el fetch a Kushki es lento (segundos) — sin cache bloqueaba el
// render de la página de pago en CADA carga. TTL 1h; warmea en el primer hit
// de cada proceso.
const PSE_BANK_TTL_MS = 60 * 60 * 1000;
const pseBankCache = new Map<string, { at: number; banks: PseBank[] }>();

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
    // Si Kushki devolvió 2xx (kushkiFetch ya validó) y el body trae
    // ticketNumber+transactionReference pero NO trae `status` explícito,
    // tratamos como aprobado — es la respuesta normal de /card/v1/charges
    // en Colombia para charges exitosos. Los declines vienen con 4xx
    // que ya tiraron throw antes.
    const mapped: ChargeResult["status"] =
      resp.status === "DECLINED"
        ? "declined"
        : resp.status === "INITIALIZED"
          ? "pending"
          : "approved"; // APPROVAL o status ausente
    return {
      providerRef: resp.transactionReference,
      status: mapped,
      message: resp.responseText,
      raw: resp,
    };
  }

  /**
   * Lista de bancos PSE. Endpoint canónico del Kushki.js SDK:
   *   GET /transfer/v1/bankList
   *   auth: Public-Merchant-Id (clave pública del sub-merchant)
   *
   * (No confundir con /transfer-subscriptions/v1/bankList — ese es
   * para suscripciones PSE recurrentes, lista distinta.)
   */
  async listPseBanks(publicKey: string): Promise<PseBank[]> {
    const hit = pseBankCache.get(publicKey);
    if (hit && Date.now() - hit.at < PSE_BANK_TTL_MS) return hit.banks;
    const resp = await kushkiFetch<
      Array<{ code?: string; id?: string; name: string }>
    >("/transfer/v1/bankList", {
      method: "GET",
      auth: { kind: "submerchant_public", publicKey },
    });
    const arr = Array.isArray(resp) ? resp : [];
    const banks = arr.map((b) => ({
      code: String(b.code ?? b.id ?? ""),
      name: b.name,
    }));
    if (banks.length > 0) pseBankCache.set(publicKey, { at: Date.now(), banks });
    return banks;
  }

  /**
   * Inicia una transacción PSE. Endpoint canónico del Kushki.js SDK:
   *   POST /transfer/v1/tokens
   *   auth: Public-Merchant-Id (clave pública, igual que card tokens)
   *
   * Body (verificado contra TransferService + Transfer.kt):
   *   amount: { subtotalIva, subtotalIva0, iva }
   *   callbackUrl                ← URL absoluta a la que vuelve el diner
   *   userType                   ← "0" natural | "1" jurídica
   *   documentType               ← "CC" | "CE" | "NIT" | "PA"
   *   documentNumber
   *   email
   *   currency                   ← "COP"
   *   bankId                     ← código del banco elegido
   *   paymentDescription         ← opcional, aparece en extracto
   *
   * Respuesta esperada (Transaction model):
   *   token         ← identifica el transfer
   *   secureId      ← opcional
   *   secureService ← opcional ("transfer" típicamente)
   *   security      ← objeto con acsURL (la URL del banco) cuando aplica
   *   url / redirectUrl ← campo directo cuando viene
   *
   * En PSE el `acsURL` (o equivalente) es la URL del banco a donde
   * mandamos al diner para que autentique con su login bancario.
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
      resp = await kushkiFetch<Record<string, unknown>>(
        "/transfer/v1/tokens",
        {
          method: "POST",
          // PSE usa auth pública (igual que tokenización de tarjetas).
          // req.merchantId carga la PUBLIC key del sub-merchant para
          // este flow (ver pse-init route).
          auth: { kind: "submerchant_public", publicKey: req.merchantId },
          body,
        },
      );
    } catch (err) {
      console.error("[kushki/pse] tokens FAILED", err);
      throw err;
    }

    console.log(
      "[kushki/pse] tokens response",
      JSON.stringify(resp).slice(0, 800),
    );

    // Buscamos el token y la URL del banco en los campos típicos del
    // Transaction model. `security.acsURL` es lo más probable, pero
    // distintos productos PSE usan distintos nombres.
    const token =
      (typeof resp.token === "string" && resp.token) ||
      (typeof resp.transactionToken === "string" && resp.transactionToken) ||
      "";

    const security =
      resp.security && typeof resp.security === "object"
        ? (resp.security as Record<string, unknown>)
        : null;

    const explicitRedirect =
      (typeof resp.url === "string" && resp.url) ||
      (typeof resp.redirectUrl === "string" && resp.redirectUrl) ||
      (typeof resp.pseUrl === "string" && resp.pseUrl) ||
      (typeof resp.bankUrl === "string" && resp.bankUrl) ||
      (security && typeof security.acsURL === "string" && security.acsURL) ||
      (security && typeof security.acsUrl === "string" && security.acsUrl) ||
      "";

    if (!explicitRedirect && !token) {
      console.error("[kushki/pse] no redirect+token in response", resp);
      throw new Error(
        "Kushki PSE tokens devolvió respuesta sin token ni URL. " +
          "Ver logs para shape exacto.",
      );
    }

    const redirectUrl =
      explicitRedirect ||
      // Sin redirect explícito caemos a la página hosted de Kushki PSE
      // con el token. Si el path real es otro lo ajustamos cuando lo
      // veamos en los logs.
      `${getKushkiModeSync() === "production" ? "https://transferencias.kushkipagos.com" : "https://transferencias-uat.kushkipagos.com"}/?token=${encodeURIComponent(token)}`;

    return {
      providerRef: token || explicitRedirect.slice(-40),
      redirectUrl,
      status: "pending",
    };
  }

  /**
   * Datáfono físico vía Kushki Cloud Terminal API (infra billpocket).
   * `req.deviceId` carga el SERIAL del equipo Ultra (la charge route
   * pasa device.serialNumber). El push sólo es un ACK — el aprobado/
   * rechazado llega por webhook a /api/webhooks/kushki-terminal, que
   * matchea por uniqueReference = paymentId.
   */
  async pushToTerminal(req: TerminalPushRequest): Promise<TerminalPushResult> {
    // El Cloud Terminal CO es SÍNCRONO y se autentica con HMAC del
    // Business-Code (no la private key). La charge route llama a
    // pushPaymentToCloudTerminal directo (con el businessCode del comercio)
    // y settlea con el resultado; este wrapper del provider queda como
    // compatibilidad y cae al Business-Code del env.
    const resp = await pushPaymentToCloudTerminal({
      serialNumber: req.deviceId,
      amountCents: req.amount.amountCents,
      reference: req.metadata.paymentId,
      description: `MESAPAY orden ${req.metadata.orderId.slice(0, 6)}`,
    });
    return {
      providerRef: resp.providerRef,
      status: resp.status === "approved" ? "delivered" : "failed",
      message: resp.message,
    };
  }

  async cancelTerminalTransaction(
    _merchantId: string,
    providerRef: string,
  ): Promise<void> {
    // providerRef == nuestra uniqueReference (paymentId). El serial no
    // viaja acá; el cancel del Cloud Terminal es best-effort.
    await cancelCloudTerminalPayment("", providerRef);
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
