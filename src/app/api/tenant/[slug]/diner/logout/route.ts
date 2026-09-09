import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { revokeCurrentDinerSession } from "@/lib/dinerSession";
import { resolveTenantId } from "@/lib/dinerTenant";

/**
 * POST /api/tenant/[slug]/diner/logout — cierra la sesión de ESTE
 * dispositivo EN ESE COMERCIO. Las cuentas del comensal en otros
 * restaurantes no se tocan: son cuentas distintas, con su propia cookie.
 *
 * Revoca la fila en DB además de borrar la cookie: si solo borráramos la
 * cookie, una copia del token (extensión, backup del navegador) seguiría
 * abriendo la cuenta.
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const restaurantId = await resolveTenantId(slug);
  if (!restaurantId) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  await revokeCurrentDinerSession(restaurantId);
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
