import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import type { CrmStage, Prisma } from "@prisma/client";
import { CrmPipelineClient } from "./CrmPipelineClient";

export const dynamic = "force-dynamic";

const STAGES: CrmStage[] = [
  "nuevo",
  "contactado",
  "demo_agendada",
  "demo_realizada",
  "propuesta_enviada",
  "negociacion",
  "ganado",
  "perdido",
];

export default async function CrmPipelinePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/comercial/crm");

  const ctx = await getCrmContext();
  if (!ctx) redirect("/");

  const t = await getTranslations("crm");

  // Scope filter
  const scopeFilter: Prisma.CrmLeadWhereInput =
    ctx.visibleUserIds !== null
      ? { assignedToUserId: { in: ctx.visibleUserIds } }
      : {};

  // Check if any CrmCountry is enabled (to show config hint to admin)
  const enabledCountry = await db.crmCountry.findFirst({
    where: { enabled: true },
    select: { code: true },
  });

  const showConfigHint = !enabledCountry && ctx.role === "platform_admin";

  // Fetch initial page of leads (first 30)
  const initialLeads = await db.crmLead.findMany({
    where: scopeFilter,
    take: 30,
    orderBy: [
      { lastActivityAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
    select: {
      id: true,
      name: true,
      countryCode: true,
      stage: true,
      priority: true,
      lastActivityAt: true,
      nextActionAt: true,
      createdAt: true,
      city: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      contacts: {
        where: { isPrimary: true },
        select: { id: true, name: true, phone: true, email: true },
        take: 1,
      },
    },
  });

  // Stage counts for chips
  const stageCounts: Record<string, number> = {};
  for (const stage of STAGES) {
    stageCounts[stage] = await db.crmLead.count({
      where: { ...scopeFilter, stage },
    });
  }
  const totalCount = Object.values(stageCounts).reduce((a, b) => a + b, 0);

  // If gerente: fetch team members for view selector
  const teamMembers =
    ctx.role === "gerente_comercial"
      ? await db.user.findMany({
          where: { managerId: ctx.userId },
          select: { id: true, name: true, email: true },
          orderBy: { name: "asc" },
        })
      : [];

  // User's countryCode
  const dbUser = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { countryCode: true, name: true },
  });

  const nextCursor =
    initialLeads.length === 30
      ? initialLeads[initialLeads.length - 1].id
      : undefined;

  return (
    <CrmPipelineClient
      initialLeads={initialLeads}
      nextCursor={nextCursor}
      stageCounts={{ total: totalCount, ...stageCounts }}
      role={ctx.role}
      userCountryCode={dbUser?.countryCode ?? null}
      teamMembers={teamMembers}
      showConfigHint={showConfigHint}
      configHintText={t("configureCountries")}
    />
  );
}
