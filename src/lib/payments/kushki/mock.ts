import { randomUUID } from "crypto";
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

/**
 * In-process fakes for KUSHKI_MODE=mock. The point is to let us build and
 * test the entire onboarding -> charge -> wallet -> dispersion flow without
 * Kushki credentials. State persists for the lifetime of the Node process;
 * a restart wipes it, which is fine for development.
 *
 * Behaviour is intentionally a bit lossy (3s terminal delay, 90% approval
 * rate on charges) so we exercise loading/error UI naturally.
 */

type MockMerchant = {
  merchantId: string;
  publicKey: string;
  privateKey: string;
  status: MerchantSummary["status"];
  balanceCents: number;
  movements: WalletMovement[];
  pendingTerminalRequests: Map<
    string,
    { req: TerminalPushRequest; resolveAt: number }
  >;
};

const merchants = new Map<string, MockMerchant>();

function ensureMerchant(merchantId: string): MockMerchant {
  let m = merchants.get(merchantId);
  if (!m) {
    m = {
      merchantId,
      publicKey: `mock_pk_${merchantId}`,
      privateKey: `mock_sk_${merchantId}`,
      status: "active",
      balanceCents: 0,
      movements: [],
      pendingTerminalRequests: new Map(),
    };
    merchants.set(merchantId, m);
  }
  return m;
}

function recordMovement(m: MockMerchant, mov: Omit<WalletMovement, "balanceAfterCents">) {
  m.balanceCents += mov.kind === "credit" ? mov.amountCents : -mov.amountCents;
  const full: WalletMovement = {
    ...mov,
    balanceAfterCents: m.balanceCents,
  };
  m.movements.unshift(full);
}

export class MockKushkiProvider implements PaymentProvider {
  async submitOnboarding(submission: OnboardingSubmission): Promise<MerchantSummary> {
    const merchantId = `mock_mid_${randomUUID().slice(0, 8)}`;
    const m: MockMerchant = {
      merchantId,
      publicKey: `mock_pk_${merchantId}`,
      privateKey: `mock_sk_${merchantId}`,
      // Pretend Kushki auto-approves after a few seconds — for the purposes
      // of dev we just mark active immediately. UI exercises the in_review
      // state by other means (polling endpoint can stub it).
      status: "active",
      balanceCents: 0,
      movements: [],
      pendingTerminalRequests: new Map(),
    };
    merchants.set(merchantId, m);
    // Reference the submission to keep linters happy; in a richer mock we
    // could echo bank info back in notes.
    void submission;
    return {
      merchantId,
      publicKey: m.publicKey,
      privateKey: m.privateKey,
      status: m.status,
    };
  }

  async getMerchantStatus(merchantId: string): Promise<MerchantSummary> {
    const m = ensureMerchant(merchantId);
    return {
      merchantId: m.merchantId,
      publicKey: m.publicKey,
      privateKey: m.privateKey,
      status: m.status,
    };
  }

  async chargeWithToken(req: ChargeRequest): Promise<ChargeResult> {
    await sleep(800 + Math.random() * 400);
    const approved = Math.random() < 0.9;
    const providerRef = `mock_tx_${randomUUID().slice(0, 8)}`;
    if (approved) {
      const m = ensureMerchant(req.merchantId);
      recordMovement(m, {
        externalRef: providerRef,
        kind: "credit",
        amountCents: req.amount.amountCents,
        description: `Cobro orden ${req.metadata.orderId.slice(0, 6)}`,
        occurredAt: new Date(),
      });
      return {
        providerRef,
        status: "approved",
        message: "Aprobado (mock)",
        raw: { mock: true, amount: req.amount.amountCents },
      };
    }
    return {
      providerRef,
      status: "declined",
      message: "Rechazada por el banco (mock)",
      raw: { mock: true, reason: "insufficient_funds" },
    };
  }

