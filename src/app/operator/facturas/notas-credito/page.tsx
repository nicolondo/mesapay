import { notFound } from "next/navigation";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { CreditNotesClient } from "./CreditNotesClient";

export const dynamic = "force-dynamic";

export default async function CreditNotesPage() {
  const ctx = await getErpContext(["einvoicing"]);
  if (isDenied(ctx)) notFound();
  return <CreditNotesClient key={ctx.restaurantId} />;
}
