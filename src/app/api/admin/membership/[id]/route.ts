import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { extendOneMonth } from "@/lib/membership";
import { recordAuditEvent } from "@/lib/auditLog";
import { fmtCOP } from "@/lib/format";

const planSchema = z.object({
  action: z.literal("set_plan"),
  plan: z.enum(["trial", "basic", "pro"]),
  monthlyPriceCents: z.number().int().min(0).max(100_000_000),
});

const suspendSchema = z.object({
  action: z.literal("set_suspended"),
  suspended: z.boolean(),
});

const paymentSchema = z.object({
  action: z.literal("record_payment"),
  amountCents: z.number().int().min(0).max(100_000_000),
  method: z.enum(["manual_cash", "manual_transfer", "wompi"]),
  note: z.string().trim().max(240).optional(),
});

const serviceModeSchema = z.object({
  action: z.literal("set_service_mode"),
  serviceMode: z.enum(["table", "counter"]),
});

const pickupEnabledSchema = z.object({
  action: z.literal("set_pickup_enabled"),
  pickupEnabled: z.boolean(),
});

const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const dayWindowsSchema = z
  .array(
    z
      .object({ from: z.string().regex(hhmmRe), to: z.string().regex(hhmmRe) })
      .refine((w) => w.from < w.to, "from must be before to"),
  )
  .max(4);

const pickupHoursSchema = z.object({
  action: z.literal("set_pickup_hours"),
  // null clears the schedule (= always open, pre-schedule behaviour).
  hours: z
    .object({
      sun: dayWindowsSchema.optional(),
      mon: dayWindowsSchema.optional(),
      tue: dayWindowsSchema.optional(),
      wed: dayWindowsSchema.optional(),
      thu: dayWindowsSchema.optional(),
      fri: dayWindowsSchema.optional(),
      sat: dayWindowsSchema.optional(),
    })
    .nullable(),
});

const pickupMaxEtaSchema = z.object({
  action: z.literal("set_pickup_max_eta"),
  // null = no cap.
  maxEtaMinutes: z.number().int().min(5).max(240).nullable(),
});

const bodySchema = z.discriminatedUnion("action", [
  planSchema,
  suspendSchema,
  paymentSchema,
  serviceModeSchema,
  pickupEnabledSchema,
  pickupHoursSchema,
  pickupMaxEtaSchema,
]);

