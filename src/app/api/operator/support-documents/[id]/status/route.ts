import { secureApi } from "@/lib/secureApi";
import { supportDocApi } from "@/lib/dian/supportDocument/api";
import { refreshSupportDocumentStatus } from "@/lib/dian/supportDocument/service";

export const dynamic = "force-dynamic";

/** Consulta en la DIAN el estado de un documento pendiente. */
async function POSTHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return supportDocApi(async (ctx) => ({
    document: await refreshSupportDocumentStatus({ restaurantId: ctx.restaurantId, id }),
  }));
}

export const POST = secureApi(POSTHandler);
