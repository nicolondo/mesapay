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
  // SVG para logos del comercio. Se renderea solo via <img src=...>
  // (no inline), así el browser no ejecuta scripts embebidos. Aún así
  // sanitizamos: rechazamos archivos que contengan <script>.
  "image/svg+xml": "svg",
};

// Quick sanity-check de SVG: bloquea archivos que contengan tags
// <script> o handlers JS típicos. No es un sanitizer completo —
// para eso usaríamos DOMPurify — pero corta los vectores más
// comunes de XSS via SVG.
function svgLooksSafe(buf: Buffer): boolean {
  const text = buf.toString("utf-8").toLowerCase();
  if (text.includes("<script")) return false;
  // onload, onclick, onerror, etc.
  if (/\son[a-z]+\s*=/i.test(buf.toString("utf-8"))) return false;
  // javascript: URLs en href / xlink:href
  if (text.includes("javascript:")) return false;
  return true;
}

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
      { error: "formato no soportado (usa JPG, PNG, WebP o SVG)" },
      { status: 415 },
    );
  }

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const name = `${randomBytes(10).toString("hex")}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  if (ext === "svg" && !svgLooksSafe(buf)) {
    return NextResponse.json(
      {
        error: "svg_unsafe",
        message:
          "El SVG contiene scripts o handlers JS. Exporta el logo sin código embebido.",
      },
      { status: 415 },
    );
  }

  await writeFile(path.join(dir, name), buf);

  return NextResponse.json({
    ok: true,
    url: `/uploads/${name}`,
  });
}
