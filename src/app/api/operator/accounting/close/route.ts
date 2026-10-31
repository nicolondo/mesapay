import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { closeMonth, getAccountingConfig, reopenLastMonth } from "@/lib/erp/cierre";
import { MANUAL_LOCK_WAIT_MS, withJournalLock } from "@/lib/erp/autoJournal";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const schema = z.object({
  action: z.enum(["close", "reopen"]),
  // Requerido para close: el mes a cerrar (cierra ese mes y todos los previos).
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

/** Cierre de período: numera comprobantes y fija el candado (o lo retrocede). */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  if (parsed.data.action === "close") {
    if (!parsed.data.month) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    // Con el lock contable: si la corrida diaria (o el botón del Diario)
    // está regenerando este mes, el cierre espera a que termine — si no,
    // numeraría asientos que el motor está por borrar y recrear.
    const month = parsed.data.month;
    const locked = await withJournalLock(
      ctx.restaurantId,
      () => closeMonth(ctx.restaurantId, month),
      { waitMs: MANUAL_LOCK_WAIT_MS, holdMs: 60_000 },
    );
    if (!locked.ok) {
      return NextResponse.json({ error: "busy" }, { status: 409 });
    }
    const r = locked.value;
    if (!r.ok) {
      return NextResponse.json({ error: r.error }, { status: 409 });
    }
    return NextResponse.json(r);
  }

  const r = await reopenLastMonth(ctx.restaurantId);
  if (!r.ok) {
    return NextResponse.json({ error: "nothing_closed" }, { status: 409 });
  }
  return NextResponse.json(r);
}

/** Estado del cierre (para pintar el candado sin cargar el diario). */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const cfg = await getAccountingConfig(ctx.restaurantId);
  return NextResponse.json(cfg);
}

export const POST = secureApi(POSTHandler);

export const GET = secureApi(GETHandler);
