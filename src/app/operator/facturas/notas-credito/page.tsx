import { notFound } from "next/navigation";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { preselectedInvoiceId } from "@/lib/dian/creditNoteLink";
import { CreditNotesClient } from "./CreditNotesClient";

export const dynamic = "force-dynamic";

export default async function CreditNotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getErpContext(["einvoicing"]);
  if (isDenied(ctx)) notFound();
  // "Anular con nota crédito" desde Facturas llega con ?factura=<id>: la
  // pantalla abre directo el ajuste de esa factura (ver creditNoteLink.ts).
  const initialInvoiceId = preselectedInvoiceId(await searchParams);
  return <CreditNotesClient key={ctx.restaurantId} initialInvoiceId={initialInvoiceId} />;
}
