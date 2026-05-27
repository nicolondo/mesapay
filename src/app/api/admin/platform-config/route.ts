import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import {
  getKushkiMode,
  setKushkiMode,
  type KushkiMode,
} from "@/lib/platformConfig";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Configuración plataforma. Sólo platform_admin puede leer/editar.
 *
 * Hoy expone únicamente kushkiMode (mock/sandbox/production). El
 * patrón está pensado para extenderse con más toggles.
 */

const patchSchema = z.object({
  kushkiMode: z.enum(["mock", "sandbox", "production"]).optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const kushkiMode = await getKushkiMode();
  return NextResponse.json({ kushkiMode });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const before = await getKushkiMode();
  if (parsed.data.kushkiMode && parsed.data.kushkiMode !== before) {
    const next: KushkiMode = parsed.data.kushkiMode;
    await setKushkiMode(next, session.user.id);
    await recordAuditEvent({
      kind: "platform.kushki_mode.update",
      restaurantId: null,
      target: { type: "platform_config" },
      summary: `Cambió KUSHKI_MODE de ${before} a ${next}`,
      diff: {
        before: { kushkiMode: before },
        after: { kushkiMode: next },
      },
    });
  }
  return NextResponse.json({
    ok: true,
    kushkiMode: parsed.data.kushkiMode ?? before,
  });
}
