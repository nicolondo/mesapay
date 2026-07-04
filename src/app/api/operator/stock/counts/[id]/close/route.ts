import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { applyStockMovement } from "@/lib/erp/stock";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory"];

/**
 * Cierre de conteo (spec D5): genera un count_adjust por cada item contado
 * con diferencia ≠ 0 y sella la sesión — todo en UNA transacción.
 *
 * Sutileza importante: el ajuste es `countedQty − expectedQty` contra el
 * SNAPSHOT congelado al crear la sesión, NO contra el stock vivo. Si hubo
 * ventas/movimientos mientras se contaba, esa deriva es parte de la
 * desviación que el conteo reporta (D5: el teórico no se mueve bajo los
 * pies del que cuenta). Items con countedQty null se SALTAN: "sin contar"
 * no es lo mismo que "conté cero".
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const session = await auth();
  const { id } = await params;

  const count = await db.stockCount.findUnique({
    where: { id },
    select: { restaurantId: true, status: true },
  });
  if (!count || count.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (count.status !== "draft") {
    return NextResponse.json({ error: "already_closed" }, { status: 409 });
  }

  const createdById = session?.user?.id ?? null;

  const adjustments = await db.$transaction(
    async (tx) => {
      // Reclamar el cierre primero (updateMany condicionado al estado) para
      // que dos cierres concurrentes no dupliquen ajustes: el segundo no
      // encuentra el draft y aborta. Los items se leen DESPUÉS del claim,
      // dentro de la tx, para no cerrar con digitaciones stale.
      const claimed = await tx.stockCount.updateMany({
        where: { id, status: "draft" },
        data: { status: "closed", closedAt: new Date() },
      });
      if (claimed.count === 0) return null;

      const items = await tx.stockCountItem.findMany({
        where: { countId: id },
        select: { ingredientId: true, expectedQty: true, countedQty: true },
      });

      let n = 0;
      for (const item of items) {
        if (item.countedQty == null) continue; // sin contar ≠ cero
        // El ajuste es contra el SNAPSHOT congelado (expectedQty), no
        // contra el stock vivo — ver doc del handler.
        const diff = item.countedQty - item.expectedQty;
        if (diff === 0) continue;
        // allowInactive: el insumo pudo desactivarse con la sesión abierta;
        // su saldo igual debe cuadrarse.
        await applyStockMovement(
          tx,
          {
            restaurantId: ctx.restaurantId,
            ingredientId: item.ingredientId,
            kind: "count_adjust",
            qtyBase: diff,
            note: null,
            stockCountId: id,
            createdById,
          },
          { allowInactive: true },
        );
        n++;
      }
      return n;
    },
    // Una bodega grande puede generar cientos de ajustes secuenciales:
    // margen holgado sobre el timeout default (5s) de Prisma.
    { timeout: 30_000 },
  );

  if (adjustments === null) {
    return NextResponse.json({ error: "already_closed" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, adjustments });
}
