/**
 * Sesión del COMENSAL: permanente para él, revocable para nosotros, y
 * atada a UN comercio.
 *
 * ── Por qué NO es un JWT ──────────────────────────────────────────────
 * El personal (operator / mesero / kitchen / bar / platform_admin) sigue con
 * la sesión JWT de NextAuth (`src/auth.ts`), y eso no se toca. Pero al
 * comensal el producto le promete que NUNCA se le vuelve a pedir la clave,
 * y un JWT eterno no se puede cumplir sin regalar la cuenta: el JWT es
 * autocontenido — el servidor no lo consulta — así que un celular perdido
 * conserva acceso hasta que el token expire, y como no expira nunca, jamás.
 * Ni cambiar la contraseña lo corta.
 *
 * Acá la cookie solo lleva un token opaco; la sesión de verdad es la fila
 * `DinerSession`. Cada request la consulta, así que revocarla (cambio de
 * clave, "cerrar sesión en todos los dispositivos", celular robado) surte
 * efecto en el request siguiente. El comensal no nota nada: para él la
 * cookie dura 10 años y nunca vuelve a ver un formulario de login.
 *
 * ── Por qué la cookie es POR RESTAURANTE ──────────────────────────────
 * Desde que el registro es por comercio, la misma persona puede tener
 * cuenta en varios restaurantes MESAPAY, y son cuentas distintas. Con UNA
 * sola cookie sólo podría estar dentro de una a la vez: entrar en el
 * restaurante B la sobrescribiría y al volver al A tendría que iniciar
 * sesión otra vez — justo lo que la sesión permanente promete que no pasa.
 * Por eso el nombre de la cookie lleva el id del restaurante. Están acotadas
 * por la realidad (una cookie por local donde la persona efectivamente
 * comió y se registró) y hacen imposible por construcción que la sesión de
 * un comercio abra la cuenta de otro.
 */

import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";

/** Prefijo de la cookie donde vive el token opaco de la sesión. */
export const DINER_SESSION_COOKIE_PREFIX = "MESAPAY_DINER_";

/**
 * Nombre de la cookie para ese comercio. El id es un cuid (alfanumérico),
 * así que siempre produce un nombre de cookie válido.
 */
export function dinerSessionCookieName(restaurantId: string): string {
  return DINER_SESSION_COOKIE_PREFIX + restaurantId;
}

/**
 * 10 años. No es "la vigencia de la sesión" — la sesión no vence — es
 * solo el tiempo que el navegador guarda la cookie. Lo que decide si la
 * sesión sigue viva es `DinerSession.revokedAt` en la DB.
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

export type DinerViewer = {
  id: string;
  restaurantId: string;
  email: string;
  name: string | null;
  cedula: string | null;
  /** Id de la fila DinerSession con la que entró. */
  sessionId: string;
};

/**
 * Crea la sesión persistida y escribe la cookie DEL COMERCIO del comensal.
 * Devuelve el id de la fila por si el caller quiere excluirla de una
 * revocación masiva.
 */
export async function createDinerSession(
  diner: { id: string; restaurantId: string },
  userAgent?: string | null,
): Promise<string> {
  const token = generateSessionToken();
  const row = await db.dinerSession.create({
    data: {
      tokenHash: hashSessionToken(token),
      dinerId: diner.id,
      userAgent: userAgent ? userAgent.slice(0, 200) : null,
    },
    select: { id: true },
  });

  const jar = await cookies();
  jar.set(dinerSessionCookieName(diner.restaurantId), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return row.id;
}

/**
 * Identidad del comensal EN ESTE COMERCIO, o null.
 *
 * El `restaurantId` no es opcional a propósito: sin él no existe la
 * pregunta "¿quién es este comensal?" — un comensal solo existe dentro de
 * un comercio. Además de leer la cookie de ese local, se vuelve a verificar
 * contra la DB que el comensal siga perteneciendo a él: si alguien copiara
 * el token de una cookie a otra, la sesión no resolvería.
 */
export async function getDiner(
  restaurantId: string,
): Promise<DinerViewer | null> {
  const jar = await cookies();
  const token = jar.get(dinerSessionCookieName(restaurantId))?.value;
  if (!token) return null;

  const row = await db.dinerSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: {
      id: true,
      revokedAt: true,
      diner: {
        select: {
          id: true,
          restaurantId: true,
          email: true,
          name: true,
          cedula: true,
          disabledAt: true,
        },
      },
    },
  });
  if (!row) return null;
  // Acá está el punto entero del diseño: la revocación se respeta en el
  // request siguiente, sin esperar a que "venza" nada.
  if (row.revokedAt) return null;
  if (row.diner.disabledAt) return null;
  // Cinturón y tirantes: la cookie ya es por restaurante, pero el dueño de
  // la sesión también tiene que serlo.
  if (row.diner.restaurantId !== restaurantId) return null;

  return {
    id: row.diner.id,
    restaurantId: row.diner.restaurantId,
    email: row.diner.email,
    name: row.diner.name,
    cedula: row.diner.cedula,
    sessionId: row.id,
  };
}

/** Marca la sesión actual de ese comercio como revocada y borra la cookie. */
export async function revokeCurrentDinerSession(
  restaurantId: string,
): Promise<void> {
  const jar = await cookies();
  const name = dinerSessionCookieName(restaurantId);
  const token = jar.get(name)?.value;
  if (token) {
    // updateMany y no update: si la fila ya no existe no queremos que
    // reviente el logout — el objetivo (que la cookie no sirva) se cumple.
    await db.dinerSession.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  jar.delete(name);
}

/**
 * Mata TODAS las sesiones del comensal. Es el botón de pánico: celular
 * robado, o cambio de contraseña.
 *
 * `exceptSessionId` permite dejar viva la del dispositivo actual — que es
 * lo que uno quiere al cambiar la clave: se cierra todo lo demás pero no te
 * expulsa a vos mismo.
 */
export async function revokeAllDinerSessions(
  dinerId: string,
  exceptSessionId?: string | null,
): Promise<number> {
  const res = await db.dinerSession.updateMany({
    where: {
      dinerId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/** Sesiones vivas del comensal, para listarlas en su cuenta. */
export async function listActiveDinerSessions(dinerId: string) {
  return db.dinerSession.findMany({
    where: { dinerId, revokedAt: null },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true },
    take: 50,
  });
}

/**
 * Refresca `lastUsedAt`. Se llama de forma best-effort (sin await bloqueante
 * en el render) para que la lista de dispositivos diga algo útil.
 * No es crítico: si falla, la sesión sigue funcionando igual.
 */
export async function touchDinerSession(sessionId: string): Promise<void> {
  await db.dinerSession
    .update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}
