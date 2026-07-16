import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * Toggle del rediseño del shell del operador (rollout seguro detrás de flag).
 *   GET /api/operator/shell-flag?to=cockpit  → activa el shell nuevo
 *   GET /api/operator/shell-flag?to=classic  → vuelve al shell actual
 * Setea la cookie mp_shell y redirige a /operator. Requiere sesión staff.
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
  if (to === "cockpit") {
    jar.set("mp_shell", "cockpit", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
  } else {
    jar.delete("mp_shell");
  }
  return NextResponse.redirect(new URL("/operator", req.url));
}
