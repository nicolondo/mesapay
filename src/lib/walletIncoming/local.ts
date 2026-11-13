import "server-only";
import type { PaymentMethod } from "@prisma/client";
import { db } from "@/lib/db";
import type { WalletIncomingScope } from "./contracts";
import type { LocalCharge } from "./matching";
import type { SettlementPeriod } from "./report";

const LIMIT = 200;
// Bre-B (`kushki_bre_b`) NO está acá a propósito: lo recauda OTRO comercio
// de Kushki (otras llaves, otra wallet), así que no aparece en las
// liquidaciones de la wallet de tarjeta/PSE que este reporte compara. Hasta
// que Kushki confirme dónde liquida Bre-B, incluirlo sólo mostraría cobros
// "sin liquidar" que nunca van a casar. Lo fija `breB/wiring.test.ts`.
const METHODS: PaymentMethod[] = ["kushki_card", "kushki_apple_pay", "kushki_google_pay", "kushki_pse", "kushki_card_terminal"];
type Mirror = { kushkiTxId: string; amountCents: number; raw: unknown; createdAt?: Date };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reference = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/^(mock[_:-]|manual:)/i.test(value) ? value : null;
const currency = (value: unknown): string | null => typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;

/** The legacy mirror's currency column defaults to COP; only an explicit
 * provider currency in the matching charge's raw response is evidence. */
function proof(providerRef: string | null, amount: number, mirrors: Mirror[]) {
  const refs = new Set<string>();
  const primary = reference(providerRef);
  if (primary) refs.add(primary);
  const matches = mirrors.filter((m) => m.kushkiTxId === primary && m.amountCents === amount);
  if (matches.length !== 1) return { references: [...refs], currency: null, chargedAt: null };
  const mirror = matches[0];
  const raw = object(mirror.raw);
  const nested = object(raw.rawResponse);
  const bodies = [raw, nested].filter((r) => (r.transactionReference ?? r.transaction_reference) === primary);
  for (const body of bodies) {
    const ticket = reference(body.ticketNumber ?? body.ticket_number);
    if (ticket) refs.add(ticket);
  }
  const currencies = [...new Set(bodies.map((r) => currency(object(r.amount).currency ?? r.currency)).filter((c): c is string => c !== null))];
  return { references: [...refs], currency: currencies.length === 1 ? currencies[0] : null, chargedAt: mirror.createdAt ?? null };
}

function validated(charge: LocalCharge): LocalCharge {
  if (!Number.isSafeInteger(charge.amountCents) || charge.amountCents < 0 || !Number.isSafeInteger(charge.refundedCents) || charge.refundedCents < 0 || charge.refundedCents > charge.amountCents) throw new Error("invalid_local_money");
  return charge;
}
function bounded(charges: LocalCharge[], mayBeTruncated: boolean, period: SettlementPeriod) {
  const within = charges.filter((charge) => charge.occurredAt >= period.periodStart && charge.occurredAt <= period.periodEnd)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  return { charges: within.slice(0, LIMIT), truncated: mayBeTruncated || within.length > LIMIT };
}

