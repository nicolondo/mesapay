import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import { getAccountingConfig, isMonthClosed } from "@/lib/erp/cierre";
import { loadJournalForMonth } from "@/lib/erp/posting";
import {
  MANUAL_LOCK_HOLD_MS,
  MANUAL_LOCK_WAIT_MS,
  lastEngineUpdateAt,
  regenerateMonth,
  withJournalLock,
} from "@/lib/erp/autoJournal";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Libro Diario del mes: asientos-resumen ya generados. */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  if (!monthRange(month)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const [entries, cfg, lastGeneratedAt] = await Promise.all([
    loadJournalForMonth(ctx.restaurantId, month),
    getAccountingConfig(ctx.restaurantId),
    lastEngineUpdateAt(ctx.restaurantId, month),
  ]);
  return NextResponse.json({
    month,
    entries,
    closedThrough: cfg.closedThrough,
    monthClosed: isMonthClosed(cfg.closedThrough, month),
    // Última corrida del motor en el mes (botón o corrida diaria).
    lastGeneratedAt: lastGeneratedAt?.toISOString() ?? null,
  });
}

/**
 * Genera (o refresca) ya los asientos-resumen del mes. Los meses abiertos
 * también se regeneran solos cada día (cron accounting-daily); este botón
 * comparte el paso (`regenerateMonth`) y el lock por comercio con esa
 * corrida, así que no se pisan: si la corrida está en curso, espera hasta
 * 20 s y si no, responde `busy`.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  if (!monthRange(month)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const restaurantId = ctx.restaurantId;
  const locked = await withJournalLock(
    restaurantId,
    async () => {
      // Candado de cierre: un mes cerrado tiene comprobantes numerados en
      // firme — no se regenera. Reabrir primero (Diario → Reabrir último mes).
      // Se lee dentro del lock: el cierre también lo toma.
      const cfg = await getAccountingConfig(restaurantId);
      return { cfg, outcome: await regenerateMonth(restaurantId, month, cfg.closedThrough) };
    },
    { waitMs: MANUAL_LOCK_WAIT_MS, holdMs: MANUAL_LOCK_HOLD_MS },
  );
  if (!locked.ok) {
    return NextResponse.json({ error: "busy" }, { status: 409 });
  }
  const { cfg, outcome } = locked.value;
  if (outcome.status === "closed") {
    return NextResponse.json(
      { error: "month_closed", closedThrough: cfg.closedThrough },
      { status: 409 },
    );
  }
  if (outcome.status !== "ok") {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const [entries, lastGeneratedAt] = await Promise.all([
    loadJournalForMonth(restaurantId, month),
    lastEngineUpdateAt(restaurantId, month),
  ]);
  return NextResponse.json({
    month,
    results: outcome.results,
    entries,
    lastGeneratedAt: lastGeneratedAt?.toISOString() ?? null,
  });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
