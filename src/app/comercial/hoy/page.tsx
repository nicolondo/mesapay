import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { bogotaTodayIso, bogotaDayRange } from "@/lib/bogota";
import type { Prisma } from "@prisma/client";
import { CrmHoyClient } from "./CrmHoyClient";

export const dynamic = "force-dynamic";

const WAITING_STAGES = [
  "contactado",
  "demo_agendada",
  "demo_realizada",
  "propuesta_enviada",
  "negociacion",
] as const;

const TERMINAL_STAGES = ["ganado", "perdido"] as const;

const LEAD_SELECT = {
  id: true,
  name: true,
  stage: true,
  priority: true,
  lastActivityAt: true,
  nextActionAt: true,
  createdAt: true,
  city: { select: { id: true, name: true } },
  contacts: {
    where: { isPrimary: true },
    select: { id: true, name: true, phone: true },
    take: 1,
  },
} satisfies Prisma.CrmLeadSelect;

export default async function HoyPage() {
  const ctx = await getCrmContext();
  if (!ctx) redirect("/signin?callbackUrl=/comercial/hoy");

  const scopeFilter: Prisma.CrmLeadWhereInput =
    ctx.visibleUserIds !== null
      ? { assignedToUserId: { in: ctx.visibleUserIds } }
      : {};

  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  // Today bounds in Bogota timezone.
  const todayIso = bogotaTodayIso();
  const { start: todayStart, end: todayEnd } = bogotaDayRange(todayIso);

  // ── Fetch all 4 bandejas in parallel ──────────────────────────────────

  const [
    sinContactarList,
    sinContactarCount,
    esperandoList,
    esperandoCount,
    vencidosList,
    vencidosCount,
    citasList,
    citasCount,
    totalLeads,
  ] = await Promise.all([
    // 1. Sin contactar (stage=nuevo, no activities)
    db.crmLead.findMany({
      where: {
        ...scopeFilter,
        stage: "nuevo",
        activities: { none: {} },
      },
      take: 20,
      orderBy: { createdAt: "asc" },
      select: LEAD_SELECT,
    }),
    db.crmLead.count({
      where: {
        ...scopeFilter,
        stage: "nuevo",
        activities: { none: {} },
      },
    }),

    // 2. Esperando respuesta (lastActivityAt < 3d ago, active stages)
    db.crmLead.findMany({
      where: {
        ...scopeFilter,
        stage: { in: [...WAITING_STAGES] },
        lastActivityAt: { lt: threeDaysAgo },
      },
      take: 20,
      orderBy: { lastActivityAt: { sort: "asc", nulls: "first" } },
      select: LEAD_SELECT,
    }),
    db.crmLead.count({
      where: {
        ...scopeFilter,
        stage: { in: [...WAITING_STAGES] },
        lastActivityAt: { lt: threeDaysAgo },
      },
    }),

    // 3. Seguimientos vencidos (nextActionAt <= now, not terminal)
    db.crmLead.findMany({
      where: {
        ...scopeFilter,
        stage: { notIn: [...TERMINAL_STAGES] },
        nextActionAt: { lte: now },
      },
      take: 20,
      orderBy: { nextActionAt: "asc" },
      select: LEAD_SELECT,
    }),
    db.crmLead.count({
      where: {
        ...scopeFilter,
        stage: { notIn: [...TERMINAL_STAGES] },
        nextActionAt: { lte: now },
      },
    }),

    // 4. Citas de hoy
    db.crmAppointment.findMany({
      where: {
        ...(ctx.visibleUserIds !== null
          ? { userId: { in: ctx.visibleUserIds } }
          : {}),
        status: "scheduled",
        startsAt: { gte: todayStart, lt: todayEnd },
      },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        status: true,
        lead: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    db.crmAppointment.count({
      where: {
        ...(ctx.visibleUserIds !== null
          ? { userId: { in: ctx.visibleUserIds } }
          : {}),
        status: "scheduled",
        startsAt: { gte: todayStart, lt: todayEnd },
      },
    }),

    // Total leads (to decide CTA)
    db.crmLead.count({ where: scopeFilter }),
  ]);

  return (
    <CrmHoyClient
      sinContactar={sinContactarList}
      sinContactarCount={sinContactarCount}
      esperando={esperandoList}
      esperandoCount={esperandoCount}
      vencidos={vencidosList}
      vencidosCount={vencidosCount}
      citas={citasList}
      citasCount={citasCount}
      totalLeads={totalLeads}
    />
  );
}
