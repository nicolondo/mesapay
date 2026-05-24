import type {
  PaymentProvider,
  OnboardingSubmission,
  MerchantSummary,
  ChargeRequest,
  ChargeResult,
  TerminalPushRequest,
  TerminalPushResult,
  WalletBalance,
  WalletMovement,
  DispersionRequest,
  DispersionResult,
} from "../types";
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
