import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { recordAuditEvent } from "@/lib/auditLog";
import { getDeletedRestaurantArchive } from "@/lib/restaurantDeletion";

export const dynamic = "force-dynamic";

/**
 * Descarga del archivo final (ZIP) de un comercio eliminado. Sólo
 * platform_admin: trae datos personales y documentos fiscales. Cada descarga
 * queda en la auditoría de plataforma.
 */
async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.user.role !== "platform_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const archive = await getDeletedRestaurantArchive(id);
  if (!archive) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await recordAuditEvent({
    kind: "restaurant.archive.download",
    restaurantId: null,
    target: { type: "deleted_restaurant_archive", id: archive.id },
    summary: `Descargó el archivo final de ${archive.name} (/${archive.slug})`,
  });

  const day = archive.deletedAt.toISOString().slice(0, 10);
  const slug = archive.slug.replace(/[^a-zA-Z0-9_-]/g, "_");
  return new NextResponse(archive.archive, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="mesapay-archive-${slug}-${day}.zip"`,
      "Content-Length": String(archive.archive.length),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Archive-Sha256": archive.archiveSha256,
    },
  });
}

export const GET = secureApi(GETHandler);
