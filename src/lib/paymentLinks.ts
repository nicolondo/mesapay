import { randomBytes } from "node:crypto";
import type { PaymentLinkKind, PaymentMethod, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Links de pago: cobro online de un monto fijo por URL pública
 * (`/r/[slug]/pago/[token]`), con tarjeta / Apple Pay (token Kushki,
 * sincrónico) o PSE (redirect al banco + página de retorno).
 *
 * Generaliza el cobro del depósito de reserva (`reservations/[code]/
 * deposit`), que sigue con su propio camino: acá vive lo que NO depende
 * de qué se está cobrando. Lo que el link cobra lo dice `kind`, y al
 * pagarse se aplica el efecto sobre su destino en `applyPaidEffect`:
 *   voucher_batch     → el lote de bonos pasa a `paid` (los bonos se
 *                       vuelven redimibles en prepago).
 *   voucher_statement → el corte de bonos a crédito queda pagado (PR B).
 *
 * Idempotente: un link pagado no se vuelve a liquidar (el webhook y la
 * página de retorno pueden llegar los dos).
 */

/** 18 bytes → 24 caracteres url-safe. No enumerable. */
export function newPaymentLinkToken(): string {
  return randomBytes(18).toString("base64url");
}

export function paymentLinkPath(slug: string, token: string): string {
  return `/r/${slug}/pago/${token}`;
}

/**
 * Origen público de la app para armar URLs en correos. Mismo criterio
 * que las rutas del depósito de reserva: APP_PUBLIC_BASE_URL manda; si
 * hay request, los headers del proxy; si no, NEXTAUTH_URL o mesapay.co.
 */
export function appOrigin(req?: Request): string {
  const fromEnv = process.env.APP_PUBLIC_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (req) {
    const xfHost = req.headers.get("x-forwarded-host");
    const xfProto = req.headers.get("x-forwarded-proto") ?? "https";
    if (xfHost) return `${xfProto}://${xfHost}`;
    const host = req.headers.get("host");
    if (host) return `${host.includes("localhost") ? "http" : "https"}://${host}`;
    try {
      return new URL(req.url).origin;
    } catch {
      /* fall through */
    }
  }
  return (process.env.NEXTAUTH_URL ?? "https://mesapay.co").replace(/\/$/, "");
}

export type CreatePaymentLinkInput = {
  restaurantId: string;
  kind: PaymentLinkKind;
  amountCents: number;
  currency: string;
  voucherBatchId?: string;
  voucherStatementId?: string;
  expiresAt?: Date | null;
};

export async function createPaymentLinkInTx(
  tx: Prisma.TransactionClient,
  input: CreatePaymentLinkInput,
) {
  return tx.paymentLink.create({
    data: {
      restaurantId: input.restaurantId,
      token: newPaymentLinkToken(),
      kind: input.kind,
      amountCents: input.amountCents,
      currency: input.currency,
      voucherBatchId: input.voucherBatchId,
      voucherStatementId: input.voucherStatementId,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

export type SettlePaymentLinkResult =
  | {
      status: "paid";
      link: {
        id: string;
        restaurantId: string;
        kind: PaymentLinkKind;
        voucherBatchId: string | null;
        voucherStatementId: string | null;
      };
    }
  | { status: "already_paid" | "declined" | "not_found" | "not_pending" };

type LinkWhere = { id: string } | { token: string } | { providerRef: string };

/**
 * Cierra un link con el resultado de un cobro. `approved: false` deja el
 * link pendiente (la empresa puede reintentar). Se llama dentro de una
 * transacción para que el link y su efecto (lote pagado) queden juntos.
 */
export async function settlePaymentLinkInTx(
  tx: Prisma.TransactionClient,
  where: LinkWhere,
  result: {
    approved: boolean;
    providerRef?: string | null;
    method?: PaymentMethod | null;
    payerEmail?: string | null;
  },
): Promise<SettlePaymentLinkResult> {
  const link =
    "providerRef" in where
      ? await tx.paymentLink.findFirst({
          where: { providerRef: where.providerRef },
          orderBy: { createdAt: "desc" },
        })
      : await tx.paymentLink.findUnique({ where });
  if (!link) return { status: "not_found" };
  if (link.status === "paid") return { status: "already_paid" };
  if (link.status !== "pending") return { status: "not_pending" };
  if (!result.approved) return { status: "declined" };

  // updateMany condicionado: si otro riel (webhook vs. retorno) lo cerró
  // entre el find y acá, count = 0 y no se aplica el efecto dos veces.
  const closed = await tx.paymentLink.updateMany({
    where: { id: link.id, status: "pending" },
    data: {
      status: "paid",
      paidAt: new Date(),
      providerRef: result.providerRef ?? link.providerRef,
      method: result.method ?? link.method,
      payerEmail: result.payerEmail ?? link.payerEmail,
    },
  });
  if (closed.count === 0) return { status: "already_paid" };

  await applyPaidEffect(tx, link);
  return {
    status: "paid",
    link: {
      id: link.id,
      restaurantId: link.restaurantId,
      kind: link.kind,
      voucherBatchId: link.voucherBatchId,
      voucherStatementId: link.voucherStatementId,
    },
  };
}

async function applyPaidEffect(
  tx: Prisma.TransactionClient,
  link: { kind: PaymentLinkKind; voucherBatchId: string | null; voucherStatementId: string | null },
): Promise<void> {
  if (link.kind === "voucher_batch" && link.voucherBatchId) {
    await tx.voucherBatch.updateMany({
      where: { id: link.voucherBatchId, status: "issued" },
      data: { status: "paid", paidAt: new Date() },
    });
  }
  if (link.kind === "voucher_statement" && link.voucherStatementId) {
    await tx.voucherStatement.updateMany({
      where: { id: link.voucherStatementId, status: "open" },
      data: { status: "paid", paidAt: new Date() },
    });
  }
}

/**
 * Para el webhook de Kushki: un `transactionReference` que no casa con
 * ningún Payment de orden puede ser un link de pago (PSE del link, o el
 * cobro con tarjeta cuyo aviso llega tarde). Devuelve null si no hay
 * ningún link pendiente con esa referencia.
 */
export async function findPendingPaymentLinkByProviderRef(providerRef: string) {
  if (!providerRef) return null;
  return db.paymentLink.findFirst({
    where: { providerRef, status: "pending" },
    select: { id: true, restaurantId: true, kind: true },
  });
}

/** Cierra (fuera de otra transacción) un link por su referencia. */
export async function settlePaymentLinkByProviderRef(
  providerRef: string,
  approved: boolean,
): Promise<SettlePaymentLinkResult> {
  return db.$transaction((tx) =>
    settlePaymentLinkInTx(tx, { providerRef }, { approved, providerRef }),
  );
}

/** PSE: guarda el token del intento para reconciliarlo al volver del banco. */
export async function markPaymentLinkPending(
  linkId: string,
  providerRef: string,
  method: PaymentMethod,
  payerEmail?: string | null,
): Promise<void> {
  await db.paymentLink.updateMany({
    where: { id: linkId, status: "pending" },
    data: { providerRef, method, payerEmail: payerEmail ?? undefined },
  });
}

export function paymentLinkIsOpen(link: {
  status: string;
  expiresAt: Date | null;
}): boolean {
  if (link.status !== "pending") return false;
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return false;
  return true;
}
