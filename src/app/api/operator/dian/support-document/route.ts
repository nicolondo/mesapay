import { secureApi } from "@/lib/secureApi";
import { z } from "zod";
import { encryptSecret } from "@/lib/dian/crypto";
import { resolveEmisor, upsertDianConfig } from "@/lib/dian/config";
import { supportDocApi } from "@/lib/dian/supportDocument/api";
import { supportDocConfigView } from "@/lib/dian/supportDocument/config";
import { SupportDocError } from "@/lib/dian/supportDocument/errors";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Configuración del documento soporte — SIN secretos. */
async function GETHandler() {
  return supportDocApi(async (ctx) => ({ config: await supportDocConfigView(ctx.restaurantId) }));
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    environment: z.enum(["habilitacion", "produccion"]).optional(),
    softwareId: z.string().trim().min(1).max(100).nullable().optional(),
    softwarePin: z.string().trim().min(1).max(100).optional(),
    testSetId: z.string().trim().max(100).nullable().optional(),
    // Autorización de numeración (Formato 1876): número, prefijo de hasta 4
    // caracteres (DSAB10) y rango/vigencia (DSAB07b, DSAB08b, DSAB11b, DSAB12b).
    resolutionNumber: z.string().trim().regex(/^\d{6,20}$/).nullable().optional(),
    prefix: z.string().trim().regex(/^[A-Za-z0-9]{1,4}$/).nullable().optional(),
    from: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
    to: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
    validFrom: day,
    validTo: day,
    adjustmentPrefix: z.string().trim().regex(/^[A-Za-z0-9]{1,6}$/).optional(),
  })
  .refine((b) => b.from == null || b.to == null || b.from <= b.to, { path: ["to"] })
  .refine((b) => !b.validFrom || !b.validTo || b.validFrom <= b.validTo, { path: ["validTo"] });

const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v ? new Date(`${v}T00:00:00Z`) : null);

async function PATCHHandler(req: Request) {
  return supportDocApi(async (ctx) => {
    if (!/^[0-9a-fA-F]{64}$/.test(process.env.DIAN_MASTER_KEY ?? "")) throw new SupportDocError("master_key_missing");
    const emisor = await resolveEmisor(ctx.restaurantId);
    if (!emisor) throw new SupportDocError("no_config");
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new SupportDocError("missing_resolution", parsed.error.issues.map((i) => String(i.path[0] ?? "invalid")));
    }
    const b = parsed.data;
    const data: Record<string, unknown> = {};
    if (b.enabled !== undefined) data.supportDocEnabled = b.enabled;
    if (b.softwareId !== undefined) data.supportDocSoftwareId = b.softwareId;
    if (b.softwarePin !== undefined) data.supportDocSoftwarePinEnc = encryptSecret(Buffer.from(b.softwarePin, "utf8"));
    if (b.testSetId !== undefined) data.supportDocTestSetId = b.testSetId || null;
    if (b.resolutionNumber !== undefined) data.supportDocResolutionNumber = b.resolutionNumber;
    if (b.prefix !== undefined) data.supportDocPrefix = b.prefix ? b.prefix.toUpperCase() : null;
    if (b.from !== undefined) data.supportDocFrom = b.from;
    if (b.to !== undefined) data.supportDocTo = b.to;
    if (b.validFrom !== undefined) data.supportDocValidFrom = toDate(b.validFrom);
    if (b.validTo !== undefined) data.supportDocValidTo = toDate(b.validTo);
    if (b.adjustmentPrefix !== undefined) data.supportDocAdjustmentPrefix = b.adjustmentPrefix.toUpperCase();
    if (b.environment !== undefined) {
      data.supportDocEnvironment = b.environment;
      // Estado de habilitación: en producción = habilitado. De vuelta a
      // habilitación, "en pruebas" si ya había pasado por ahí.
      const current = await db.dianConfig.findFirst({
        where: emisor.ref.kind === "legalEntity" ? { legalEntityId: emisor.ref.id } : { restaurantId: emisor.ref.id },
        select: { supportDocStatus: true },
      });
      data.supportDocStatus =
        b.environment === "produccion" ? "enabled" : current?.supportDocStatus === "pending" || !current ? "pending" : "testing";
    }
    await upsertDianConfig(emisor, data);
    return { config: await supportDocConfigView(ctx.restaurantId) };
  });
}

export const GET = secureApi(GETHandler);
export const PATCH = secureApi(PATCHHandler);