  async pushToTerminal(req: TerminalPushRequest): Promise<TerminalPushResult> {
    const m = ensureMerchant(req.merchantId);
    const providerRef = `mock_tx_${randomUUID().slice(0, 8)}`;
    const resolveAt = Date.now() + 3000;
    m.pendingTerminalRequests.set(providerRef, { req, resolveAt });

    // Auto-settle after 3s — caller polls or waits for our simulated
    // webhook. The mock webhook dispatcher in onboarding integration tests
    // can read pendingTerminalRequests and emit the right shape.
    setTimeout(() => {
      const pending = m.pendingTerminalRequests.get(providerRef);
      if (!pending) return;
      m.pendingTerminalRequests.delete(providerRef);
      const approved = Math.random() < 0.9;
      if (approved) {
        recordMovement(m, {
          externalRef: providerRef,
          kind: "credit",
          amountCents: pending.req.amount.amountCents,
          description: `Datáfono mesa orden ${pending.req.metadata.orderId.slice(0, 6)}`,
          occurredAt: new Date(),
        });
      }
      // Notify the in-process simulated webhook bus so the route handler
      // can react. Lazy import to avoid a cycle.
      void notifyMockWebhook({
        type: approved ? "terminal.approved" : "terminal.declined",
        providerRef,
        merchantId: req.merchantId,
        amountCents: pending.req.amount.amountCents,
        orderId: pending.req.metadata.orderId,
        paymentId: pending.req.metadata.paymentId,
      });
    }, 3000);

    return {
      providerRef,
      status: "delivered",
      message: "Push entregado al terminal (mock)",
    };
  }

  async cancelTerminalTransaction(
    merchantId: string,
    providerRef: string,
  ): Promise<void> {
    const m = ensureMerchant(merchantId);
    m.pendingTerminalRequests.delete(providerRef);
  }

  async getBalance(merchantId: string): Promise<WalletBalance> {
    const m = ensureMerchant(merchantId);
    return {
      availableCents: m.balanceCents,
      pendingCents: 0,
      currency: "COP",
    };
  }

  async listMovements(
    merchantId: string,
    opts: { sinceMs?: number; limit?: number },
  ): Promise<WalletMovement[]> {
    const m = ensureMerchant(merchantId);
    const since = opts.sinceMs ?? 0;
    return m.movements
      .filter((mv) => mv.occurredAt.getTime() >= since)
      .slice(0, opts.limit ?? 50);
  }

  async disburse(req: DispersionRequest): Promise<DispersionResult> {
    const m = ensureMerchant(req.merchantId);
    if (req.amount.amountCents > m.balanceCents) {
      return {
        providerRef: `mock_dispersion_failed_${randomUUID().slice(0, 6)}`,
        status: "failed",
      };
    }
    const providerRef = `mock_dispersion_${randomUUID().slice(0, 8)}`;
    recordMovement(m, {
      externalRef: providerRef,
      kind: "dispersion",
      amountCents: req.amount.amountCents,
      description: `Dispersión a ${req.bankInfo.bankName} ${req.bankInfo.accountNumber.slice(-4)}`,
      occurredAt: new Date(),
    });
    return {
      providerRef,
      status: "queued",
      estimatedSettlementAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }
}

// ---- Mock webhook bus ------------------------------------------------------
// Routes that would normally receive Kushki webhooks subscribe here to react
// to mock events as if they came from Kushki. This is opt-in from the route
// — production webhook handler does not depend on this.

type MockWebhookEvent =
  | {
      type: "terminal.approved" | "terminal.declined";
      providerRef: string;
      merchantId: string;
      amountCents: number;
      orderId: string;
      paymentId: string;
    }
  | { type: "merchant.activated"; merchantId: string };

type Listener = (e: MockWebhookEvent) => void;
const listeners = new Set<Listener>();

export function subscribeMockWebhook(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notifyMockWebhook(e: MockWebhookEvent): Promise<void> {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