export async function loadLocalCharges(scope: WalletIncomingScope, period: SettlementPeriod): Promise<{ charges: LocalCharge[]; truncated: boolean }> {
  const range = { gte: new Date(period.periodStart), lte: new Date(period.periodEnd) };
  if (scope.kind === "platform") {
    // No restaurant join: these platform receipts survive tenant deletion.
    const receipts = await db.membershipPayment.findMany({ where: { method: "kushki_card", kind: { in: ["initial", "recurring"] }, createdAt: range },
      select: { id: true, amountCents: true, providerRef: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: LIMIT + 1 });
    return bounded(receipts.filter((r) => !/^mock[_:-]/i.test(r.providerRef ?? "")).map((r) => validated({
      id: r.id, source: "subscription", occurredAt: r.createdAt.toISOString(), dateBasis: "record", amountCents: r.amountCents,
      currency: null, refundedCents: 0, references: reference(r.providerRef) ? [r.providerRef!] : [],
    })), receipts.length > LIMIT, period);
  }
  const restaurantId = scope.restaurantId;
  const [payments, reservations, links] = await Promise.all([
    db.payment.findMany({ where: { order: { restaurantId }, method: { in: METHODS }, status: { in: ["approved", "refunded"] },
      OR: [{ settledAt: range }, { settledAt: null, createdAt: range }] },
      select: { id: true, amountCents: true, refundedCents: true, providerRef: true, settledAt: true, createdAt: true,
        kushkiTransactions: { where: { restaurantId, kind: "charge", status: "approved" }, take: 5, select: { kushkiTxId: true, amountCents: true, raw: true } } },
      orderBy: [{ settledAt: "desc" }, { createdAt: "desc" }, { id: "asc" }], take: LIMIT + 1 }),
    db.reservation.findMany({ where: { restaurantId, depositMethod: { in: METHODS }, depositStatus: { in: ["paid", "applied", "forfeited"] }, depositCents: { gt: 0 },
      // This is only a broad candidate filter. updatedAt is NEVER displayed as payment time.
      updatedAt: { gte: range.gte }, createdAt: { lte: range.lte } },
      select: { id: true, depositCents: true, depositTxId: true, createdAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: LIMIT + 1 }),
    db.paymentLink.findMany({ where: { restaurantId, kind: { in: ["voucher_batch", "voucher_statement"] }, status: "paid", method: { in: METHODS },
      OR: [{ paidAt: range }, { paidAt: null, createdAt: range }] },
      select: { id: true, amountCents: true, currency: true, paidAt: true, createdAt: true, providerRef: true },
      orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }, { id: "asc" }], take: LIMIT + 1 }),
  ]);
  const refs = [...new Set([...reservations.map((r) => r.depositTxId), ...links.map((l) => l.providerRef)].filter((ref): ref is string => !!reference(ref)))];
  const mirrors = refs.length ? await db.kushkiTransaction.findMany({ where: { restaurantId, kind: "charge", status: "approved", kushkiTxId: { in: refs } },
    select: { kushkiTxId: true, amountCents: true, raw: true, createdAt: true }, take: refs.length }) : [];
  const charges: LocalCharge[] = [];
  for (const p of payments) {
    if (/^mock[_:-]/i.test(p.providerRef ?? "")) continue;
    const evidence = proof(p.providerRef, p.amountCents, p.kushkiTransactions);
    charges.push(validated({ id: p.id, source: "order", occurredAt: (p.settledAt ?? p.createdAt).toISOString(), dateBasis: p.settledAt ? "payment" : "record",
      amountCents: p.amountCents, refundedCents: p.refundedCents, currency: evidence.currency, references: evidence.references }));
  }
  for (const r of reservations) {
    if (/^mock[_:-]/i.test(r.depositTxId ?? "")) continue;
    const evidence = proof(r.depositTxId, r.depositCents!, mirrors);
    charges.push(validated({ id: r.id, source: "reservation", occurredAt: (evidence.chargedAt ?? r.createdAt).toISOString(), dateBasis: "record",
      amountCents: r.depositCents!, refundedCents: 0, currency: evidence.currency, references: evidence.references }));
  }
  for (const link of links) {
    if (/^mock[_:-]/i.test(link.providerRef ?? "")) continue;
    const evidence = proof(link.providerRef, link.amountCents, mirrors);
    charges.push(validated({ id: link.id, source: "voucher", occurredAt: (link.paidAt ?? link.createdAt).toISOString(), dateBasis: link.paidAt ? "payment" : "record",
      amountCents: link.amountCents, refundedCents: 0, currency: currency(link.currency), references: evidence.references }));
  }
  return bounded(charges, [payments, reservations, links].some((rows) => rows.length > LIMIT), period);
}
