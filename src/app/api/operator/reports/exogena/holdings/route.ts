import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { CONCEPTOS_1012, DOC_TYPES_MANUALES } from "@/lib/erp/exogena/normativa";
import { exogenaContext, isResponse } from "../_shared";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  concept: z.enum(CONCEPTOS_1012),
  entityName: z.string().trim().min(1).max(200),
  entityDocType: z.enum(DOC_TYPES_MANUALES),
  entityDocNumber: z.string().trim().min(1).max(30),
  /** Saldo al 31/12 en centavos (columna BigInt). */
  valueCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/**
 * Alta de una cuenta bancaria / inversión / acciones (formato 1012) del
 * año gravable. Número numérico salvo pasaporte: 400 `invalid_doc`.
 */
async function POSTHandler(req: Request) {
  const ctx = await exogenaContext();
  if (isResponse(ctx)) return ctx;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const digits = b.entityDocNumber.replace(/[\s.-]/g, "");
  if (b.entityDocType !== "PA" && !/^\d+$/.test(digits)) {
    return NextResponse.json({ error: "invalid_doc" }, { status: 400 });
  }
  const row = await db.exogenaHolding.create({
    data: {
      restaurantId: ctx.restaurantId,
      year: b.year,
      concept: b.concept,
      entityName: b.entityName,
      entityDocType: b.entityDocType,
      entityDocNumber: b.entityDocType === "PA" ? b.entityDocNumber : digits,
      valueCents: BigInt(b.valueCents),
    },
    select: { id: true },
  });
  return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
}

/** Borra una fila propia: `?id=`. */
async function DELETEHandler(req: Request) {
  const ctx = await exogenaContext();
  if (isResponse(ctx)) return ctx;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const r = await db.exogenaHolding.deleteMany({ where: { id, restaurantId: ctx.restaurantId } });
  if (r.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
export const DELETE = secureApi(DELETEHandler);
