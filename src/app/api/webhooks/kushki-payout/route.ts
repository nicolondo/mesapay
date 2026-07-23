import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Webhook de resultado de Transfer Out (dispersiones / retiros).
 *
 * Kushki lo invoca con los eventos `approvedTransaction` /
 * `declinedTransaction` que declaramos en el `init` del payout (ver
 * disburse() en kushki/live.ts). Casa el `Payout` por `transactionReference`
 * (= providerRef) o por `ticketNumber` y lo pasa a approved/declined.
 *
 * Ping de validación de URL (body vacío) → 200. Evento sin match → 200 igual
 * (ack, queda en logs) para que Kushki no reintente infinito.
 *
 * ⚠️ Los nombres exactos del payload real no están 100% documentados:
 * extraemos defensivamente de varios alias y logueamos el crudo.
 */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!raw || raw.trim() === "") {
    // Handshake / validación de URL.
    return NextResponse.json({ ok: true });
  }

  console.log("[kushki/payout-webhook] raw", raw.slice(0, 800));

  let body: Record<string, unknown>;
  try {
    body = asObj(JSON.parse(raw));
  } catch {
    // Un webhook real siempre trae JSON; si no parsea, ack para no reintentar.
    return NextResponse.json({ ok: true, ignored: "non_json" });
  }

  const details = asObj(body.details);
  const tx = asObj(body.transaction);

  const transactionReference =
    str(body.transactionReference) ||
    str(body.transaction_reference) ||
    str(details.transactionReference) ||
    str(tx.transactionReference);
  const ticketNumber =
    str(body.ticketNumber) ||
    str(body.ticket_number) ||
    str(details.ticketNumber) ||
    str(tx.ticketNumber);

  // Estado. El evento puede venir como nombre (`event`/`name`) o como status.
  const raw2 = (
    str(body.event) ||
    str(body.name) ||
    str(body.status) ||
    str(body.transactionStatus) ||
    str(details.status) ||
    str(tx.status)
  ).toLowerCase();
  const approved =
    raw2.includes("approv") ||
    raw2.includes("aprob") ||
    raw2 === "success" ||
    raw2 === "completed";
  const declined =
    raw2.includes("declin") ||
    raw2.includes("rechaz") ||
    raw2.includes("fail") ||
    raw2.includes("error");

  const responseText =
    str(body.responseText) ||
    str(body.message) ||
    str(asObj(body.processor).message) ||
    str(details.responseText) ||
    null ||
    undefined;

  if (!transactionReference && !ticketNumber) {
    console.log("[kushki/payout-webhook] sin referencia — 200");
    return NextResponse.json({ ok: true });
  }
  if (!approved && !declined) {
    // Estado no terminal (p.ej. INITIALIZED reenviado) → ack, nada que hacer.
    return NextResponse.json({ ok: true, ignored: raw2 || "no_status" });
  }

  const payout = await db.payout.findFirst({
    where: {
      OR: [
        ...(transactionReference ? [{ providerRef: transactionReference }] : []),
        ...(ticketNumber ? [{ ticketNumber }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });

  if (!payout) {
    console.warn("[kushki/payout-webhook] no casó el payout", {
      transactionReference,
      ticketNumber,
      raw2,
    });
    return NextResponse.json({ ok: true, unmatched: true });
  }

  // Idempotencia: si ya está liquidado, no lo pisamos.
  if (payout.status === "approved" || payout.status === "declined") {
    return NextResponse.json({ ok: true, already: payout.status });
  }

  await db.payout.update({
    where: { id: payout.id },
    data: {
      status: approved ? "approved" : "declined",
      settledAt: new Date(),
      responseText: responseText ?? undefined,
    },
  });
  console.log(
    `[kushki/payout-webhook] ${payout.id} → ${approved ? "approved" : "declined"}`,
  );
  return NextResponse.json({ ok: true });
}
