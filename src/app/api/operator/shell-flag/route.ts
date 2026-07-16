import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * Toggle del shell del operador. El "cockpit" es el DEFAULT; esto solo sirve
 * como escape para volver al shell anterior.
 *   GET /api/operator/shell-flag?to=classic  → fuerza el shell anterior
 *   GET /api/operator/shell-flag?to=cockpit  → vuelve al default (cockpit)
 * Setea/borra la cookie mp_shell y redirige a /operator. Requiere sesión staff.
 */
export async function GET(req: Request) {
  const session = await auth();
  const role = session?.user?.role;
  if (
    !session?.user ||
    (role !== "operator" &&
      role !== "platform_admin" &&
      role !== "group_admin")
  ) {
    return NextResponse.redirect(new URL("/signin", req.url));
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
  return NextResponse.redirect(new URL("/operator", req.url));
}
