import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
};

function uploadDir() {
  const base =
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");
  return path.join(base, "crm");
}

export async function GET() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const docs = await db.crmDocument.findMany({
    where: {
      OR: [
        { scope: "global" },
        { scope: "user", ownerUserId: ctx.userId },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ documents: docs });
}

export async function POST(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const ext = ALLOWED_MIME[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "unsupported_format" },
      { status: 415 },
    );
  }

  const rawScope = form.get("scope");
  const scope =
    rawScope === "global" && ctx.role === "platform_admin" ? "global" : "user";

  const rawName = form.get("name");
  const docName =
    typeof rawName === "string" && rawName.trim()
      ? rawName.trim()
      : file.name;

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });

  const filename = `${randomBytes(12).toString("hex")}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, filename), buf);

  const fileUrl = `/uploads/crm/${filename}`;

  const doc = await db.crmDocument.create({
    data: {
      name: docName,
      fileUrl,
      mime: file.type,
      size: file.size,
      scope,
      ownerUserId: scope === "user" ? ctx.userId : null,
    },
  });

  return NextResponse.json({ document: doc }, { status: 201 });
}
