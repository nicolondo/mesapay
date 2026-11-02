import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireInsightsAccess } from "@/lib/ai/insightsGate";

export const dynamic = "force-dynamic";

/** La lista trae las conversaciones más recientes; con esto alcanza de sobra. */
const LIST_LIMIT = 50;

/**
 * GET — conversaciones de Pulso del usuario en sesión en el comercio activo
 * (el POST las guarda con ese par restaurantId + userId), de la más reciente
 * a la más vieja. Sólo las que ya tienen mensajes: una conversación vacía
 * no le sirve de nada al operador.
 */
async function GETHandler() {
  const gate = await requireInsightsAccess();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const rows = await db.aiConversation.findMany({
    where: {
      restaurantId: gate.scope.restaurantId,
      userId: gate.userId,
      messages: { some: {} },
    },
    orderBy: { updatedAt: "desc" },
    take: LIST_LIMIT,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      messageCount: c._count.messages,
    })),
  });
}

export const GET = secureApi(GETHandler);
