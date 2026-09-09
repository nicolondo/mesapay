import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { encryptSecret } from "@/lib/dian/crypto";
import {
  dianConfigStatus,
  emisorView,
  lastTestSetDocument,
  resolveEmisor,
  upsertDianConfig,
} from "@/lib/dian/config";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

/**
 * El GET no lleva gate de módulo: la misma pantalla sirve la resolución de
 * numeración, que ahora es su única superficie de carga y que también
 * necesitan los comercios que sólo imprimen tirilla.
 * `status.einvoicingEnabled` le dice al cliente qué secciones puede
 * mostrar. La escritura de credenciales (PATCH) y todo lo que toca la
 * DIAN sí siguen gateados.
 */
const READ_GATE: ModuleSlug[] = [];

/** Estado de la configuración DIAN — SIN secretos (vista para el cliente). */
async function GETHandler() {
  const ctx = await getErpContext(READ_GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { emisor, status } = await dianConfigStatus(ctx.restaurantId);
  return NextResponse.json({
    status,
    emisor: emisor ? emisorView(emisor) : null,
    // Último documento del SET DE PRUEBAS — sólo mientras el comercio
    // siga en habilitación: ahí sí necesita ver por qué la DIAN rechazó y
    // que el resultado sobreviva a recargar la página. Ya en producción
    // ese documento es historia de una corrida vieja y no dice nada del
    // estado actual: mostrarlo pintaba un panel rojo de "documento
    // rechazado" debajo de la insignia "Habilitado" y asustaba al dueño.
    lastDocument:
      status.einvoicingEnabled && status.environment === "habilitacion"
        ? await lastTestSetDocument(ctx.restaurantId)
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
async function PATCHHandler(req: Request) {
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

export const GET = secureApi(GETHandler);

export const PATCH = secureApi(PATCHHandler);
