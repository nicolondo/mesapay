import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rateLimit";
import {
  listRecoverableInvoices,
  MAX_BATCH,
  recoverDianInvoice,
  recoverRestaurantInvoices,
} from "@/lib/dian/invoiceRecovery";

export const dynamic = "force-dynamic";

/**
 * Recuperación EN LOTE de las facturas electrónicas de un comercio que la
 * DIAN no dejó aceptadas por una causa que ya no aplica (línea en $0,
 * regla 90, respuestas transitorias de la DIAN). Sólo platform-admin.
 *
 *   GET  → listado (dry-run): qué facturas hay, por qué y qué se haría.
 *          No toca nada ni llama a la DIAN.
 *   POST { dryRun: true }            → lo mismo que GET.
 *   POST { dryRun: false, limit }    → procesa hasta `limit` (tope
 *          MAX_BATCH), una a la vez y con pausa; lo que no entra queda para
 *          la próxima corrida. Idempotente: las aceptadas salen del listado
 *          y cada documento se reclama antes de enviarse.
 *   POST { documentId, cufe }        → consulta UNA factura con un CUFE
 *          copiado del portal de la DIAN (sólo vale si el acuse lo confirma
 *          para ese número).
 *
 * Cada documento queda en el audit log (y la corrida, con su resumen).
 */
const schema = z.object({
  dryRun: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(MAX_BATCH).optional(),
  documentId: z.string().min(1).max(64).optional(),
  cufe: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{96}$/)
    .optional(),
});

/** El id del comercio, o la respuesta de error (401 sin admin, 404 sin comercio). */
async function guard(params: Promise<{ id: string }>): Promise<string | NextResponse> {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const exists = await db.restaurant.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return id;
}

async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = await guard(params);
  if (typeof id !== "string") return id;
  return NextResponse.json({ dryRun: true, ...(await listRecoverableInvoices(id)) });
}

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = await guard(params);
  if (typeof id !== "string") return id;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const body = parsed.data;

  if (body.documentId) {
    if (!body.cufe) return NextResponse.json({ error: "invalid" }, { status: 400 });
    if (!(await rateLimit(`dian-recovery-one:${id}`, 20, 60))) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    const result = await recoverDianInvoice({
      documentId: body.documentId,
      restaurantId: id,
      action: "check_status",
      extraCufe: body.cufe,
      source: "admin_single",
    });
    return NextResponse.json({ result });
  }

  if (body.dryRun) {
    return NextResponse.json({ dryRun: true, ...(await listRecoverableInvoices(id)) });
  }
  // Una corrida ya puede mandar hasta MAX_BATCH documentos: más de tres por
  // minuto es un doble clic o un script.
  if (!(await rateLimit(`dian-recovery-batch:${id}`, 3, 60))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const run = await recoverRestaurantInvoices({ restaurantId: id, limit: body.limit });
  return NextResponse.json({ dryRun: false, ...run });
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
