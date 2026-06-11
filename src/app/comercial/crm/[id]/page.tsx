import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { CrmLeadDetailClient } from "./CrmLeadDetailClient";
import { Role } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function CrmLeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/comercial/crm");

  const ctx = await getCrmContext();
  if (!ctx) redirect("/");

  const { id } = await params;
  const t = await getTranslations("crm");

  // Fetch lead with full data.
  const lead = await db.crmLead.findUnique({
    where: { id },
    include: {
      city: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });

  if (!lead) notFound();

  // Scope check: lead must be in visible user ids (or admin).
  if (
    ctx.visibleUserIds !== null &&
    !ctx.visibleUserIds.includes(lead.assignedToUserId)
  ) {
    notFound();
  }

  const now = new Date();
  const [contacts, activities, appointments] = await Promise.all([
    db.crmContact.findMany({
      where: { leadId: id },
      orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
    }),
    db.crmActivity.findMany({
      where: { leadId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    // Upcoming appointments for this lead (status=scheduled, from now forward).
    db.crmAppointment.findMany({
      where: { leadId: id, status: "scheduled", startsAt: { gte: now } },
      orderBy: { startsAt: "asc" },
      take: 10,
    }),
  ]);

  // Team members for reassign sheet (gerente/admin only).
  const [teamMembers, emailAccount] = await Promise.all([
    ctx.role === "gerente_comercial" || ctx.role === "platform_admin"
      ? db.user.findMany({
          where:
            ctx.role === "gerente_comercial"
              ? { managerId: ctx.userId }
              : { role: { in: ["comercial", "gerente_comercial"] as Role[] } },
          select: { id: true, name: true, email: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    db.crmEmailAccount.findUnique({
      where: { userId: ctx.userId },
      select: { verifiedAt: true },
    }),
  ]);

  // Serialise lead for client (Date → string).
  const leadSerialized = {
    id: lead.id,
    name: lead.name,
    countryCode: lead.countryCode,
    stage: lead.stage,
    priority: lead.priority,
    address: lead.address,
    zone: lead.zone,
    businessType: lead.businessType,
    source: lead.source,
    planProposed: lead.planProposed,
    unitsCount: lead.unitsCount,
    notes: lead.notes,
    lostReason: lead.lostReason,
    nextActionAt: lead.nextActionAt?.toISOString() ?? null,
    lastActivityAt: lead.lastActivityAt?.toISOString() ?? null,
    createdAt: lead.createdAt.toISOString(),
    restaurantId: lead.restaurantId ?? null,
    city: lead.city,
    assignedTo: lead.assignedTo,
    createdBy: lead.createdBy
      ? { id: lead.createdBy.id, name: lead.createdBy.name, email: lead.createdBy.email }
      : null,
  };

  const contactsSerialized = contacts.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    phone: c.phone,
    email: c.email,
    isPrimary: c.isPrimary,
    notes: c.notes,
  }));

  const activitiesSerialized = activities.map((a) => ({
    id: a.id,
    type: a.type,
    content: a.content,
    createdAt: a.createdAt.toISOString(),
    user: { id: a.user.id, name: a.user.name, email: a.user.email },
  }));

  const appointmentsSerialized = appointments.map((a) => ({
    id: a.id,
    title: a.title,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    notes: a.notes ?? null,
    status: a.status,
  }));

  const stageLabels: Record<string, string> = {
    nuevo: t("stageNuevo"),
    contactado: t("stageContactado"),
    demo_agendada: t("stageDemoAgendada"),
    demo_realizada: t("stageDemoRealizada"),
    propuesta_enviada: t("stagePropuestaEnviada"),
    negociacion: t("stageNegociacion"),
    ganado: t("stageGanado"),
    perdido: t("stagePerdido"),
  };

  return (
    <CrmLeadDetailClient
      lead={leadSerialized}
      contacts={contactsSerialized}
      activities={activitiesSerialized}
      appointments={appointmentsSerialized}
      teamMembers={teamMembers}
      role={ctx.role}
      userId={ctx.userId}
      countryCode={ctx.countryCode ?? lead.countryCode}
      stageLabels={stageLabels}
      hasEmailAccount={!!emailAccount?.verifiedAt}
    />
  );
}
