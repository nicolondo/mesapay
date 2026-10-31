import { secureApi } from "@/lib/secureApi";
import { NextResponse, after } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rateLimit";
import { recordAuditEvent } from "@/lib/auditLog";
import { canStaffSignIn } from "@/lib/staffLogin";
import { issuePasswordResetLink } from "@/lib/passwordResetIssue";

/** Pedidos por IP y por correo en la ventana (existan o no los correos). */
const IP_LIMIT = 10;
const EMAIL_LIMIT = 3;
const WINDOW_SECONDS = 60 * 60;

const schema = z.object({ email: z.string().trim().email().max(254) });

/**
 * POST /api/auth/forgot-password — público. "Olvidé mi contraseña" del
 * PERSONAL (incluido platform_admin). Los comensales viven en `Diner` y
 * tienen su propio flujo por comercio: acá nunca se consultan, y las filas
 * legado `User` con role=customer quedan fuera por `canStaffSignIn`.
 *
 * Anti-enumeración: la respuesta es SIEMPRE `{ ok: true }` y se manda antes
 * de mirar la base. Buscar al usuario, emitir el token y mandar el correo
 * corre en `after()`, así que el tiempo de respuesta es el mismo exista o no
 * el correo. Los límites cuentan el correo escrito (no la cuenta), por lo que
 * un 429 tampoco revela nada.
 */
async function POSTHandler(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const email = parsed.data.email.toLowerCase();
  // nginx reemplaza X-Real-IP (mismo criterio que secureApi y el login).
  const ip = req.headers.get("x-real-ip") ?? "unattributed";

  const ipOk = await rateLimit(`forgot-password-ip:${ip}`, IP_LIMIT, WINDOW_SECONDS);
  const emailOk =
    ipOk && (await rateLimit(`forgot-password-email:${email}`, EMAIL_LIMIT, WINDOW_SECONDS));
  if (!ipOk || !emailOk) {
    const res = NextResponse.json({ error: "rate_limited" }, { status: 429 });
    res.headers.set("Retry-After", String(WINDOW_SECONDS));
    return res;
  }

  const locale = await getLocale().catch(() => null);
  after(() => sendForgotPasswordLink(email, locale));

  return NextResponse.json({ ok: true });
}

/** Trabajo diferido: nunca lanza ni loguea el correo, el token o la URL. */
async function sendForgotPasswordLink(email: string, locale: string | null) {
  try {
    const user = await db.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        passwordHash: true,
        disabledAt: true,
        restaurantId: true,
        restaurant: { select: { name: true } },
      },
    });
    if (!user || !canStaffSignIn(user)) return;

    const { sent } = await issuePasswordResetLink(user, { locale });
    if (!sent) console.warn("[forgot-password] delivery failed", { userId: user.id });

    await recordAuditEvent({
      kind: "user.password_reset_request",
      restaurantId: user.restaurantId ?? null,
      target: { type: "user", id: user.id },
      summary: `Se pidió restablecer la contraseña de ${user.email} desde el inicio de sesión`,
      actor: { userId: null, email: "anonymous", role: "public" },
    });
  } catch (error) {
    console.error("[forgot-password] failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export const POST = secureApi(POSTHandler);
