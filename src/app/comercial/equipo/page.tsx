import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { CrmTeamClient } from "./CrmTeamClient";
import { Role } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function CrmEquipoPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/comercial/equipo");

  const ctx = await getCrmContext();
  if (!ctx) redirect("/");

  // Only gerente or admin.
  if (ctx.role !== "gerente_comercial" && ctx.role !== "platform_admin") {
    redirect("/comercial");
  }

  const t = await getTranslations("crm");

  const where =
    ctx.role === "gerente_comercial"
      ? { managerId: ctx.userId }
      : { role: { in: ["comercial", "gerente_comercial"] as Role[] } };

  const members = await db.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      countryCode: true,
      commissionBps: true,
      disabledAt: true,
      role: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });

  // Lead counts per member.
  const counts = await db.crmLead.groupBy({
    by: ["assignedToUserId"],
    where: { assignedToUserId: { in: members.map((m) => m.id) } },
    _count: { id: true },
  });
  const countMap = Object.fromEntries(counts.map((r) => [r.assignedToUserId, r._count.id]));

  const membersWithCounts = members.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    countryCode: m.countryCode,
    commissionBps: m.commissionBps,
    disabled: m.disabledAt !== null,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
    leadCount: countMap[m.id] ?? 0,
  }));

  return (
    <CrmTeamClient
      initialMembers={membersWithCounts}
      role={ctx.role}
      pageTitle={t("teamTitle")}
    />
  );
}
