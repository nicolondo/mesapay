import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory"];

const ITEM_INCLUDE = {
  ingredient: {
    select: {
      id: true,
      name: true,
      measureKind: true,
      category: true,
      active: true,
    },
  },
} as const;

/** Sesión completa: cabecera + items con su insumo. La desviación de una
 * sesión cerrada se deriva de los items (counted − expected); el valor en
 * pesos vive en los movimientos count_adjust del libro. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const count = await db.stockCount.findUnique({
    where: { id },
    include: {
      createdBy: { select: { name: true } },
      items: {
        include: ITEM_INCLUDE,
        orderBy: { ingredient: { name: "asc" } },
      },
    },
  });
  if (!count || count.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ count });
}

const patchSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().min(1),
        // Contado en unidad base; 0 es válido ("conté y no hay");
        // null = todavía sin contar.
        countedQty: z.number().int().min(0).max(2_000_000_000).nullable(),
      }),
    )
    .min(1)
    .max(2000),
});

/** Guarda cantidades contadas parciales — el borrador es reanudable. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const count = await db.stockCount.findUnique({
    where: { id },
    select: { restaurantId: true, status: true, items: { select: { id: true } } },
  });
  if (!count || count.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (count.status !== "draft") {
    return NextResponse.json({ error: "already_closed" }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    // Distinguir cantidad inválida (int ≥ 0 o null) de estructura inválida.
    const qtyIssue = parsed.error.issues.some((i) =>
      i.path.includes("countedQty"),
    );
    return NextResponse.json(
      { error: qtyIssue ? "qty_invalid" : "invalid" },
      { status: 400 },
    );
  }

  const owned = new Set(count.items.map((i) => i.id));
  if (parsed.data.items.some((u) => !owned.has(u.itemId))) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  await db.$transaction(
    async (tx) => {
      for (const u of parsed.data.items) {
        await tx.stockCountItem.update({
          where: { id: u.itemId },
          data: { countedQty: u.countedQty },
        });
      }
    },
    // El guardado manda TODOS los items de la sesión; margen sobre el
    // timeout default (5s) para bodegas grandes.
    { timeout: 30_000 },
  );

  return NextResponse.json({ ok: true });
}
