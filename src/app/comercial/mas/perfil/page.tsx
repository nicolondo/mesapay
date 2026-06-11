import { redirect } from "next/navigation";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { PerfilClient } from "./PerfilClient";

export const dynamic = "force-dynamic";

export default async function PerfilPage() {
  const ctx = await getCrmContext();
  if (!ctx) redirect("/signin?callbackUrl=/comercial/mas/perfil");

  const user = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { name: true, email: true },
  });
  if (!user) redirect("/comercial/mas");

  return <PerfilClient initialName={user.name ?? ""} email={user.email} />;
}
