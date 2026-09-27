import { secureApi } from "@/lib/secureApi";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { redirectTo } from "@/lib/http/redirect";

export const dynamic = "force-dynamic";

/**
 * Toggle del shell del operador. El "cockpit" es el DEFAULT; esto solo sirve
 * como escape para volver al shell anterior.
 *   GET /api/operator/shell-flag?to=classic  → fuerza el shell anterior
 *   GET /api/operator/shell-flag?to=cockpit  → vuelve al default (cockpit)
 * Setea/borra la cookie mp_shell y redirige a /operator. Requiere sesión staff.
 * Las redirecciones van con `Location` relativo: `new URL(path, req.url)`
 * llevaba el host interno de `next start` (localhost) detrás de nginx.
 */
async function GETHandler(req: Request) {
  const session = await auth();
  const role = session?.user?.role;
  if (
    !session?.user ||
    (role !== "operator" &&
      role !== "platform_admin" &&
      role !== "group_admin")
  ) {
    return redirectTo("/signin");
  }
  const to = new URL(req.url).searchParams.get("to");
  const jar = await cookies();
  if (to === "classic") {
    jar.set("mp_shell", "classic", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
  } else {
    // Default = cockpit: borrar la cookie de opt-out.
    jar.delete("mp_shell");
  }
  return redirectTo("/operator");
}

export const GET = secureApi(GETHandler);
