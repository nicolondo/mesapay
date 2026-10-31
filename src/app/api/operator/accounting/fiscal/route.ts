import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import {
  generateYearClosing,
  loadClosing,
  loadTaxDeclaration,
} from "@/lib/erp/fiscal";
import { MANUAL_LOCK_WAIT_MS, withJournalLock } from "@/lib/erp/autoJournal";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Posición fiscal del mes (impuestos) + estado del cierre del año. */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const year = month.slice(0, 4);
  const [tax, closing] = await Promise.all([
    loadTaxDeclaration(ctx.restaurantId, range),
    loadClosing(ctx.restaurantId, year),
  ]);
  return NextResponse.json({ month, year, tax, closing });
}

/** Genera (o refresca) el asiento de cierre del año `year`. */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const year = searchParams.get("year") ?? "";
  if (!/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // Con el lock contable del comercio: el cierre lee los saldos del año y
  // no puede cruzarse con la corrida diaria ni con un cierre de mes.
  const locked = await withJournalLock(
    ctx.restaurantId,
    () => generateYearClosing(ctx.restaurantId, year),
    { waitMs: MANUAL_LOCK_WAIT_MS, holdMs: 60_000 },
  );
  if (!locked.ok) return NextResponse.json({ error: "busy" }, { status: 409 });
  const result = locked.value;
  if (!result.ok) {
    // El cierre ya es un comprobante numerado y diciembre está cerrado: no
    // se cambia ni se borra. La pantalla explica cómo corregirlo.
    return NextResponse.json(
      { error: result.error, voucherNumber: result.voucherNumber },
      { status: 409 },
    );
  }
  return NextResponse.json({ year, closing: result.closing });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
