/**
 * Autenticación del agente de impresión.
 *
 * El agente es un servicio de Windows que corre en un PC de la cocina: no
 * tiene sesión de NextAuth, no tiene cookies y no hay nadie para escribir
 * una contraseña cuando el PC arranca solo a las 6am. Se autentica con un
 * token opaco que se pega UNA vez en el instalador y viaja en cada
 * request como `Authorization: Bearer <token>`.
 *
 * En la DB sólo vive el SHA-256 del token — mismo criterio que
 * DinerSession.tokenHash y PasswordResetToken: un volcado de la tabla no
 * puede darle acceso a nadie. Como el lookup es por hash contra un índice
 * único, tampoco hay oráculo de tiempo que explotar: se hashea primero y
 * se consulta después.
 */

import "server-only";
import crypto from "node:crypto";
import { db } from "@/lib/db";

/**
 * Prefijo del token. Sirve para dos cosas: que un humano reconozca de un
 * vistazo qué pegó en el instalador, y que los escáneres de secretos
 * (GitHub, gitleaks) puedan detectar uno filtrado por su forma.
 */
export const PRINT_AGENT_TOKEN_PREFIX = "mpa_";

/**
 * Token nuevo. 32 bytes de aleatoriedad criptográfica = 256 bits: no se
 * adivina ni por fuerza bruta ni por accidente. Lo va a usar la pantalla
 * de configuración (PR aparte) al dar de alta un agente; se muestra UNA
 * sola vez porque después ya no se puede recuperar.
 */
export function generateAgentToken(): string {
  return PRINT_AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
}

/** Lo único que se guarda en DB. */
export function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Últimos 4 caracteres, para que la pantalla de configuración pueda
 * decir "…a9f3" y el operador distinga un agente de otro. No autentica.
 */
export function agentTokenTail(token: string): string {
  return token.slice(-4);
}

/** Saca el token del header `Authorization: Bearer …`. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

export type PrintAgentIdentity = {
  agentId: string;
  restaurantId: string;
  label: string;
};

/**
 * Identifica al agente que hace el request, o null. `restaurantId` es la
 * llave de TODO lo que sigue: cada consulta de trabajos se filtra por él
 * y por nada más, así que un token de un restaurante no puede ver ni
 * confirmar trabajos de otro.
 */
export async function authenticatePrintAgent(
  req: Request,
): Promise<PrintAgentIdentity | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const agent = await db.printAgent.findUnique({
    where: { tokenHash: hashAgentToken(token) },
    select: {
      id: true,
      restaurantId: true,
      label: true,
      revokedAt: true,
    },
  });
  if (!agent || agent.revokedAt) return null;
  return {
    agentId: agent.id,
    restaurantId: agent.restaurantId,
    label: agent.label,
  };
}

/**
 * Refresca `lastSeenAt` (y de paso versión / IP). Best-effort: si falla,
 * el trabajo se entrega igual — el latido es telemetría, no una barrera.
 * Lo llaman tanto /heartbeat como /jobs, porque un agente que está
 * pidiendo trabajos obviamente está vivo.
 */
export async function touchPrintAgent(
  agentId: string,
  extra?: { agentVersion?: string | null; ip?: string | null },
): Promise<void> {
  await db.printAgent
    .update({
      where: { id: agentId },
      data: {
        lastSeenAt: new Date(),
        ...(extra?.agentVersion
          ? { agentVersion: extra.agentVersion.slice(0, 40) }
          : {}),
        ...(extra?.ip ? { lastIp: extra.ip.slice(0, 64) } : {}),
      },
    })
    .catch(() => undefined);
}

/** IP del cliente detrás del proxy del VPS. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}
