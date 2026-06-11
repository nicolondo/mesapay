import { redirect } from "next/navigation";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { EmailAccountClient } from "./EmailAccountClient";

export const dynamic = "force-dynamic";

export default async function CorreoPage() {
  const ctx = await getCrmContext();
  if (!ctx) redirect("/signin?callbackUrl=/comercial/mas/correo");

  const account = await db.crmEmailAccount.findUnique({
    where: { userId: ctx.userId },
    select: {
      fromName: true,
      email: true,
      smtpHost: true,
      smtpPort: true,
      smtpUser: true,
      verifiedAt: true,
    },
  });

  return (
    <EmailAccountClient
      initial={
        account
          ? {
              ...account,
              verifiedAt: account.verifiedAt?.toISOString() ?? null,
              hasPassword: true,
            }
          : null
      }
    />
  );
}
