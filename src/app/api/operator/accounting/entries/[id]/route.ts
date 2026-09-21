import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  deleteManualEntry,
  updateManualEntry,
  type MutationError,
} from "@/lib/erp/journalManual";
import { manualEntryBodySchema } from "@/lib/erp/journalManualSchema";
import { loadEntryDetail } from "@/lib/erp/journalQuery";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

type Params = { params: Promise<{ id: string }> };

/** 404 si no existe; 409 si la regla de negocio no aplica; 400 si no valida. */
function statusFor(error: MutationError): number {
  switch (error) {
    case "not_found":
      return 404;
    case "not_manual":
    case "period_closed":
    case "already_annulled":
    case "is_reversal":
      return 409;
    default:
      return 400;
  }
}

/** Comprobante con líneas, nombres de cuenta/centro, cuadre y permisos. */
async function GETHandler(_req: Request, { params }: Params) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const entry = await loadEntryDetail(ctx.restaurantId, id);
  if (!entry) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ entry });
}

/** Reemplaza cabecera y líneas de un comprobante MANUAL con el mes abierto. */
async function PUTHandler(req: Request, { params }: Params) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const parsed = manualEntryBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const r = await updateManualEntry({
    restaurantId: ctx.restaurantId,
    entryId: id,
    input: parsed.data,
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, ...(r.line != null && { line: r.line }) },
      { status: statusFor(r.error) },
    );
  }
  return NextResponse.json({ ok: true, entry: r.entry });
}

/** Borra un comprobante MANUAL con el mes abierto (mes cerrado → reversar). */
async function DELETEHandler(_req: Request, { params }: Params) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const r = await deleteManualEntry({ restaurantId: ctx.restaurantId, entryId: id });
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: statusFor(r.error) });
  }
  return NextResponse.json({ ok: true });
}

export const GET = secureApi(GETHandler);

export const PUT = secureApi(PUTHandler);

export const DELETE = secureApi(DELETEHandler);
