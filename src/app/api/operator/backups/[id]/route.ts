import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import {
  deleteBackup,
  isBackupError,
  RESTORE_CONFIRM_WORD,
  restoreSnapshot,
} from "@/lib/backups";

export const dynamic = "force-dynamic";

const ALLOWED = ["operator", "platform_admin", "group_admin"] as const;

const restoreSchema = z.object({
  action: z.literal("restore"),
  confirm: z.string().optional(),
});

async function scoped() {
  const scope = await requireOperatorScope(ALLOWED);
  if (isScopeError(scope)) {
    return {
      response: NextResponse.json(
        { error: scope.error },
        { status: scope.error === "forbidden" ? 403 : 400 },
      ),
    };
  }
  return { scope };
}

async function DELETEHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { scope, response } = await scoped();
  if (!scope) return response;
  const { id } = await params;
  const deleted = await deleteBackup(scope.restaurantId, id);
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/**
 * POST { action: "restore", confirm: "RESTAURAR" } — reemplaza todos los
 * datos del comercio por los de esta copia. Antes guarda una copia
 * `pre_restore` del estado actual. Ver src/lib/backups/restore.ts.
 */
async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { scope, response } = await scoped();
  if (!scope) return response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = restoreSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (parsed.data.confirm !== RESTORE_CONFIRM_WORD) {
    return NextResponse.json({ error: "confirm_required" }, { status: 400 });
  }
  try {
    const result = await restoreSnapshot({
      restaurantId: scope.restaurantId,
      backupId: id,
      actorId: scope.userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (isBackupError(error)) {
      const status = error.code === "backup_not_found" ? 404 : 409;
      return NextResponse.json(
        { error: error.code, missing: error.details.missing },
        { status },
      );
    }
    throw error;
  }
}

export const DELETE = secureApi(DELETEHandler);
export const POST = secureApi(POSTHandler);
