import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  createPurchaseOrder,
  PurchasingError,
} from "@/lib/erp/purchasing";
import type { ModuleSlug } from "@/lib/modules";
import type { PurchaseOrderStatus } from "@prisma/client";

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
});

const createSchema = z.object({
  supplierId: z.string().min(1),
  lines: z.array(lineSchema).min(1).max(200),
  notes: z.string().trim().max(1000).nullable().optional(),
  expectedAt: z.string().datetime().nullable().optional(),
});

function purchasingErrorResponse(err: PurchasingError) {
  const notFound = ["supplier_not_found", "ingredient_not_found", "po_not_found"];
  return NextResponse.json(
    { error: err.code },
    { status: notFound.includes(err.code) ? 404 : err.code === "wrong_status" ? 409 : 400 },
  );
}

export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const status = STATUSES.includes(statusParam as PurchaseOrderStatus)
    ? (statusParam as PurchaseOrderStatus)
    : undefined;
  // "Por pagar": recibidas con factura sin pagar.
  const unpaid = searchParams.get("unpaid") === "1";
  const cursor = searchParams.get("cursor") ?? undefined;

  const orders = await db.purchaseOrder.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      ...(status ? { status } : {}),
      ...(unpaid ? { status: "received", paidAt: null } : {}),
    },
    take: 20,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: unpaid
      ? [{ invoiceDueAt: "asc" }]
      : [{ createdAt: "desc" }],
    include: {
      supplier: { select: { id: true, name: true } },
      items: { select: { expectedCostCents: true, receivedCostCents: true } },
      _count: { select: { items: true } },
    },
  });
  const nextCursor = orders.length === 20 ? orders[orders.length - 1].id : undefined;
  return NextResponse.json({ orders, nextCursor });
}

export async function POST(req: Request) {
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

  try {
    const order = await db.$transaction((tx) =>
      createPurchaseOrder(tx, {
        restaurantId: ctx.restaurantId,
        supplierId: b.supplierId,
        lines: b.lines,
        notes: b.notes ?? null,
        expectedAt: b.expectedAt ? new Date(b.expectedAt) : null,
        createdById: session?.user?.id ?? null,
      }),
    );
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    if (err instanceof PurchasingError) return purchasingErrorResponse(err);
    throw err;
  }
}
