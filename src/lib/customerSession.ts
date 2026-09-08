/**
 * Sesión del comensal: permanente para él, revocable para nosotros.
 *
 * ── Por qué NO es un JWT ──────────────────────────────────────────────
 * El staff (operator / mesero / kitchen / bar / platform_admin) sigue con
 * la sesión JWT de NextAuth (`src/auth.ts`), y eso no se toca. Pero al
 * comensal el producto le promete que NUNCA se le vuelve a pedir la clave,
 * y un JWT eterno no se puede cumplir sin regalar la cuenta: el JWT es
 * autocontenido — el servidor no lo consulta — así que un celular perdido
 * conserva acceso hasta que el token expire, y como no expira nunca, jamás.
 * Ni cambiar la contraseña lo corta.
 *
 * Acá la cookie solo lleva un token opaco; la sesión de verdad es la fila
 * `CustomerSession`. Cada request la consulta, así que revocarla (cambio de
 * clave, "cerrar sesión en todos los dispositivos", celular robado) surte
 * efecto en el request siguiente. El comensal no nota nada: para él la
 * cookie dura 10 años y nunca vuelve a ver un formulario de login.
 *
 * Esto pesa más de cara al roadmap: esta misma sesión va a poder gastar
 * plata (bonos, crédito empresarial).
 *
 * ── Convivencia con NextAuth ──────────────────────────────────────────
 * Las dos estrategias coexisten. `getViewer()` mira primero la cookie del
 * comensal y cae a `auth()` si no hay. Un comensal que ya tenía sesión JWT
 * de antes sigue entrando a /me sin que nada se le rompa: la próxima vez
 * que inicie sesión obtiene la sesión revocable.
 */

import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import type { Role } from "@prisma/client";
import { db } from "./db";
import { auth } from "@/auth";

/** Cookie donde vive el token opaco de la sesión del comensal. */
export const CUSTOMER_SESSION_COOKIE = "MESAPAY_CUSTOMER_SESSION";

/**
 * 10 años. No es "la vigencia de la sesión" — la sesión no vence — es
 * solo el tiempo que el navegador guarda la cookie. Lo que decide si la
 * sesión sigue viva es `CustomerSession.revokedAt` en la DB.
 */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;

/** Token aleatorio de 32 bytes que viaja en la cookie (64 hex chars). */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** En DB solo guardamos el hash — un leak de la tabla no da sesiones usables. */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export type CustomerViewer = {
  id: string;
  email: string;
  name: string | null;
  cedula: string | null;
  role: Role;
  /** Cómo llegó la identidad: sesión revocable en DB, o JWT de NextAuth. */
  via: "customer_session" | "nextauth";
  /** Id de la fila CustomerSession — null cuando viene del JWT. */
  sessionId: string | null;
};

/**
 * Crea la sesión persistida y escribe la cookie. Devuelve el id de la fila
 * por si el caller quiere excluirla de una revocación masiva.
 */
export async function createCustomerSession(
  userId: string,
  userAgent?: string | null,
): Promise<string> {
  const token = generateSessionToken();
  const row = await db.customerSession.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      userAgent: userAgent ? userAgent.slice(0, 200) : null,
    },
    select: { id: true },
  });

  const jar = await cookies();
  jar.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return row.id;
}

/**
 * Lee la cookie y resuelve la sesión contra la DB. Devuelve null si no hay
 * cookie, si el token no existe (cookie vieja / falsificada) o si la sesión
 * fue revocada.
 */
export async function getCustomerSession(): Promise<CustomerViewer | null> {
  const jar = await cookies();
  const token = jar.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = await db.customerSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: {
      id: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          cedula: true,
          role: true,
          disabledAt: true,
        },
      },
    },
  });
  if (!row) return null;
  // Acá está el punto entero del diseño: la revocación se respeta en el
  // request siguiente, sin esperar a que "venza" nada.
  if (row.revokedAt) return null;
  if (row.user.disabledAt) return null;

  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    cedula: row.user.cedula,
    role: row.user.role,
    via: "customer_session",
    sessionId: row.id,
  };
}

/**
 * Identidad del visitante para las vistas del comensal (/me, /cuenta/*).
 *
 * Prioriza la sesión revocable; si no hay, cae al JWT de NextAuth para no
 * botar a la calle a quien ya tenía sesión abierta antes de este cambio
 * (ni al staff que entra a /me).
 */
export async function getViewer(): Promise<CustomerViewer | null> {
  const fromDb = await getCustomerSession();
  if (fromDb) return fromDb;

  const session = await auth();
  if (!session?.user) return null;
  // El JWT no lleva cédula; se lee de la DB para que /me la muestre igual.
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { cedula: true },
  });
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    cedula: user?.cedula ?? null,
    role: session.user.role,
    via: "nextauth",
    sessionId: null,
  };
}

/** Marca la sesión actual como revocada y borra la cookie. */
export async function revokeCurrentCustomerSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (token) {
    // updateMany y no update: si la fila ya no existe no queremos que
    // reviente el logout — el objetivo (que la cookie no sirva) se cumple.
    await db.customerSession.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  jar.delete(CUSTOMER_SESSION_COOKIE);
}

/**
 * Mata TODAS las sesiones del usuario. Es el botón de pánico: celular
 * robado, o cambio de contraseña.
 *
 * `exceptSessionId` permite dejar viva la del dispositivo actual — que es
 * lo que uno quiere al cambiar la clave: se cierra todo lo demás pero no te
 * expulsa a vos mismo.
 */
export async function revokeAllCustomerSessions(
  userId: string,
  exceptSessionId?: string | null,
): Promise<number> {
  const res = await db.customerSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/** Sesiones vivas del comensal, para listarlas en /me. */
export async function listActiveCustomerSessions(userId: string) {
  return db.customerSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true },
    take: 50,
  });
}

/**
 * Refresca `lastUsedAt`. Se llama de forma best-effort (sin await bloqueante
 * en el render) para que la lista de dispositivos de /me diga algo útil.
 * No es crítico: si falla, la sesión sigue funcionando igual.
 */
export async function touchCustomerSession(sessionId: string): Promise<void> {
  await db.customerSession
    .update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}
