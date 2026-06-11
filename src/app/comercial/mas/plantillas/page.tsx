import { redirect } from "next/navigation";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { PlantillasTabs } from "./PlantillasTabs";

export const dynamic = "force-dynamic";

export default async function PlantillasPage() {
  const ctx = await getCrmContext();
  if (!ctx) redirect("/signin?callbackUrl=/comercial/mas/plantillas");

  const visibleScope = {
    OR: [
      { scope: "global" },
      { scope: "user", ownerUserId: ctx.userId },
    ],
  };

  const [templates, waTemplates, docs] = await Promise.all([
    db.crmEmailTemplate.findMany({
      where: visibleScope,
      orderBy: { createdAt: "desc" },
    }),
    db.crmWhatsappTemplate.findMany({
      where: visibleScope,
      orderBy: { createdAt: "desc" },
    }),
    db.crmDocument.findMany({
      where: visibleScope,
      orderBy: { name: "asc" },
      select: { id: true, name: true, scope: true },
    }),
  ]);

  return (
    <PlantillasTabs
      emailTemplates={templates.map((tpl) => ({
        id: tpl.id,
        name: tpl.name,
        subject: tpl.subject,
        bodyHtml: tpl.bodyHtml,
        attachmentIds: tpl.attachmentIds,
        scope: tpl.scope,
        ownerUserId: tpl.ownerUserId,
      }))}
      waTemplates={waTemplates.map((tpl) => ({
        id: tpl.id,
        name: tpl.name,
        body: tpl.body,
        scope: tpl.scope,
        ownerUserId: tpl.ownerUserId,
      }))}
      docs={docs}
      userId={ctx.userId}
      isAdmin={ctx.role === "platform_admin"}
    />
  );
}
