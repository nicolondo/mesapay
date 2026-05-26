import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { renderMembershipReminderEmail, sendEmail } from "@/lib/mailer";
import { recordAuditEvent } from "@/lib/auditLog";
import { getPlanCatalog } from "@/lib/planCatalog";

export const dynamic = "force-dynamic";

/**
 * Cron diario que mira el `periodEndsAt` de cada comercio y manda
 * recordatorios + auto-suspende vencidos pasados el periodo de
 * gracia.
 *
 * Umbrales (calculados sobre daysFromEnd = ceil((periodEndsAt - now) / 1d)):
 *
 *   +7d antes ............... "T-7"      heads-up suave
 *   +3d antes ............... "T-3"      recordatorio firme
 *    0d (vence hoy) ......... "T-0"      urgente
 *   -1d a -GRACE_DAYS ....... "overdue"  vencido, en periodo de gracia
 *   -GRACE_DAYS (-7d) ....... "suspended" + auto-suspend + email final
 *
 * Idempotencia: usamos `lastReminderKind` + `lastReminderSentAt`
 * para no re-mandar el mismo umbral. Si pasamos a un umbral nuevo,
 * mandamos. Si seguimos en el mismo umbral pero ya pasó >= 7 días
 * desde el último envío, también re-mandamos (caso edge — período
 * largo en estado vencido sin renovar).
 *
 * Sólo aplica a comercios con plan != "trial" — los trials no
 * tienen mensualidad ni vencimiento de pago. Y omite los ya
 * suspendidos (su email ya se mandó cuando se suspendieron).
 *
 * Protegido por header `x-cron-secret`. Devuelve un resumen JSON
 * con qué hizo (count por umbral) para que el systemd timer lo
 * loggee.
 */

const GRACE_DAYS = 7;
const RESEND_THRESHOLD_DAYS = 7;

type ReminderKind = "T-7" | "T-3" | "T-0" | "overdue" | "suspended";

export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  // Trabajamos en días enteros. Truncamos `now` a medianoche local
  // (Bogotá UTC-5) para que el cálculo de daysFromEnd sea estable
  // independiente de la hora exacta a la que corra el cron.
  const todayMs = Math.floor(now.getTime() / 86400000) * 86400000;
  const today = new Date(todayMs);

  const planCatalog = await getPlanCatalog();
  const planName = (tier: string) =>
    planCatalog.find((p) => p.tier === tier)?.name ?? tier;

  // Comercios candidatos:
  //   - plan != trial
  //   - tienen periodEndsAt
  //   - no están ya en el estado terminal (suspended con email mandado)
  // Filtramos suspended aparte porque queremos que el "overdue" siga
  // mandándose hasta que se suspenda, no antes.
  const candidates = await db.restaurant.findMany({
    where: {
      plan: { not: "trial" },
      periodEndsAt: { not: null },
    },
    include: {
      // Para mandar el recordatorio buscamos un operator/admin con
      // email. Si hay varios, primero el platform_admin (raro pero
      // posible), si no el operator más viejo.
      users: {
        where: {
          role: { in: ["operator", "platform_admin"] },
        },
        select: { email: true, name: true, role: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const result = {
    examined: candidates.length,
    sent: 0,
    suspended: 0,
    skipped: 0,
    byKind: {} as Record<ReminderKind, number>,
  };

  for (const rest of candidates) {
    if (!rest.periodEndsAt) {
      result.skipped += 1;
      continue;
    }
    const endsAtDay =
      Math.floor(rest.periodEndsAt.getTime() / 86400000) * 86400000;
    const daysFromEnd = Math.round(
      (endsAtDay - today.getTime()) / 86400000,
    );

    let kind: ReminderKind | null = null;
    let shouldSuspend = false;

    if (rest.suspended) {
      // Ya está suspendido. No re-mandamos.
      result.skipped += 1;
      continue;
    }

    // Mapeo umbrales (más urgente primero — si daysFromEnd encaja
    // en varios, ganan los negativos).
    if (daysFromEnd <= -GRACE_DAYS) {
      kind = "suspended";
      shouldSuspend = true;
    } else if (daysFromEnd < 0) {
      kind = "overdue";
    } else if (daysFromEnd === 0) {
      kind = "T-0";
    } else if (daysFromEnd === 3) {
      kind = "T-3";
    } else if (daysFromEnd === 7) {
      kind = "T-7";
    } else {
      // Días intermedios (1, 2, 4, 5, 6, 8+) — no se manda nada.
      result.skipped += 1;
      continue;
    }

    // Anti-spam: si ya mandamos este mismo kind hace < RESEND_THRESHOLD
    // días, skip. La excepción es "suspended" — si llegó a este
    // umbral y no está suspendido todavía, hay que suspender ya.
    if (
      kind !== "suspended" &&
      rest.lastReminderKind === kind &&
      rest.lastReminderSentAt &&
      now.getTime() - rest.lastReminderSentAt.getTime() <
        RESEND_THRESHOLD_DAYS * 86400000
    ) {
      result.skipped += 1;
      continue;
    }

    // Email destinatario.
    const target = rest.users[0]?.email;
    if (!target) {
      result.skipped += 1;
      continue;
    }

    const { subject, html, text } = renderMembershipReminderEmail({
      kind,
      restaurantName: rest.name,
      planName: planName(rest.plan),
      monthlyPriceCop: Math.round(rest.monthlyPriceCents / 100),
      periodEndsAt: rest.periodEndsAt,
      daysFromEnd,
    });

    const sent = await sendEmail({ to: target, subject, html, text });
    if (sent) {
      result.sent += 1;
      result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
    }

    // Aún si el email falla, marcamos el intento — el siguiente run
    // re-intentará (porque el RESEND_THRESHOLD se cumple). Pero si
    // shouldSuspend, suspendemos aunque el email falle (el operador
    // se enterará por otros medios — la app deja de funcionar).
    await db.restaurant.update({
      where: { id: rest.id },
      data: {
        lastReminderSentAt: now,
        lastReminderKind: kind,
        ...(shouldSuspend && { suspended: true }),
      },
    });

    if (shouldSuspend) {
      result.suspended += 1;
      await recordAuditEvent({
        kind: "membership.suspend",
        restaurantId: rest.id,
        target: { type: "restaurant", id: rest.id },
        summary: `Auto-suspendido por cron (${Math.abs(daysFromEnd)}d vencido, >= ${GRACE_DAYS}d de gracia)`,
        actor: {
          userId: null,
          email: "cron@mesapay",
          role: "system",
        },
      });
    }
  }

  return NextResponse.json({ ok: true, ...result });
}
