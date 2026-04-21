import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { auth } from "@/auth";

const MAX_BYTES = 5 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads");
}

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "archivo demasiado grande (máx 5MB)" }, { status: 413 });
  }
  const ext = MIME_EXT[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "formato no soportado (usa JPG, PNG o WebP)" },
      { status: 415 },
    );
  }

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const name = `${randomBytes(10).toString("hex")}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, name), buf);

  return NextResponse.json({
    ok: true,
    url: `/uploads/${name}`,
  });
}
