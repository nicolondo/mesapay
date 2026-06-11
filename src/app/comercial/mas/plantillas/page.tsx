import { redirect } from "next/navigation";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { TemplatesClient } from "./TemplatesClient";

export const dynamic = "force-dynamic";

export default async function PlantillasPage() {
  const ctx = await getCrmContext();
  if (!ctx) redirect("/signin?callbackUrl=/comercial/mas/plantillas");

  const [templates, docs] = await Promise.all([
    db.crmEmailTemplate.findMany({
      where: {
        OR: [
          { scope: "global" },
          { scope: "user", ownerUserId: ctx.userId },
        ],
      },
      orderBy: { createdAt: "desc" },
    }),
    db.crmDocument.findMany({
      where: {
        OR: [
          { scope: "global" },
          { scope: "user", ownerUserId: ctx.userId },
        ],
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, scope: true },
    }),
  ]);

  return (
    <TemplatesClient
      initial={templates.map((tpl) => ({
        id: tpl.id,
        name: tpl.name,
        subject: tpl.subject,
        bodyHtml: tpl.bodyHtml,
        attachmentIds: tpl.attachmentIds,
        scope: tpl.scope,
        ownerUserId: tpl.ownerUserId,
      }))}
      docs={docs}
      userId={ctx.userId}
      isAdmin={ctx.role === "platform_admin"}
    />
  );
}
