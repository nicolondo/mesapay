import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import {
  countActiveManualBackups,
  createBackup,
  isBackupError,
  listBackups,
  MAX_MANUAL_BACKUPS,
} from "@/lib/backups";

export const dynamic = "force-dynamic";

// Copias de seguridad del comercio activo. Sólo el dueño / admin: crear y
// restaurar mueven TODOS los datos del local, no es cosa de mesero.
const ALLOWED = ["operator", "platform_admin", "group_admin"] as const;

const createSchema = z.object({
  note: z.string().trim().max(200).optional(),
});

async function GETHandler() {
  const scope = await requireOperatorScope(ALLOWED);
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }
  const backups = await listBackups(scope.restaurantId);
  return NextResponse.json({ backups });
}

async function POSTHandler(req: Request) {
  const scope = await requireOperatorScope(ALLOWED);
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // Tope de manuales vigentes: cada copia pesa lo que pesa el comercio y
  // vive en la base; sin tope un dedo nervioso llena el disco.
  if ((await countActiveManualBackups(scope.restaurantId)) >= MAX_MANUAL_BACKUPS) {
    return NextResponse.json(
      { error: "too_many", max: MAX_MANUAL_BACKUPS },
      { status: 429 },
    );
  }
  try {
    const backup = await createBackup({
      restaurantId: scope.restaurantId,
      kind: "manual",
      createdById: scope.userId,
      note: parsed.data.note,
    });
    return NextResponse.json({ backup }, { status: 201 });
  } catch (error) {
    if (isBackupError(error)) {
      return NextResponse.json({ error: error.code }, { status: 404 });
    }
    throw error;
  }
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
