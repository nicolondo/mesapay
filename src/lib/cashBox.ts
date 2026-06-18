// Saldo de caja en vivo — NO se persiste, se calcula a partir de:
//   base inicial del turno general
//   + efectivo cobrado en la caja general (no por meseros)
//   − egresos + ingresos (CashMovement)
//   − bases de meseros con turno abierto       (solo by_waiter)
//   + efectivo de meseros que ya cerraron       (solo by_waiter)
//
// Razonamiento del cajón físico (round-trip de la base del mesero):
//   - mesero abre con base B  → cajón −= B (se la llevó)
//   - mesero cobra efectivo C → C queda en su mano, no en el cajón
//   - mesero cierra           → devuelve B + C al cajón (+B+C)
//   ⇒ mesero cerrado aporta neto +C al cajón; mesero abierto resta −B.
//   consolidado = cajón + Σ(en mano de meseros abiertos) = efectivo total
//   físico del local (sin doble conteo).
//
// Ver docs/superpowers/specs/2026-06-18-caja-management-design.md.

import { db } from "@/lib/db";
import { isCashMethod } from "@/lib/shift";
import type { ShiftPolicy } from "@/lib/staffPolicies";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";

export type MeseroBox = {
  userId: string;
  name: string;
  openedAtIso: string;
  baseCents: number; // openingCashCents
  collectedCashCents: number; // efectivo que cobró en su ventana
  inHandCents: number; // base + cobrado (lo que tiene físicamente)
  mustReturnCents: number; // = inHandCents (devuelve base + cobrado)
};

export type CashMovementRow = {
  id: string;
  kind: "egreso" | "ingreso";
  amountCents: number;
  concept: string;
  occurredAt: string; // ISO
  byName: string | null;
};

export type CashSnapshot = {
  shiftPolicy: ShiftPolicy;
  // ¿hay turno GENERAL del local abierto? Sin él no hay caja general.
  open: boolean;
  general: {
    openedAtIso: string | null;
    openingCents: number;
    collectedCashCents: number; // cobrado directo en general (no meseros)
    egresoCents: number;
    ingresoCents: number;
    basesOutCents: number; // Σ bases de meseros abiertos (by_waiter)
    returnedCashCents: number; // Σ efectivo de meseros que cerraron (by_waiter)
    balanceCents: number; // saldo esperado en el cajón
  };
  meseros: MeseroBox[]; // turnos de mesero abiertos (by_waiter)
  consolidatedCents: number; // cajón + Σ en mano de meseros abiertos
  movements: CashMovementRow[];
};

/**
 * Registra un egreso/ingreso manual de la caja general. Lo liga al
 * turno general abierto (si hay), publica `cash.updated` al bus SSE y
 * deja rastro en el audit log. Compartido por las rutas operator y admin.
 */
export async function recordCashMovement(args: {
  restaurantId: string;
  kind: "egreso" | "ingreso";
  amountCents: number;
  concept: string;
  createdById: string;
}) {
  const generalShift = await db.shift.findFirst({
    where: { restaurantId: args.restaurantId, status: "open", userId: null },
    select: { id: true },
  });
  const mv = await db.cashMovement.create({
    data: {
      restaurantId: args.restaurantId,
      shiftId: generalShift?.id ?? null,
      kind: args.kind,
      amountCents: args.amountCents,
      concept: args.concept,
      createdById: args.createdById,
    },
  });
  publishOrderEvent(args.restaurantId, { type: "cash.updated" });
  await recordAuditEvent({
    kind: "cash.movement",
    restaurantId: args.restaurantId,
    target: { type: "restaurant", id: args.restaurantId },
    summary: `${args.kind === "egreso" ? "Egreso" : "Ingreso"} de caja $${Math.round(
      args.amountCents / 100,
    ).toLocaleString("es-CO")} — ${args.concept}`,
  });
  return mv;
}

function emptySnapshot(shiftPolicy: ShiftPolicy): CashSnapshot {
  return {
    shiftPolicy,
    open: false,
    general: {
      openedAtIso: null,
      openingCents: 0,
      collectedCashCents: 0,
      egresoCents: 0,
      ingresoCents: 0,
      basesOutCents: 0,
      returnedCashCents: 0,
      balanceCents: 0,
    },
    meseros: [],
    consolidatedCents: 0,
    movements: [],
  };
}

