import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { auth } from "@/auth";
import { IMPERSONATE_COOKIE } from "@/lib/activeRestaurant";
import {
  deleteRestaurant,
  getDeletionPreview,
  isRestaurantDeletionError,
  type RestaurantDeletionErrorCode,
} from "@/lib/restaurantDeletion";

export const dynamic = "force-dynamic";

/**
 * Eliminar un comercio con TODA su información (src/lib/restaurantDeletion).
 *
 *   GET  → lo que se va a borrar (conteos), bloqueos y avisos, para el diálogo.
 *   POST { confirmSlug } → borra. Irreversible: el slug se vuelve a validar acá.
 *
 * Sólo platform_admin, verificado contra la sesión del servidor. El rol sale
 * del JWT revalidado contra la base (src/auth.ts) e impersonar NO lo cambia:
 * un group_admin u operador "dentro" de un comercio sigue sin poder borrarlo.
 */
const bodySchema = z.object({ confirmSlug: z.string().max(200) });

const STATUS: Record<RestaurantDeletionErrorCode, number> = {
  not_found: 404,
  confirm_mismatch: 400,
  blocked: 409,
  archive_too_large: 409,
  leftover_rows: 409,
  concurrent_activity: 409,
};

async function requirePlatformAdmin() {
  const session = await auth();
  if (!session?.user) return { denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (session.user.role !== "platform_admin") {
    return { denied: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { session };
}

async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, denied } = await requirePlatformAdmin();
  if (!session) return denied;
  const { id } = await params;
  const preview = await getDeletionPreview(id);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
}

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, denied } = await requirePlatformAdmin();
  if (!session) return denied;
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  try {
    const result = await deleteRestaurant({
      restaurantId: id,
      confirmSlug: parsed.data.confirmSlug,
      actor: { id: session.user.id ?? null, email: session.user.email ?? "", role: session.user.role },
    });
    // Si este admin estaba "dentro" del comercio, la cookie ya no apunta a
    // nada. Las de otros admins las ignora getActiveContext (el comercio
    // ya no existe).
    const jar = await cookies();
    if (jar.get(IMPERSONATE_COOKIE)?.value === id) jar.delete(IMPERSONATE_COOKIE);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (isRestaurantDeletionError(error)) {
      return NextResponse.json(
        { error: error.code, blockers: error.details.blockers, leftovers: error.details.leftovers },
        { status: STATUS[error.code] },
      );
    }
    throw error;
  }
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
