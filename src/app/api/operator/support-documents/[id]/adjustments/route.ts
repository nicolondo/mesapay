import { secureApi } from "@/lib/secureApi";
import { z } from "zod";
import { supportDocApi } from "@/lib/dian/supportDocument/api";
import { ADJUSTMENT_DESCRIPTION_MAX } from "@/lib/dian/supportDocument/constants";
import { SupportDocError } from "@/lib/dian/supportDocument/errors";
import { createAdjustmentNote } from "@/lib/dian/supportDocument/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  reasonCode: z.enum(["1", "2", "3", "4", "5"]),
  reasonText: z.string().trim().max(ADJUSTMENT_DESCRIPTION_MAX),
  amountCents: z.number().int().positive().max(2_000_000_000_00).nullable().optional(),
});

/** Nota de ajuste a un documento soporte aceptado (anulación o ajuste de valor). */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return supportDocApi(async (ctx) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SupportDocError("invalid_reason");
    const document = await createAdjustmentNote({
      restaurantId: ctx.restaurantId,
      userId: ctx.userId,
      supportDocumentId: id,
      reasonCode: parsed.data.reasonCode,
      reasonText: parsed.data.reasonText,
      amountCents: parsed.data.amountCents ?? null,
    });
    return { document };
  }, 201);
}

export const POST = secureApi(POSTHandler);
