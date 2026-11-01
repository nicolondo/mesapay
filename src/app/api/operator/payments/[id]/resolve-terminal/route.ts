import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActiveContext } from "@/lib/activeRestaurant";
import { lockOrder } from "@/lib/orderLock";
import { secureApi } from "@/lib/secureApi";
import { terminalClaimKey } from "@/lib/payments/methods";
import { afterReconcile, reconcilePaymentInTx, type ReconcileResult } from "@/lib/payments/reconciliation";
import {
  TERMINAL_RESOLVE_AUTH_MAX,
  TERMINAL_RESOLVE_AUTH_MIN,
  TERMINAL_RESOLVE_EVIDENCE_MAX,
  TERMINAL_RESOLVE_EVIDENCE_MIN,
  canResolveTerminalCharge,
  manualTerminalRef,
  terminalResolvableAt,
} from "@/lib/payments/terminalResolve";

/**
 * "Resolver cobro" del datáfono Kushki: el cobro SÍ se envió al equipo
 * (reclamo `terminal:<id>`) y el resultado nunca volvió. El administrador
 * revisó el comprobante del datáfono o la consola de Kushki y lo marca:
 *
 *   - "No se cobró" → rechazado: la cuenta queda libre para cobrar de otra
 *     forma (y sale de `paying` si no queda nada).
 *   - "Sí se cobró" → aprobado, con el número de autorización o voucher: la
 *     cuenta se salda, se activan rondas prepagas y se emite la factura.
 *
 * Reusa `reconcilePayment` (la conciliación de Cobros) para que totales,
 * contabilidad, factura, eventos y auditoría queden IGUAL que conciliando
 * desde Pagos. Lo que cambia:
 *   - si el pago todavía no tenía `reconciliationRequired`, se marca en la
 *     MISMA transacción antes de conciliar;
 *   - no exige `providerRef`: no hubo respuesta del proveedor, así que se
 *     guarda `manual:<userId>:<paymentId>` (o el que ya tuviera el pago).
 *
 * Reglas:
 *   - sólo operator / platform_admin / group_admin (nunca el mesero);
 *   - sólo `kushki_card_terminal` pendiente y YA enviado: sin reclamo es una
 *     solicitud y se cancela (409 terminal_not_sent);
 *   - sólo 3 minutos después de enviarlo (409 terminal_result_pending con
 *     `resolvableAt`): antes, el datáfono todavía puede responder;
 *   - evidencia obligatoria y confirmación explícita; aprobado exige el
 *     número de autorización.
 * PSE, tarjeta y Apple Pay NO pasan por acá: siguen en Cobros → conciliación.
 */

const evidence = z.string().trim().min(TERMINAL_RESOLVE_EVIDENCE_MIN).max(TERMINAL_RESOLVE_EVIDENCE_MAX);
const schema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("declined"), evidence, confirmed: z.literal(true) }),
  z.object({
    outcome: z.literal("approved"),
    evidence,
    confirmed: z.literal(true),
    authorizationCode: z.string().trim().min(TERMINAL_RESOLVE_AUTH_MIN).max(TERMINAL_RESOLVE_AUTH_MAX),
  }),
]);

type Refusal = { error: string; status: number; resolvableAt?: string };

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActiveContext();
  const actor = ctx?.session.user;
  if (!ctx?.restaurantId || !actor || !canResolveTerminalCharge(actor.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = ctx.restaurantId;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", fields: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const authorizationCode = input.outcome === "approved" ? input.authorizationCode : null;
  const { id } = await params;

  const outcome = await db.$transaction(async (tx): Promise<Refusal | { result: ReconcileResult; providerRef: string }> => {
    const hint = await tx.payment.findUnique({ where: { id }, select: { orderId: true } });
    if (!hint) return { error: "not_found", status: 404 };
    await lockOrder(tx, hint.orderId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id }, include: { order: true } });
    if (payment.order.restaurantId !== restaurantId) return { error: "forbidden", status: 403 };
    if (payment.method !== "kushki_card_terminal") return { error: "wrong_method", status: 400 };
    if (payment.status !== "pending") return { error: "already_settled", status: 409 };
    const claim = await tx.financialOperation.findUnique({ where: { key: terminalClaimKey(id) } });
    // Sin reclamo ni respuesta del proveedor nunca salió hacia Kushki: es
    // una solicitud, se cancela (cancel-request) en vez de "resolverse".
    if (!claim && !payment.providerRef) return { error: "terminal_not_sent", status: 409 };
    const pushedAt = claim?.createdAt ?? payment.createdAt;
    const resolvableAt = terminalResolvableAt(pushedAt) ?? 0;
    if (Date.now() < resolvableAt) {
      return { error: "terminal_result_pending", status: 409, resolvableAt: new Date(resolvableAt).toISOString() };
    }
    if (!payment.reconciliationRequired) {
      await tx.payment.update({ where: { id }, data: { reconciliationRequired: true } });
    }
    const providerRef = payment.providerRef ?? manualTerminalRef(actor.id, id);
    const result = await reconcilePaymentInTx(tx, {
      paymentId: id,
      restaurantId,
      outcome: input.outcome,
      evidence: input.evidence,
      providerRef,
      actor,
      auditExtra: {
        manualTerminalResolution: true,
        authorizationCode,
        pushedAt: pushedAt.toISOString(),
        claimStatus: claim?.status ?? null,
      },
    });
    // El voucher del datáfono queda donde Cobros muestra el código de
    // aprobación de un cobro con tarjeta.
    if (authorizationCode) {
      await tx.kushkiTransaction.updateMany({
        where: { kushkiTxId: providerRef, paymentId: id },
        data: { approvalCode: authorizationCode },
      });
    }
    return { result, providerRef };
  });

  if ("error" in outcome) {
    return NextResponse.json(
      { error: outcome.error, ...(outcome.resolvableAt ? { resolvableAt: outcome.resolvableAt } : {}) },
      { status: outcome.status },
    );
  }
  await afterReconcile(restaurantId, outcome.result);
  return NextResponse.json({ ok: true, status: input.outcome, alreadyResolved: outcome.result.alreadyResolved });
}

export const POST = secureApi(POSTHandler);
