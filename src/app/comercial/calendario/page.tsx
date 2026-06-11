import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { bogotaTodayIso, bogotaDayRange, addDaysIso } from "@/lib/bogota";
import { CrmCalendarioClient } from "./CrmCalendarioClient";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function CalendarioPage() {
  const ctx = await getCrmContext();
  if (!ctx) redirect("/signin?callbackUrl=/comercial/calendario");

  // Default: current week (Mon-Sun in Bogota).
  const todayIso = bogotaTodayIso();
  // Find Monday of this week.
  const todayDate = new Date(`${todayIso}T05:00:00Z`); // Bogota midnight
  const dayOfWeek = todayDate.getUTCDay(); // 0=Sun
  const daysToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monIso = addDaysIso(todayIso, daysToMon);
  const sunIso = addDaysIso(monIso, 7); // exclusive

  const { start: weekStart } = bogotaDayRange(monIso);
  const { start: weekEnd } = bogotaDayRange(sunIso);

  const userFilter: Prisma.CrmAppointmentWhereInput =
    ctx.visibleUserIds !== null
      ? { userId: { in: ctx.visibleUserIds } }
      : {};

  const appointments = await db.crmAppointment.findMany({
    where: {
      ...userFilter,
      startsAt: { gte: weekStart, lt: weekEnd },
    },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      notes: true,
      status: true,
      leadId: true,
      userId: true,
      lead: { select: { id: true, name: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  const serialized = appointments.map((a) => ({
    id: a.id,
    title: a.title,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    notes: a.notes ?? null,
    status: a.status,
    leadId: a.leadId,
    lead: a.lead ? { id: a.lead.id, name: a.lead.name } : null,
    user: { id: a.user.id, name: a.user.name, email: a.user.email },
  }));

  return (
    <CrmCalendarioClient
      initialAppointments={serialized}
      initialFrom={weekStart.toISOString()}
      initialTo={weekEnd.toISOString()}
    />
  );
}
