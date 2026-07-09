import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { encryptSecret } from "@/lib/dian/crypto";
import { dianConfigStatus, resolveEmisor, upsertDianConfig } from "@/lib/dian/config";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

/** Estado de la configuración DIAN — SIN secretos (vista para el cliente). */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { emisor, status } = await dianConfigStatus(ctx.restaurantId);
  return NextResponse.json({
    status,
    emisor: emisor
      ? {
          kind: emisor.ref.kind,
          legalName: emisor.legalName,
          taxId: emisor.taxId,
          resolution: emisor.resolution,
          invoicePrefix: emisor.invoicePrefix,
        }
      : null,
    // Aviso temprano si el server no puede cifrar secretos.
    masterKeyReady: /^[0-9a-fA-F]{64}$/.test(process.env.DIAN_MASTER_KEY ?? ""),
  });
}

const patchSchema = z.object({
  softwareId: z.string().trim().min(1).max(100).optional(),
  softwarePin: z.string().trim().min(1).max(100).optional(),
  technicalKey: z.string().trim().min(1).max(200).optional(),
  testSetId: z.string().trim().max(100).nullable().optional(),
  environment: z.enum(["habilitacion", "produccion"]).optional(),
});

/** Credenciales del portal DIAN (Software ID/PIN, clave técnica, ambiente). */
export async function PATCH(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.DIAN_MASTER_KEY ?? "")) {
    return NextResponse.json({ error: "master_key_missing" }, { status: 503 });
  }
  const emisor = await resolveEmisor(ctx.restaurantId);
  if (!emisor) return NextResponse.json({ error: "no_emisor" }, { status: 400 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const data: Record<string, unknown> = {};
  if (b.softwareId !== undefined) data.softwareId = b.softwareId;
  if (b.softwarePin !== undefined) {
    data.softwarePinEnc = encryptSecret(Buffer.from(b.softwarePin, "utf8"));
  }
  if (b.technicalKey !== undefined) data.technicalKey = b.technicalKey;
  if (b.testSetId !== undefined) data.testSetId = b.testSetId;
  if (b.environment !== undefined) data.environment = b.environment;

  await upsertDianConfig(emisor, data);
  const { status } = await dianConfigStatus(ctx.restaurantId);
  return NextResponse.json({ status });
}