const PICKUP_TABLE_NUMBER = -1;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const rest = await db.restaurant.findUnique({ where: { id } });
  if (!rest) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  if (parsed.data.action === "set_plan") {
    const before = {
      plan: rest.plan,
      monthlyPriceCents: rest.monthlyPriceCents,
    };
    await db.restaurant.update({
      where: { id },
      data: {
        plan: parsed.data.plan,
        monthlyPriceCents: parsed.data.monthlyPriceCents,
      },
    });
    await recordAuditEvent({
      kind: "membership.plan.update",
      restaurantId: id,
      target: { type: "restaurant", id },
      summary: `Cambió plan a ${parsed.data.plan} y mensualidad a ${fmtCOP(parsed.data.monthlyPriceCents)}`,
      diff: {
        before,
        after: {
          plan: parsed.data.plan,
          monthlyPriceCents: parsed.data.monthlyPriceCents,
        },
      },
    });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "set_suspended") {
    await db.restaurant.update({
      where: { id },
      data: { suspended: parsed.data.suspended },
    });
    await recordAuditEvent({
      kind: parsed.data.suspended
        ? "membership.suspend"
        : "membership.unsuspend",
      restaurantId: id,
      target: { type: "restaurant", id },
      summary: parsed.data.suspended
        ? "Suspendió el comercio"
        : "Reactivó el comercio",
    });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "set_pickup_enabled") {
    const next = parsed.data.pickupEnabled;
    const wasEnabled = rest.pickupEnabled;
    await db.$transaction(async (tx) => {
      await tx.restaurant.update({
        where: { id },
        data: { pickupEnabled: next },
      });
      // Enabling pickup needs a dedicated Table row (number: -1) so the QR
      // link + kitchen grouping have somewhere to attach, mirroring the
      // counter-mode lazy-create trick.
      if (next) {
        const pickup = await tx.table.findFirst({
          where: { restaurantId: id, number: PICKUP_TABLE_NUMBER },
        });
        if (!pickup) {
          await tx.table.create({
            data: {
              restaurantId: id,
              number: PICKUP_TABLE_NUMBER,
              label: "Pickup",
              qrToken: crypto.randomUUID(),
            },
          });
        }
      }
    });
    await recordAuditEvent({
      kind: "membership.pickup.toggle",
      restaurantId: id,
      target: { type: "restaurant", id },
      summary: next
        ? "Activó pedido anticipado"
        : "Desactivó pedido anticipado",
      diff: { before: { pickupEnabled: wasEnabled }, after: { pickupEnabled: next } },
    });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "set_pickup_hours") {
    await db.restaurant.update({
      where: { id },
      data: {
        pickupHours: parsed.data.hours
          ? (parsed.data.hours as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
    await recordAuditEvent({
      kind: "membership.pickup.hours.update",
      restaurantId: id,
      target: { type: "restaurant", id },
      summary: parsed.data.hours
        ? "Actualizó horarios de pickup"
        : "Quitó horarios de pickup (abierto siempre)",
      diff: {
        before: { pickupHours: rest.pickupHours as unknown },
        after: { pickupHours: parsed.data.hours },
      },
    });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "set_pickup_max_eta") {
    await db.restaurant.update({
      where: { id },
      data: { pickupMaxEtaMinutes: parsed.data.maxEtaMinutes },
    });
    await recordAuditEvent({
      kind: "membership.pickup.hours.update",
      restaurantId: id,
      target: { type: "restaurant", id },
      summary: parsed.data.maxEtaMinutes
        ? `Tope de espera ${parsed.data.maxEtaMinutes}min`
        : "Quitó tope de espera",
      diff: {
        before: { pickupMaxEtaMinutes: rest.pickupMaxEtaMinutes },
        after: { pickupMaxEtaMinutes: parsed.data.maxEtaMinutes },
      },
    });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "set_service_mode") {
    const nextMode = parsed.data.serviceMode;
    const prevMode = rest.serviceMode;
    await db.$transaction(async (tx) => {
      await tx.restaurant.update({
        where: { id },
        data: { serviceMode: nextMode },
      });
      // Switching into counter mode needs a single QR target (number=0) so
      // /t/[slug] has somewhere to redirect. Create one lazily if missing.
      if (nextMode === "counter") {
        const counter = await tx.table.findFirst({
          where: { restaurantId: id, number: 0 },
        });
        if (!counter) {
          await tx.table.create({
            data: {
              restaurantId: id,
              number: 0,
              label: "Mostrador",
              qrToken: crypto.randomUUID(),
            },
          });
        }
      }
    });
    await recordAuditEvent({
      kind: "membership.service_mode.update",
      restaurantId: id,
      target: { type: "restaurant", id },
      summary: `Cambió modo de ${prevMode} a ${nextMode}`,
      diff: {
        before: { serviceMode: prevMode },
        after: { serviceMode: nextMode },
      },
    });
    return NextResponse.json({ ok: true });
  }

  // record_payment
  const { periodStart, periodEnd } = extendOneMonth(rest.periodEndsAt ?? null);
  const [created] = await db.$transaction([
    db.membershipPayment.create({
      data: {
        restaurantId: id,
        amountCents: parsed.data.amountCents,
        method: parsed.data.method,
        note: parsed.data.note ?? null,
        periodStart,
        periodEnd,
        recordedByEmail: session.user.email,
      },
    }),
    db.restaurant.update({
      where: { id },
      data: {
        periodEndsAt: periodEnd,
        // Auto-unsuspend on fresh payment.
        suspended: false,
      },
    }),
  ]);
  await recordAuditEvent({
    kind: "membership.payment.record",
    restaurantId: id,
    target: { type: "membership_payment", id: created.id },
    summary: `Registró pago de ${fmtCOP(parsed.data.amountCents)} (${parsed.data.method})${parsed.data.note ? ` — ${parsed.data.note}` : ""}`,
    diff: {
      after: {
        amountCents: parsed.data.amountCents,
        method: parsed.data.method,
        periodStart,
        periodEnd,
      },
    },
  });

  return NextResponse.json({ ok: true });
}
