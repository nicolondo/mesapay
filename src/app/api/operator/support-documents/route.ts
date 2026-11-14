import { secureApi } from "@/lib/secureApi";
import { z } from "zod";
import { assertSourceModule, supportDocApi } from "@/lib/dian/supportDocument/api";
import { SupportDocError } from "@/lib/dian/supportDocument/errors";
import { createSupportDocument } from "@/lib/dian/supportDocument/service";
import { supportDocPanel } from "@/lib/dian/supportDocument/view";

export const dynamic = "force-dynamic";

const sourceSchema = z.object({
  sourceType: z.enum(["expense", "purchase_order"]),
  sourceId: z.string().trim().min(1).max(64),
});

/** Panel de un gasto o una compra: configuración, vendedor y documentos. */
async function GETHandler(req: Request) {
  return supportDocApi(async (ctx) => {
    const url = new URL(req.url);
    const parsed = sourceSchema.safeParse({
      sourceType: url.searchParams.get("sourceType"),
      sourceId: url.searchParams.get("sourceId"),
    });
    if (!parsed.success) throw new SupportDocError("source_not_found");
    await assertSourceModule(ctx.restaurantId, parsed.data.sourceType);
    const panel = await supportDocPanel(ctx.restaurantId, parsed.data.sourceType, parsed.data.sourceId);
    if (!panel) throw new SupportDocError("source_not_found");
    return { panel };
  });
}

/** Genera el documento soporte del gasto o de la compra y lo transmite. */
async function POSTHandler(req: Request) {
  return supportDocApi(async (ctx) => {
    const parsed = sourceSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SupportDocError("source_not_found");
    await assertSourceModule(ctx.restaurantId, parsed.data.sourceType);
    const document = await createSupportDocument({
      restaurantId: ctx.restaurantId,
      userId: ctx.userId,
      sourceType: parsed.data.sourceType,
      sourceId: parsed.data.sourceId,
    });
    return { document };
  }, 201);
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
