import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getClient, INSIGHTS_MODEL } from "@/lib/anthropic";
import { resolveInsightsScope } from "@/lib/ai/scope";
import { resolveAiEnabled, dailyMessageLimit, messagesUsedToday } from "@/lib/ai/aiAccess";
import { anthropicTools, executeTool } from "@/lib/ai/toolRegistry";
import { runInsightsAgent } from "@/lib/ai/insightsAgent";
import { timezoneForCountry } from "@/lib/ai/tools/dateRange";

const schema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "operator" && role !== "platform_admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const scope = await resolveInsightsScope();
  if (!scope) return NextResponse.json({ error: "no_restaurant" }, { status: 400 });

  const r = await db.restaurant.findUnique({
    where: { id: scope.restaurantId },
    select: { plan: true, aiInsightsEnabled: true, aiDailyMessageLimit: true, name: true, country: true },
  });
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!resolveAiEnabled(r)) return NextResponse.json({ error: "feature_disabled" }, { status: 403 });

  const limit = await dailyMessageLimit(r.aiDailyMessageLimit);
  if ((await messagesUsedToday(scope.restaurantId)) >= limit) {
    return NextResponse.json({ error: "daily_limit", limit }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // Conversación (crear o continuar)
  let conv = parsed.data.conversationId
    ? await db.aiConversation.findFirst({ where: { id: parsed.data.conversationId, restaurantId: scope.restaurantId } })
    : null;
  if (!conv) {
    conv = await db.aiConversation.create({
      data: { restaurantId: scope.restaurantId, userId: session.user.id, title: parsed.data.message.slice(0, 60) },
    });
  }
  await db.aiMessage.create({ data: { conversationId: conv.id, role: "user", content: parsed.data.message } });

  // Historial reciente (últimos 20) como contexto
  const history = await db.aiMessage.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  const messages = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const locale = await getLocale(); // cookie MESAPAY_LOCALE (next-intl)
  const today = new Date().toISOString().slice(0, 10);
  const system =
    `Sos "Pulso", el analista de negocio del restaurante "${r.name}". Hoy es ${today}. ` +
    `Respondé SIEMPRE en el idioma: ${locale}. Usá SOLO las herramientas para obtener datos ` +
    `(nunca inventes cifras). Sé concreto: números clave, comparaciones y 1-2 recomendaciones ` +
    `accionables. Si una pregunta no se puede responder con las herramientas, decilo.`;

  const result = await runInsightsAgent({
    client: getClient(),
    model: INSIGHTS_MODEL,
    system,
    messages,
    ctx: { scope, timezone: timezoneForCountry(r.country) },
    executeTool,
    tools: anthropicTools(),
  });

  await db.aiMessage.create({
    data: { conversationId: conv.id, role: "assistant", content: result.text, toolCalls: result.toolCalls as any },
  });

  return NextResponse.json({ conversationId: conv.id, text: result.text, toolCalls: result.toolCalls });
}
