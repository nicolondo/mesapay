import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { auth } from "@/auth";

// 10MB de ENTRADA: las fotos de celular vienen grandes, pero acá se
// comprimen antes de guardar — el archivo final queda en decenas de KB.
const MAX_BYTES = 10 * 1024 * 1024;

const RASTER_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

// Optimización para móvil: las fotos del menú se ven en tarjetas de ~400-600px
// CSS; 1200px de lado mayor cubre pantallas 2x sin pixelar. WebP q78 + effort
// máximo da el mejor peso/calidad con soporte universal en browsers actuales.
const MAX_DIM = 1200;
const WEBP_QUALITY = 78;

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
    return NextResponse.json(
      { error: "archivo demasiado grande (máx 10MB)" },
      { status: 413 },
    );
  }

  const isSvg = file.type === "image/svg+xml";
  if (!isSvg && !RASTER_MIME.has(file.type)) {
    return NextResponse.json(
      { error: "formato no soportado (usa JPG, PNG, WebP o SVG)" },
      { status: 415 },
    );
  }

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());

  // SVG (logos): se guarda tal cual tras el sanity-check — es vectorial,
  // ya es liviano y rasterizarlo lo empeoraría.
  if (isSvg) {
    if (!svgLooksSafe(buf)) {
      return NextResponse.json(
        {
          error: "svg_unsafe",
          message:
            "El SVG contiene scripts o handlers JS. Exporta el logo sin código embebido.",
        },
        { status: 415 },
      );
    }
    const name = `${randomBytes(10).toString("hex")}.svg`;
    await writeFile(path.join(dir, name), buf);
    return NextResponse.json({ ok: true, url: `/uploads/${name}` });
  }

  // Raster: rotar según EXIF, achicar al lado mayor y recomprimir a WebP.
  // sharp descarta metadata (EXIF/GPS) por defecto — bonus de privacidad.
  let out: Buffer;
  try {
    out = await sharp(buf, { failOn: "error" })
      .rotate()
      .resize({
        width: MAX_DIM,
        height: MAX_DIM,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY, effort: 6 })
      .toBuffer();
  } catch {
    return NextResponse.json(
      { error: "imagen inválida o corrupta" },
      { status: 415 },
    );
  }

  const name = `${randomBytes(10).toString("hex")}.webp`;
  await writeFile(path.join(dir, name), out);

  return NextResponse.json({
    ok: true,
    url: `/uploads/${name}`,
    bytes: out.length,
    originalBytes: buf.length,
  });
}
