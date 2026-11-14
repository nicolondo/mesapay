import { secureApi } from "@/lib/secureApi";
import { supportDocApi } from "@/lib/dian/supportDocument/api";
import { resendSupportDocument } from "@/lib/dian/supportDocument/service";

export const dynamic = "force-dynamic";

/** Reenvía un documento rechazado (armado de nuevo, mismo número) o con error de canal. */
async function POSTHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return supportDocApi(async (ctx) => ({
    document: await resendSupportDocument({ restaurantId: ctx.restaurantId, id }),
  }));
}

export const POST = secureApi(POSTHandler);
