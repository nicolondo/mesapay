import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { createDeferredItem } from "@/lib/erp/deferred";
import { listDeferredItems, loadDeferredFormOptions } from "@/lib/erp/deferredQuery";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Diferidos del comercio con su progreso al mes en curso, más las cuentas
 * sugeridas para el formulario (origen 11xx, puente 17xx/27xx, destino
 * 4xx/5xx/6xx imputables activas) y los centros de costos activos.
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [items, options] = await Promise.all([
    listDeferredItems(ctx.restaurantId),
    loadDeferredFormOptions(ctx.restaurantId),
  ]);
  return NextResponse.json({ items, ...options });
}

// La forma la valida zod; las reglas de negocio (prefijos, mes cerrado,
// cuentas imputables) las devuelve `createDeferredItem` con su código.
const bodySchema = z.object({
  name: z.string().max(500),
  kind: z.enum(["expense", "income"]),
  totalCents: z.number().int(),
  startDate: z.string().max(10),
  months: z.number().int(),
  sourceAccountCode: z.string().max(20),
  deferralAccountCode: z.string().max(20),
  targetAccountCode: z.string().max(20),
  costCenterId: z.string().max(64).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

/** Alta con asiento inicial. 400 con el código de validación; 409 si el mes de inicio está cerrado. */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const r = await createDeferredItem({
    restaurantId: ctx.restaurantId,
    actorId: ctx.userId,
    input: parsed.data,
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      { status: r.error === "period_closed" ? 409 : 400 },
    );
  }
  return NextResponse.json({ ok: true, id: r.item.id, entryId: r.entryId }, { status: 201 });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
