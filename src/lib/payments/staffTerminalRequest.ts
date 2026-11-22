import type { Prisma } from "@prisma/client";

export function staffTerminalRequestKey(orderId: string, method: string, attemptId: string) {
  return `terminal-request:${orderId}:${method}:${attemptId}`;
}

// Called only while holding the order lock. A final negative lookup closes
// this exact launch key, so a delayed initial request cannot revive it.
export async function priorStaffTerminalRequest(tx: Prisma.TransactionClient, key: string) {
  const prior = await tx.financialOperation.findUnique({ where: { key }, select: { paymentId: true } });
  if (prior) return tx.payment.findUniqueOrThrow({ where: { id: prior.paymentId } });
  if (await tx.auditEvent.findUnique({ where: { id: key }, select: { id: true } })) {
    throw new Error("operation_conflict");
  }
  return null;
}

// Multiple staff requests can legitimately reuse the same pending payment.
// Each request keeps a lookup key. This is distinct from the terminal:<id>
// claim: a recorded request alone does not mean a charge was sent.
export async function rememberStaffTerminalRequest(
  tx: Prisma.TransactionClient, key: string | undefined, payment: { id: string; amountCents: number },
) {
  if (key) await tx.financialOperation.create({ data: {
    key, paymentId: payment.id, amountCents: payment.amountCents, kind: "terminal_request", status: "completed",
  } });
}
