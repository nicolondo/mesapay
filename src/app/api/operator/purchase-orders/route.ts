import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  PurchasingError,
} from "@/lib/erp/purchasing";
import { StockError } from "@/lib/erp/stock";
import type { ModuleSlug } from "@/lib/modules";
import type { PurchaseOrderStatus } from "@prisma/client";
import { PURCHASE_LINE_AMOUNTS_SELECT, purchaseOrderTotals } from "@/lib/erp/purchaseTax";
import { POSSIBLE_DUPLICATE_MODES } from "@/lib/erp/documentNumber";
import {
  assertNotDuplicatePurchase,
  DuplicateDocumentError,
  duplicateDocumentResponse,
} from "@/lib/erp/duplicateDocuments";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

const STATUSES: PurchaseOrderStatus[] = [
  "draft",
  "sent",
  "partially_received",
  "received",
  "canceled",
];

const lineSchema = z.object({
  ingredientId: z.string().min(1),
  supplierItemId: z.string().min(1).nullable().optional(),
  presentations: z.number().int().min(1).max(100_000).nullable().optional(),
  qtyBase: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  expectedCostCents: z.number().int().min(0).max(2_000_000_000),
  // IVA % de la línea (0/5/19 CO, 0/8/16 MX). Default 0.
  taxPct: z.number().int().min(0).max(100).optional(),
  expectedTaxCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  expectedIncCents: z.number().int().min(0).max(2_000_000_000).optional(),
  // Descuento de la línea: % o valor fijo (el % manda si vienen los dos).
  discountPct: z.number().int().min(0).max(100).nullish(),
  discountCents: z.number().int().min(0).max(2_000_000_000).nullish(),
});

const cents = z.number().int().min(0).max(2_000_000_000).optional();

const createSchema = z.object({
  supplierId: z.string().min(1),
  lines: z.array(lineSchema).min(1).max(200),
  // Descuento del pie, sobre el total ya descontado por línea.
  discountPct: z.number().int().min(0).max(100).nullish(),
  discountCents: z.number().int().min(0).max(2_000_000_000).nullish(),
  notes: z.string().trim().max(1000).nullable().optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  // «Ya recibí esta mercancía»: la compra se registra recibida completa, con
  // la factura del proveedor y las retenciones que el comercio le practica.
  receive: z
    .object({
      supplierInvoiceNumber: z.string().trim().max(80).nullable().optional(),
      invoiceDueAt: z.string().datetime().nullable().optional(),
      retefuenteCents: cents,
      reteIvaCents: cents,
      reteIcaCents: cents,
    })
    .optional(),
  // Compra recibida sin número de factura y parecida a otra (proveedor +
  // día + total): "check" pide la advertencia; "allow" guarda igual.
  possibleDuplicate: z.enum(POSSIBLE_DUPLICATE_MODES).optional(),
});

function purchasingErrorResponse(err: PurchasingError) {
  const notFound = ["supplier_not_found", "ingredient_not_found", "po_not_found"];
  return NextResponse.json(
    { error: err.code },
    { status: notFound.includes(err.code) ? 404 : err.code === "wrong_status" ? 409 : 400 },
  );
}

async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const status = STATUSES.includes(statusParam as PurchaseOrderStatus)
    ? (statusParam as PurchaseOrderStatus)
    : undefined;
  // paidAt es un marcador histórico, no prueba del saldo documental actual.
  const unpaid = searchParams.get("unpaid") === "1";
  const cursor = searchParams.get("cursor") ?? undefined;

  const orders = await db.purchaseOrder.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      ...(status ? { status } : {}),
      ...(unpaid ? {
        status: { in: ["received", "partially_received"] },
        OR: [{ paidAt: null }, { incCents: { gt: 0 } }],
      } : {}),
    },
    // Bounded scan: a full page of paid candidates must not hide an older
    // unpaid invoice. The cursor advances over examined candidates only.
    take: unpaid ? 100 : 20,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: unpaid
      ? [{ invoiceDueAt: "asc" }, { id: "asc" }]
      : [{ createdAt: "desc" }],
    include: {
      supplier: { select: { id: true, name: true } },
      items: {
        select: PURCHASE_LINE_AMOUNTS_SELECT,
      },
      _count: { select: { items: true } },
    },
  });
  if (unpaid) {
    const payable = orders.filter((order) => purchaseOrderTotals(order, "received").totalCents > order.paidCents).slice(0, 20);
    const nextCursor = payable.length === 20
      ? payable[19].id
      : orders.length === 100 ? orders[99].id : undefined;
    return NextResponse.json({ orders: payable, nextCursor });
  }
  const nextCursor = orders.length === 20 ? orders[orders.length - 1].id : undefined;
  return NextResponse.json({ orders, nextCursor });
}

async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const session = await auth();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const receive = b.receive;
  // Ajuste del comercio para la recepción: inventario al neto o al bruto.
  const rest = receive
    ? await db.restaurant.findUnique({
        where: { id: ctx.restaurantId },
        select: { purchaseIvaDeductible: true },
      })
    : null;

  try {
    const order = await db.$transaction(
      async (tx) => {
        const created = await createPurchaseOrder(tx, {
          restaurantId: ctx.restaurantId,
          supplierId: b.supplierId,
          lines: b.lines,
          discountPct: b.discountPct,
          discountCents: b.discountCents,
          notes: b.notes ?? null,
          expectedAt: b.expectedAt ? new Date(b.expectedAt) : null,
          createdById: session?.user?.id ?? null,
        });
        if (!receive) return created;
        // Recibida completa, a lo pedido y al costo de la orden (que ES la
        // factura): mismo camino que «Recibir mercancía», con sus retenciones.
        await receivePurchaseOrder(tx, {
          restaurantId: ctx.restaurantId,
          purchaseOrderId: created.id,
          lines: created.items.map((it) => ({
            itemId: it.id,
            qtyBase: it.qtyOrderedBase,
            costCents: it.expectedCostCents,
          })),
          ivaDeductible: rest?.purchaseIvaDeductible ?? false,
          retentions: {
            retefuenteCents: receive.retefuenteCents ?? 0,
            reteIvaCents: receive.reteIvaCents ?? 0,
            reteIcaCents: receive.reteIcaCents ?? 0,
          },
          createdById: session?.user?.id ?? null,
        });
        const updated = await tx.purchaseOrder.update({
          where: { id: created.id },
          data: {
            supplierInvoiceNumber: receive.supplierInvoiceNumber || null,
            ...(receive.invoiceDueAt ? { invoiceDueAt: new Date(receive.invoiceDueAt) } : {}),
          },
        });
        // Es una factura ya recibida: ¿estaba registrada? (bajo candado; si
        // choca, se deshace la compra entera y se responde 409).
        await assertNotDuplicatePurchase(tx, {
          restaurantId: ctx.restaurantId,
          purchaseOrderId: created.id,
          supplierId: b.supplierId,
          number: receive.supplierInvoiceNumber,
          possibleDuplicate: b.possibleDuplicate,
        });
        return updated;
      },
      // Compras grandes (muchas líneas) — margen holgado, como la recepción.
      { timeout: 30_000 },
    );
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateDocumentError) return duplicateDocumentResponse(err);
    if (err instanceof PurchasingError) return purchasingErrorResponse(err);
    if (err instanceof StockError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
