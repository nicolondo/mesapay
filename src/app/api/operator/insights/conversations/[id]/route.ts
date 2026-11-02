import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireInsightsAccess } from "@/lib/ai/insightsGate";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET — una conversación de Pulso con sus mensajes en orden cronológico.
 * 404 si no es del comercio activo y del usuario en sesión (no se revela si
 * existe). Los `toolCalls` del asistente (las consultas internas del agente)
 * se quedan en el servidor: el cliente sólo necesita el texto.
 */
async function GETHandler(_req: Request, { params }: Params) {
  const gate = await requireInsightsAccess();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const { id } = await params;

  const conversation = await db.aiConversation.findFirst({
    where: { id, restaurantId: gate.scope.restaurantId, userId: gate.userId },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });
  if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ conversation });
}

/**
 * DELETE — borra la conversación (los mensajes caen en cascada). El filtro
 * por comercio + usuario va en el mismo `deleteMany`, así no hay ventana
 * entre comprobar y borrar. 404 si no es suya.
 */
async function DELETEHandler(_req: Request, { params }: Params) {
  const gate = await requireInsightsAccess();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const { id } = await params;

  const { count } = await db.aiConversation.deleteMany({
    where: { id, restaurantId: gate.scope.restaurantId, userId: gate.userId },
  });
  if (count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}

export const GET = secureApi(GETHandler);
export const DELETE = secureApi(DELETEHandler);
