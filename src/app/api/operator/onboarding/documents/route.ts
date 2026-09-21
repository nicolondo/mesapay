import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  deliverDocumentToSftp,
  fileNameForSftpDocument,
  removeDocumentFromSftp,
} from "@/lib/onboardingSftp";

const MAX_BYTES = 10 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const DocumentKind = z.enum([
  "cedula_rep_legal",
  "rut",
  "camara_comercio",
  "bank_cert",
  "origen_fondos",
  "estados_financieros",
  "estatutos",
  "other",
]);

function uploadDir() {
  // Kept under the same UPLOAD_DIR as menu photos so nginx + activate.sh
  // already serve them. Onboarding docs live in a separate subdir to keep
  // them out of /uploads/ listings if anyone ever indexes them.
  return path.join(
    process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads"),
    "onboarding",
  );
}

async function POSTHandler(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin" && session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid form" }, { status: 400 });
  }
  const file = form.get("file");
  const kindRaw = form.get("kind");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  const kindParse = DocumentKind.safeParse(kindRaw);
  if (!kindParse.success) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  const kind = kindParse.data;

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "archivo demasiado grande (máx 10MB)" },
      { status: 413 },
    );
  }
  const ext = MIME_EXT[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "formato no soportado (usa JPG, PNG, WebP o PDF)" },
      { status: 415 },
    );
  }

  // Cada ficha del wizard es UN documento por tipo: subir otro del mismo tipo
  // es un reemplazo. Antes quedaban dos filas y el nuevo nunca llegaba al SFTP
  // porque el nombre remoto es por tipo ("RUT.pdf") y la entrega abortaba con
  // sftp_document_name_conflict. `other` admite varios y no se reemplaza.
  const previous =
    kind === "other"
      ? []
      : await db.kushkiDocument.findMany({
          where: { restaurantId, kind },
          select: {
            id: true,
            kind: true,
            mimeType: true,
            fileUrl: true,
            sftpUploadedAt: true,
            restaurant: { select: { legalName: true, taxId: true } },
          },
        });

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const name = `${restaurantId}_${randomBytes(8).toString("hex")}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, name), buf);

  // Alta del nuevo y baja de los reemplazados en una sola transacción: nunca
  // queda el comercio sin documento de ese tipo ni con dos a la vez.
  const doc = await db.$transaction(async (tx) => {
    const created = await tx.kushkiDocument.create({
      data: {
        restaurantId,
        uploadedById: session.user.id ?? null,
        kind,
        fileUrl: `/uploads/onboarding/${name}`,
        fileName: file.name.slice(0, 200),
        mimeType: file.type,
        fileSize: file.size,
      },
    });
    if (previous.length > 0) {
      await tx.kushkiDocument.deleteMany({
        where: { id: { in: previous.map((p) => p.id) } },
      });
    }
    return created;
  });

  // Limpieza best-effort de los reemplazados, sin bloquear la respuesta:
  // el archivo local se borra; en el SFTP sólo hay que borrar si el nombre
  // remoto cambió (distinta extensión) — si es el mismo, el `put` del nuevo
  // lo sobreescribe y no queda nada huérfano.
  const newRemoteName = fileNameForSftpDocument(doc);
  for (const p of previous) {
    void unlink(path.join(dir, path.basename(p.fileUrl))).catch(
      () => undefined,
    );
    if (p.sftpUploadedAt && fileNameForSftpDocument(p) !== newRemoteName) {
      void removeDocumentFromSftp(p);
    }
  }

  // Sólo un comercio que todavía no empezó pasa a "documentos cargados": un
  // reemplazo durante la revisión no puede bajar el estado del comercio.
  await db.restaurant.updateMany({
    where: { id: restaurantId, kushkiOnboardingStatus: "not_started" },
    data: { kushkiOnboardingStatus: "docs_uploaded" },
  });

  // Entrega best-effort por SFTP (AWS Transfer) a una carpeta por comercio.
  // Fire-and-forget: no bloqueamos la respuesta; un cron reintenta si falla.
  // Solo corre si el SFTP está configurado (env del server). Las filas
  // reemplazadas ya no existen, así que no hay conflicto de nombre.
  void deliverDocumentToSftp(doc.id);

  return NextResponse.json({
    ok: true,
    document: doc,
    replacedIds: previous.map((p) => p.id),
  });
}

async function GETHandler() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }
  const docs = await db.kushkiDocument.findMany({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ documents: docs });
}

async function DELETEHandler(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin" && session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }
  const doc = await db.kushkiDocument.findUnique({ where: { id } });
  if (!doc || doc.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await db.kushkiDocument.delete({ where: { id } });
  // We intentionally leave the file on disk — cheap, and avoids losing it if
  // a deletion was accidental. A cron can sweep orphaned files later.
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);

export const GET = secureApi(GETHandler);

export const DELETE = secureApi(DELETEHandler);
