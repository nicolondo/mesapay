import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { InvoiceAliasError, rememberInvoiceAliases } from "@/lib/erp/invoiceAliases";
import { discountsReproduceNet } from "@/lib/erp/purchaseDiscount";
import { ROUNDING_MAX_CENTS } from "@/lib/erp/invoiceReconcile";
import { lineTaxCents } from "@/lib/erp/purchaseTax";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  PurchasingError,
  type CreatePoLine,
} from "@/lib/erp/purchasing";
import type { ModuleSlug } from "@/lib/modules";
import { POSSIBLE_DUPLICATE_MODES } from "@/lib/erp/documentNumber";
import {
  assertNotDuplicatePurchase,
  DuplicateDocumentError,
  duplicateDocumentResponse,
} from "@/lib/erp/duplicateDocuments";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

// El cliente manda la revisión final: proveedor (existente o nuevo) y
// las líneas ya resueltas (insumo existente o nuevo, cantidad base,
// costo). El server crea lo que sea nuevo, la OC y — si mode=receive —
// la recepción, todo en una sola transacción.
const lineSchema = z.object({
  ingredientId: z.string().min(1).nullable(), // null ⇒ crear insumo nuevo
  newIngredientName: z.string().trim().min(1).max(120).nullable().optional(),
  newIngredientMeasureKind: z.enum(["mass", "volume", "count"]).optional(),
  qtyBase: z.number().int().min(1).max(2_000_000_000),
  // Neto TOTAL sin impuestos; IVA documental y consumo no son unitarios.
  expectedCostCents: z.number().int().min(0).max(2_000_000_000),
  taxPct: z.number().int().min(0).max(100).optional(),
  expectedTaxCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  expectedIncCents: z.number().int().min(0).max(2_000_000_000).optional(),
  sourceLineIndex: z.number().int().min(0).optional(),
  rememberMatch: z.boolean().optional(),
  // Descuento del proveedor (#393): neto de LISTA antes de descuentos y el
  // descuento de la línea (% o valor). expectedCostCents sigue siendo el
  // neto revisado; estos solo dicen cómo se llegó a él y se verifican.
  listCostCents: z.number().int().min(0).max(2_000_000_000).optional(),
  discountPct: z.number().int().min(0).max(100).nullish(),
  discountCents: z.number().int().min(0).max(2_000_000_000).nullish(),
});

const cents = z.number().int().min(0).max(2_000_000_000).optional();
const confirmSchema = z.object({
  supplierId: z.string().min(1).nullable(), // null ⇒ crear proveedor nuevo
  newSupplierName: z.string().trim().min(1).max(120).nullable().optional(),
  newSupplierNit: z.string().trim().max(40).nullable().optional(),
  lines: z.array(lineSchema).min(1).max(200),
  mode: z.enum(["draft", "receive"]),
  supplierInvoiceNumber: z.string().trim().max(80).nullable().optional(),
  invoiceDueAt: z.string().datetime().nullable().optional(),
  // Impuestos de la factura verificados por el operador (ERP A3). El IVA sale
  // de las líneas (taxPct); estos se guardan en la OC para la contabilidad.
  incCents: cents,
  retefuenteCents: cents,
  reteIvaCents: cents,
  reteIcaCents: cents,
  // Descuento sobre el total de la factura, prorrateado entre las líneas.
  discountPct: z.number().int().min(0).max(100).nullish(),
  discountCents: z.number().int().min(0).max(2_000_000_000).nullish(),
  // «Ajustes» / ajuste al peso de la factura, con signo: solo un redondeo.
  roundingCents: z.number().int().min(-ROUNDING_MAX_CENTS).max(ROUNDING_MAX_CENTS).optional(),
  // El operador vio el resumen «Factura vs MESAPAY» con diferencias y decidió guardar así.
  acknowledgedDifferences: z.boolean().optional(),
  // Factura sin número parecida a otra (proveedor + día + total): "check"
  // pide la advertencia; "allow" = el operador la vio y guarda igual.
  possibleDuplicate: z.enum(POSSIBLE_DUPLICATE_MODES).optional(),
});

