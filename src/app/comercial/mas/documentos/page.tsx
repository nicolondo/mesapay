import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { DocumentsClient } from "./DocumentsClient";

export const dynamic = "force-dynamic";

export default async function DocumentosPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/comercial/mas/documentos");

  const ctx = await getCrmContext();
  if (!ctx) redirect("/");

  const docs = await db.crmDocument.findMany({
    where: {
      OR: [
        { scope: "global" },
        { scope: "user", ownerUserId: ctx.userId },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <DocumentsClient
      initial={docs.map((d) => ({
        id: d.id,
        name: d.name,
        size: d.size,
        mime: d.mime,
        scope: d.scope,
        ownerUserId: d.ownerUserId,
        fileUrl: d.fileUrl,
        createdAt: d.createdAt.toISOString(),
      }))}
      userId={ctx.userId}
      isAdmin={ctx.role === "platform_admin"}
    />
  );
}
