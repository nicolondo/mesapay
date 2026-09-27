import { NextResponse } from "next/server";

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

/**
 * Redirección desde un route handler con `Location` RELATIVO (RFC 7231
 * §7.1.2): el navegador lo resuelve contra la URL pública que tiene en la
 * barra, así que no importa qué host interno vea `next start`.
 *
 * Por qué no las alternativas de Next 16:
 *   - `NextResponse.redirect(url)` exige una URL absoluta (`validateURL`
 *     lanza "URL is malformed ... use only absolute URLs" con una ruta
 *     relativa), y la absoluta que se arma con `new URL(path, req.url)`
 *     lleva el host interno: `https://localhost:3301/...`.
 *   - `redirect()` de `next/navigation` sí manda un `Location` relativo,
 *     pero funciona LANZANDO un error, y `secureApi` envuelve los handlers
 *     en un try/catch que lo convertiría en un 500.
 *
 * Las cookies puestas con `cookies()` durante el handler se agregan a esta
 * respuesta igual que a cualquier otra.
 */
export function redirectTo(path: string, status: RedirectStatus = 307): NextResponse {
  // Sólo rutas internas: "//evil.com" o "/\evil.com" son URLs de otro host.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new Error(`redirectTo: se esperaba una ruta interna que empiece con "/", llegó ${JSON.stringify(path)}`);
  }
  return new NextResponse(null, { status, headers: { Location: path } });
}