/** Total impreso que la lectura guardó en la carga (null si no se leyó). */
function printedTotalCents(extraction: unknown): number | null {
  const value = (extraction as { invoiceTotalCents?: unknown } | null)?.invoiceTotalCents;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const parsed = confirmSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const allocatedIncCents = b.lines.reduce((sum, line) => sum + (line.expectedIncCents ?? 0), 0);
  const invoiceIncCents = b.incCents ?? allocatedIncCents;
  // Every new documentary consumption must reach its stock/expense line.
  // Header-only legacy amounts remain readable, but are not created here.
  if (invoiceIncCents !== allocatedIncCents || invoiceIncCents > 2_000_000_000) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // Discounts never transform the reviewed net. They are accepted only when
  // list − line discount − share of the total discount reproduces it exactly
  // (same proration as purchase orders), so nothing is discounted twice.
  const orderDiscount = { pct: b.discountPct ?? null, cents: b.discountCents ?? null };
  const discountLines = b.lines.map((line) => ({
    netCents: line.expectedCostCents,
    listCents: line.listCostCents ?? line.expectedCostCents,
    discount: { pct: line.discountPct ?? null, cents: line.discountCents ?? null },
  }));
  if (!discountsReproduceNet(discountLines, orderDiscount)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const upload = await db.purchaseInvoiceUpload.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, status: true, extraction: true },
  });
  if (!upload || upload.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (upload.status !== "pending") {
    return NextResponse.json({ error: "not_pending" }, { status: 409 });
  }
  // Lo que queda por pagar debe ser el Total impreso de la factura. Si no lo
  // es, solo se guarda con la confirmación explícita del operador (la
  // revisión le mostró la diferencia renglón por renglón). Se exige DENTRO de
  // la transacción, después de validar proveedor e insumos: un error de
  // validación o de otro comercio (400) nunca queda tapado por este 409.
  const printedTotal = printedTotalCents(upload.extraction);
  const payableCents = b.lines.reduce((sum, line) => sum + line.expectedCostCents
    + (line.expectedTaxCents ?? lineTaxCents(line.expectedCostCents, line.taxPct ?? 0)), 0)
    + invoiceIncCents - (b.retefuenteCents ?? 0) - (b.reteIvaCents ?? 0) - (b.reteIcaCents ?? 0)
    + (b.roundingCents ?? 0);
  const totalsUnconfirmed = printedTotal != null && payableCents !== printedTotal && b.acknowledgedDifferences !== true;
  const session = await auth();
  const createdById = session?.user?.id ?? null;
  // Ajuste del comercio para valorar el inventario al recibir (neto/bruto).
  const rest = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { purchaseIvaDeductible: true },
  });

  try {
    const order = await db.$transaction(async (tx) => {
      // Claim inside the transaction: concurrent retries must not create another
      // order or receive the same invoice twice. Failed validation rolls this back.
      const claimed = await tx.purchaseInvoiceUpload.updateMany({
        where: { id, restaurantId: ctx.restaurantId, status: "pending" },
        data: { status: "confirming" },
      });
      if (claimed.count !== 1) throw new PurchasingError("not_pending");

      // 1. Proveedor (existente o nuevo).
      let supplierId = b.supplierId;
      if (!supplierId) {
        if (!b.newSupplierName) throw new PurchasingError("supplier_not_found");
        const created = await tx.supplier.create({
          data: {
            restaurantId: ctx.restaurantId,
            name: b.newSupplierName,
            taxId: b.newSupplierNit || null,
          },
          select: { id: true },
        });
        supplierId = created.id;
      } else {
        const s = await tx.supplier.findUnique({
          where: { id: supplierId },
          select: { restaurantId: true },
        });
        if (s?.restaurantId !== ctx.restaurantId) {
          throw new PurchasingError("supplier_not_found");
        }
      }

      await rememberInvoiceAliases(tx, {
        restaurantId: ctx.restaurantId, uploadId: id, supplierId, lines: b.lines,
      });

      // 2. Insumos nuevos + líneas de la OC (cantidad en unidad base).
      const poLines: CreatePoLine[] = [];
      for (const line of b.lines) {
        let ingredientId = line.ingredientId;
        if (!ingredientId) {
          if (!line.newIngredientName) {
            throw new PurchasingError("ingredient_not_found");
          }
          const created = await tx.ingredient.create({
            data: {
              restaurantId: ctx.restaurantId,
              name: line.newIngredientName,
              measureKind: line.newIngredientMeasureKind ?? "count",
            },
            select: { id: true },
          });
          ingredientId = created.id;
        } else {
          const ing = await tx.ingredient.findUnique({
            where: { id: ingredientId },
            select: { restaurantId: true },
          });
          if (ing?.restaurantId !== ctx.restaurantId) {
            throw new PurchasingError("ingredient_not_found");
          }
        }
        poLines.push({
          ingredientId,
          qtyBase: line.qtyBase,
          // createPurchaseOrder recibe la LISTA y aplica los descuentos con
          // resolveOrderDiscounts: llega al neto ya verificado arriba.
          expectedCostCents: line.listCostCents ?? line.expectedCostCents,
          discountPct: line.discountPct ?? null,
          discountCents: line.discountCents ?? null,
          taxPct: line.taxPct,
          expectedTaxCents: line.expectedTaxCents,
          expectedIncCents: line.expectedIncCents,
        });
      }

      // 2b. Con todo validado: el total a pagar ≠ Total impreso exige la
      // confirmación explícita. Revierte también lo creado arriba.
      if (totalsUnconfirmed) throw new PurchasingError("totals_unconfirmed");

      // 3. La OC (reusa A2).
      const po = await createPurchaseOrder(tx, {
        restaurantId: ctx.restaurantId,
        supplierId,
        lines: poLines,
        discountPct: orderDiscount.pct,
        discountCents: orderDiscount.cents,
        notes: b.supplierInvoiceNumber
          ? `Factura ${b.supplierInvoiceNumber}`
          : null,
        createdById,
      });

      // 3b. Impuestos de la factura (además del IVA de las líneas) → OC, para
      // la contabilidad/reportes. Se guardan igual en draft o receive.
      if (
        invoiceIncCents ||
        b.retefuenteCents ||
        b.reteIvaCents ||
        b.reteIcaCents ||
        b.roundingCents
      ) {
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: {
            incCents: invoiceIncCents,
            retefuenteCents: b.retefuenteCents ?? 0,
            reteIvaCents: b.reteIvaCents ?? 0,
            reteIcaCents: b.reteIcaCents ?? 0,
            // Ajuste al peso: a la CxP, no a las líneas (purchaseOrderTotals).
            roundingCents: b.roundingCents ?? 0,
          },
        });
      }

      // 4. Recepción (si la factura = mercancía recibida).
      if (b.mode === "receive") {
        const withItems = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id: po.id },
          select: {
            items: {
              select: { id: true, ingredientId: true, qtyOrderedBase: true, expectedCostCents: true },
            },
          },
        });
        await receivePurchaseOrder(tx, {
          restaurantId: ctx.restaurantId,
          purchaseOrderId: po.id,
          lines: withItems.items.map((it) => ({
            itemId: it.id,
            qtyBase: it.qtyOrderedBase,
            costCents: it.expectedCostCents,
          })),
          ivaDeductible: rest?.purchaseIvaDeductible ?? false,
          createdById,
        });
        // CxP: número de factura del proveedor + vencimiento.
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: {
            supplierInvoiceNumber: b.supplierInvoiceNumber || null,
            ...(b.invoiceDueAt ? { invoiceDueAt: new Date(b.invoiceDueAt) } : {}),
          },
        });
      }

      // 4b. El número de la factura también en el borrador (antes sólo iba en
      // las notas): sin él, la misma factura se podía cargar dos veces.
      if (b.mode === "draft" && b.supplierInvoiceNumber) {
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { supplierInvoiceNumber: b.supplierInvoiceNumber },
        });
      }
      // 4c. ¿Ya estaba registrada? Bajo candado y después de escribir: si
      // choca, se deshace todo (la carga sigue pendiente) y se responde 409.
      await assertNotDuplicatePurchase(tx, {
        restaurantId: ctx.restaurantId,
        purchaseOrderId: po.id,
        supplierId,
        number: b.supplierInvoiceNumber,
        possibleDuplicate: b.possibleDuplicate,
      });

      // 5. Marcar la carga confirmada, ligada a la OC.
      await tx.purchaseInvoiceUpload.update({
        where: { id },
        data: { status: "confirmed", purchaseOrderId: po.id },
      });
      return po;
    });

    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateDocumentError) return duplicateDocumentResponse(err);
    if (err instanceof InvoiceAliasError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    if (err instanceof PurchasingError) {
      const conflict = err.code === "not_pending" || err.code === "totals_unconfirmed";
      return NextResponse.json({ error: err.code }, { status: conflict ? 409 : 400 });
    }
    throw err;
  }
}

export const POST = secureApi(POSTHandler);