export async function buildCashSnapshot(
  restaurantId: string,
  shiftPolicy: ShiftPolicy,
): Promise<CashSnapshot> {
  // Turno general del local (userId null). Sin él no hay caja abierta.
  const generalShift = await db.shift.findFirst({
    where: { restaurantId, status: "open", userId: null },
    orderBy: { openedAt: "desc" },
  });
  if (!generalShift) return emptySnapshot(shiftPolicy);
  const since = generalShift.openedAt;

  const byWaiter = shiftPolicy === "by_waiter";

  // Ids de meseros del local — para clasificar qué efectivo cobró un
  // mesero (su caja) vs la caja general (operador / sin trackear).
  const meseroUsers = byWaiter
    ? await db.user.findMany({
        where: { restaurantId, role: "mesero" },
        select: { id: true },
      })
    : [];
  const meseroIds = new Set(meseroUsers.map((u) => u.id));

  // Turnos de mesero abiertos + cerrados desde que abrió el turno general.
  const meseroShifts = byWaiter
    ? await db.shift.findMany({
        where: {
          restaurantId,
          userId: { not: null },
          OR: [{ status: "open" }, { status: "closed", closedAt: { gte: since } }],
        },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { openedAt: "asc" },
      })
    : [];

  // Efectivo cobrado en el período (desde que abrió el turno general).
  const payments = await db.payment.findMany({
    where: {
      status: "approved",
      settledAt: { gte: since },
      order: { restaurantId },
    },
    select: {
      method: true,
      amountCents: true,
      collectedByUserId: true,
      settledAt: true,
    },
  });
  const cashPayments = payments.filter((p) => isCashMethod(p.method));

  // Movimientos manuales (egresos/ingresos) del período.
  const movements = await db.cashMovement.findMany({
    where: { restaurantId, occurredAt: { gte: since } },
    include: { createdBy: { select: { name: true, email: true } } },
    orderBy: { occurredAt: "desc" },
  });

  // Efectivo cobrado en la caja general = el que NO cobró un mesero.
  const collectedCashCents = cashPayments
    .filter((p) => !p.collectedByUserId || !meseroIds.has(p.collectedByUserId))
    .reduce((s, p) => s + p.amountCents, 0);

  const egresoCents = movements
    .filter((m) => m.kind === "egreso")
    .reduce((s, m) => s + m.amountCents, 0);
  const ingresoCents = movements
    .filter((m) => m.kind === "ingreso")
    .reduce((s, m) => s + m.amountCents, 0);

  // Cajas de meseros (abiertos) + devoluciones (cerrados en el período).
  const meseros: MeseroBox[] = [];
  let basesOutCents = 0;
  let returnedCashCents = 0;
  for (const sh of meseroShifts) {
    const collected = cashPayments
      .filter(
        (p) =>
          p.collectedByUserId === sh.userId &&
          p.settledAt != null &&
          p.settledAt >= sh.openedAt &&
          (sh.closedAt == null || p.settledAt <= sh.closedAt),
      )
      .reduce((s, p) => s + p.amountCents, 0);
    if (sh.status === "open") {
      basesOutCents += sh.openingCashCents;
      const inHand = sh.openingCashCents + collected;
      meseros.push({
        userId: sh.userId!,
        name: sh.user?.name ?? sh.user?.email ?? "Mesero",
        openedAtIso: sh.openedAt.toISOString(),
        baseCents: sh.openingCashCents,
        collectedCashCents: collected,
        inHandCents: inHand,
        mustReturnCents: inHand,
      });
    } else {
      // Cerrado: la base hizo round-trip (neto 0); su efectivo volvió
      // al cajón.
      returnedCashCents += collected;
    }
  }

  const balanceCents =
    generalShift.openingCashCents +
    collectedCashCents -
    egresoCents +
    ingresoCents -
    basesOutCents +
    returnedCashCents;

  const consolidatedCents =
    balanceCents + meseros.reduce((s, m) => s + m.inHandCents, 0);

  return {
    shiftPolicy,
    open: true,
    general: {
      openedAtIso: since.toISOString(),
      openingCents: generalShift.openingCashCents,
      collectedCashCents,
      egresoCents,
      ingresoCents,
      basesOutCents,
      returnedCashCents,
      balanceCents,
    },
    meseros,
    consolidatedCents,
    movements: movements.map((m) => ({
      id: m.id,
      kind: m.kind,
      amountCents: m.amountCents,
      concept: m.concept,
      occurredAt: m.occurredAt.toISOString(),
      byName: m.createdBy?.name ?? m.createdBy?.email ?? null,
    })),
  };
}
