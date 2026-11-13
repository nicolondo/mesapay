import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { findDuplicateCreditNote, loadSupplierCredits } from "@/lib/erp/supplierCreditNoteService";
import { CREDIT_NOTE_GATE } from "@/lib/erp/supplierCreditNoteApi";
import { loadSupplierInvoicesForNote } from "@/lib/erp/supplierCreditNoteQueries";
import { loadSupplierPayables } from "@/lib/erp/supplierPayables";

export const dynamic = "force-dynamic";

/**
 * Lo que el formulario necesita al elegir el proveedor: lo que se le debe
 * (para la vista previa del cruce), su saldo a favor vigente, sus compras
 * (para relacionar facturas y armar una devolución) y, con `number`/`cude`,
 * si esa nota ya está registrada (aviso temprano; el bloqueo real lo hace
 * el POST bajo candado).
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const sp = new URL(req.url).searchParams;
  const supplierId = sp.get("supplierId") ?? "";
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, restaurantId: ctx.restaurantId },
    select: { id: true },
  });
  if (!supplier) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  const number = sp.get("number")?.trim() ?? "";
  const cude = sp.get("cude")?.trim() ?? "";
  const [payables, credits, invoices, duplicate] = await Promise.all([
    loadSupplierPayables(db, ctx.restaurantId, supplier.id),
    loadSupplierCredits(db, ctx.restaurantId, supplier.id),
    sp.get("invoices") === "0" ? Promise.resolve([]) : loadSupplierInvoicesForNote(ctx.restaurantId, supplier.id),
    number || cude
      ? db.$transaction((tx) =>
          findDuplicateCreditNote(tx, {
            restaurantId: ctx.restaurantId,
            supplierId: supplier.id,
            number,
            cude: cude || null,
          }),
        )
      : Promise.resolve(null),
  ]);
  return NextResponse.json({
    payables,
    credits,
    availableCents: credits.reduce((s, c) => s + c.availableCents, 0),
    invoices,
    duplicate,
  });
}

export const GET = secureApi(GETHandler);
