import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  PurchasingError,
  type CreatePoLine,
} from "@/lib/erp/purchasing";
import type { ModuleSlug } from "@/lib/modules";

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
  // NETO (sin IVA) de la línea; el IVA se deriva con taxPct.
  expectedCostCents: z.number().int().min(0).max(2_000_000_000),
  taxPct: z.number().int().min(0).max(100).optional(),
});

const confirmSchema = z.object({
  supplierId: z.string().min(1).nullable(), // null ⇒ crear proveedor nuevo
  newSupplierName: z.string().trim().min(1).max(120).nullable().optional(),
  newSupplierNit: z.string().trim().max(40).nullable().optional(),
  lines: z.array(lineSchema).min(1).max(200),
  mode: z.enum(["draft", "receive"]),
  supplierInvoiceNumber: z.string().trim().max(80).nullable().optional(),
  invoiceDueAt: z.string().datetime().nullable().optional(),
});

export async function POST(
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

  const upload = await db.purchaseInvoiceUpload.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, status: true },
  });
  if (!upload || upload.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (upload.status !== "pending") {
    return NextResponse.json({ error: "not_pending" }, { status: 409 });
  }
  const session = await auth();
  const createdById = session?.user?.id ?? null;
  // Ajuste del comercio para valorar el inventario al recibir (neto/bruto).
  const rest = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { purchaseIvaDeductible: true },
  });

  try {
    const order = await db.$transaction(async (tx) => {
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
          expectedCostCents: line.expectedCostCents,
          taxPct: line.taxPct,
        });
      }

      // 3. La OC (reusa A2).
      const po = await createPurchaseOrder(tx, {
        restaurantId: ctx.restaurantId,
        supplierId,
        lines: poLines,
        notes: b.supplierInvoiceNumber
          ? `Factura ${b.supplierInvoiceNumber}`
          : null,
        createdById,
      });

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

      // 5. Marcar la carga confirmada, ligada a la OC.
      await tx.purchaseInvoiceUpload.update({
        where: { id },
        data: { status: "confirmed", purchaseOrderId: po.id },
      });
      return po;
    });

    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    if (err instanceof PurchasingError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
}
