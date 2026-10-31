import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { IMPERSONATE_COOKIE } from "@/lib/activeRestaurant";
import {
  deleteRestaurant,
  getDeletionPreview,
  isRestaurantDeletionError,
  type RestaurantDeletionErrorCode,
} from "@/lib/restaurantDeletion";
import { requirePlatformAdmin } from "./guard";

export const dynamic = "force-dynamic";

/**
 * Eliminar un comercio con TODA su información (src/lib/restaurantDeletion).
 *
 *   GET  → lo que se va a borrar (conteos), bloqueos y avisos, para el diálogo.
 *   POST { confirmSlug } → borra. Irreversible: el slug se vuelve a validar acá.
 *
 * Los bloqueos que se pueden resolver desde el diálogo van por ./resolve.
 * Sólo platform_admin (./guard.ts).
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
