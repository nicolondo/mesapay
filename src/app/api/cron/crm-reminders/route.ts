import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { sendPushToUser } from "@/lib/push";

export const dynamic = "force-dynamic";

/**
 * Cron que busca citas que empiezan en ≤30 minutos y aún no tienen
 * remindedAt seteado, y manda un push al usuario asignado.
 *
 * Protegido por header `x-cron-secret` (mismo patrón que el cron de
 * recordatorios de membresía). Devuelve { reminded: N }.
 *
 * Llamar cada ~5 min via systemd timer o Vercel cron.
 */
export async function GET(req: Request) {
  const secret = req.headers.get("x-cron-secret") ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  // M3: Use timing-safe comparison to prevent timing oracle on the secret.
  // Handle length mismatch by always comparing same-length buffers (pad/truncate).
  let authorized = false;
  if (expected.length > 0 && secret.length > 0) {
    const expectedBuf = Buffer.from(expected);
    const secretBuf = Buffer.from(secret);
    // timingSafeEqual requires same length — pad to max length with zeros.
    const len = Math.max(expectedBuf.length, secretBuf.length);
    const e = Buffer.alloc(len);
    const s = Buffer.alloc(len);
    expectedBuf.copy(e);
    secretBuf.copy(s);
    authorized = timingSafeEqual(e, s) && expectedBuf.length === secretBuf.length;
  }
  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 30 * 60 * 1000); // now + 30min

  // Find appointments starting between now and now+30min
  // that haven't been reminded yet.
  const appointments = await db.crmAppointment.findMany({
    where: {
      status: "scheduled",
      remindedAt: null,
      startsAt: {
        gte: now,
        lte: windowEnd,
      },
    },
    select: {
      id: true,
      title: true,
      startsAt: true,
      userId: true,
      lead: { select: { id: true, name: true } },
    },
  });

  let reminded = 0;

  for (const appt of appointments) {
    // Format time in Bogota (UTC-5) for display in the notification.
    const bogotaTime = new Date(appt.startsAt.getTime() - 5 * 60 * 60 * 1000);
    const hh = String(bogotaTime.getUTCHours()).padStart(2, "0");
    const mm = String(bogotaTime.getUTCMinutes()).padStart(2, "0");
    const timeStr = `${hh}:${mm}`;

    const leadName = appt.lead?.name ?? "";

    const { sent } = await sendPushToUser(appt.userId, {
      title: appt.title,
      body: `${appt.title} con ${leadName} a las ${timeStr}`,
      url: appt.lead ? `/comercial/crm/${appt.lead.id}` : "/comercial/calendario",
      tag: `crm-appt-${appt.id}`,
    });

    // Mark as reminded even if push was not delivered (no subscriptions).
    await db.crmAppointment.update({
      where: { id: appt.id },
      data: { remindedAt: now },
    });

    if (sent > 0) reminded += 1;
  }

  return NextResponse.json({ ok: true, reminded, total: appointments.length });
}
