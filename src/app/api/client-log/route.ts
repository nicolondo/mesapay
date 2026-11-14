import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * POST /api/client-log — errores del NAVEGADOR que el servidor no ve (la
 * impresión en el dispositivo, sobre todo): qué falló, en qué ruta y con qué
 * navegador, para encontrarlo en los logs la próxima vez.
 *
 * Sin datos personales: nombre y mensaje del error (recortados), la ruta sin
 * consulta, el user agent, y el rol y comercio de la sesión. Sólo staff con
 * sesión, a lo sumo 20 por minuto por usuario. Nunca falla hacia el cliente
 * más que con 204/4xx: es un registro, no una acción.
 */
const schema = z.object({
  event: z.enum(["device_print_failed", "device_print_no_dialog", "device_print_unsupported", "terminal_print_failed"]),
  name: z.string().max(100).optional(),
  message: z.string().max(300).optional(),
  path: z.string().max(200).optional(),
});

async function POSTHandler(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await rateLimit(`client-log:${session.user.id}`, 20, 60))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { event, name, message, path } = parsed.data;
  console.error("client_error", {
    event,
    name: name ?? null,
    message: message ?? null,
    // Sin la consulta: sólo la ruta.
    path: path ? path.split("?")[0] : null,
    userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300),
    role: session.user.role,
    restaurantId: session.user.restaurantId ?? null,
  });
  return new NextResponse(null, { status: 204 });
}

export const POST = secureApi(POSTHandler);
