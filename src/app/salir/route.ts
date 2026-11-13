import { signOut } from "@/auth";
import { redirectTo } from "@/lib/http/redirect";

/**
 * GET /salir — cierra la sesión del personal con solo abrir la dirección
 * (https://mesapay.co/salir) y lleva a /signin. Es la salida de emergencia
 * para quien no encuentra el botón «Cerrar sesión»: no pide confirmación ni
 * muestra pantalla propia. Sin sesión hace lo mismo: redirige a /signin.
 *
 * Vive en el host de plataforma, que es donde está la cookie de sesión del
 * personal (es host-only). En el subdominio de un comercio el middleware
 * reescribe a /t/<slug>/salir, que no existe: allá no hay sesión de personal
 * que cerrar y la del comensal (lib/dinerSession.ts) no se toca.
 */

// Lee encabezados y escribe cookies: nunca se prerenderiza ni se cachea.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Encabezados con los que navegadores y routers anuncian una precarga. */
const PRELOAD_HINT_HEADERS = ["purpose", "sec-purpose", "x-purpose", "x-moz"];

/**
 * Un cierre de sesión por GET se puede disparar sin querer: un `<img>` o un
 * iframe en otra página, el prefetch de un enlace, la precarga del navegador
 * mientras se escribe la dirección. Solo cuenta la navegación de primer
 * nivel: la persona abrió la dirección en una pestaña.
 *
 * Los navegadores sin `Sec-Fetch-*` (viejos) no se pueden distinguir, así
 * que ahí se permite: no dejar a nadie sin poder salir pesa más que un
 * cierre de sesión forzado, que solo obliga a volver a entrar.
 */
function isTopLevelNavigation(req: Request): boolean {
  // Next responde HEAD con el handler de GET; un HEAD nunca es "abrir la página".
  if (req.method !== "GET") return false;
  const h = req.headers;

  // Prefetch del router de Next (`<Link>`) y peticiones RSC.
  if (h.has("next-router-prefetch") || h.has("rsc")) return false;
  // Prefetch / prerender del navegador («Purpose: prefetch», «Sec-Purpose:
  // prefetch;prerender», «X-Purpose: preview», «X-Moz: prefetch»).
  if (PRELOAD_HINT_HEADERS.some((name) => /prefetch|prerender|preview/i.test(h.get(name) ?? ""))) {
    return false;
  }

  // Embebida o hecha por script: image, iframe, script, empty (fetch/XHR)…
  const mode = h.get("sec-fetch-mode");
  const dest = h.get("sec-fetch-dest");
  if (mode !== null && mode.toLowerCase() !== "navigate") return false;
  if (dest !== null && dest.toLowerCase() !== "document") return false;
  return true;
}

export async function GET(req: Request) {
  if (!isTopLevelNavigation(req)) {
    // 204 y no un redirect: no toca cookies y no deja una respuesta que el
    // navegador pueda reutilizar como si fuera la navegación de verdad.
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  // `redirect: false`: Auth.js solo borra la cookie de sesión (con su prefijo
  // `__Secure-` en https y los trozos `.0`, `.1`… si venía partida) a través
  // de `cookies()`; la redirección sale de acá con `Location` relativo, para
  // no depender del host interno que ve `next start` (ver lib/http/redirect).
  await signOut({ redirect: false, redirectTo: "/signin" });

  const res = redirectTo("/signin", 303);
  res.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return res;
}
