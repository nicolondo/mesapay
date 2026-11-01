// Iconos de la PWA "MP CRM" (/comercial/*).
//
// Genera, a partir de un SVG armado acá mismo, los PNG que referencia
// /api/manifest/comercial y el layout de /comercial:
//
//   public/icons/crm-192.png           any       (esquinas redondeadas, fondo transparente afuera)
//   public/icons/crm-512.png           any
//   public/icons/crm-512-maskable.png  maskable  (fondo a sangre: Android recorta la forma)
//   public/icons/crm-180.png           apple-touch-icon (a sangre: iOS redondea él)
//
// Diseño: fondo terracota y, en hueso, el glifo "Pipeline" de la barra inferior
// del CRM (ComercialBottomNav): tres barras verticales redondeadas de alturas
// crecientes. Sin texto a propósito — sharp no garantiza tipografías.
//
// Uso:  node scripts/icons/crm-icon.mjs
// `sharp` llega como dependencia transitiva de Next (no hace falta instalar nada).

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "public", "icons");

const TERRACOTTA = "#C4532B";
const BONE = "#F5EFE4";

// Lienzo de diseño; cada PNG se rasteriza directo al tamaño pedido (sin
// reescalar bitmaps) poniendo width/height en el <svg>.
const CANVAS = 512;
// Esquinas de la versión "any" (~22 %, la proporción del squircle de iOS).
const CORNER = Math.round(CANVAS * 0.22);
// Ancho del glifo relativo al lienzo. En las versiones a sangre deja ≥ 26 %
// de margen a cada lado (la zona segura de los iconos maskable exige ≥ 20 %).
const GLYPH_SCALE = 0.48;

// Glifo original (viewBox 20×20 de ComercialBottomNav): barras de 4 de ancho,
// esquinas rx=1, en una caja de 16×14 (x 2→18, y 3→17). Expresado en unidades
// de esa caja: [x, y, alto].
const BARS = [
  [0, 7, 7],
  [6, 3, 11],
  [12, 0, 14],
];

function buildSvg({ size, fullBleed }) {
  const glyphW = CANVAS * GLYPH_SCALE;
  const unit = glyphW / 16;
  const glyphH = 14 * unit;
  const ox = (CANVAS - glyphW) / 2;
  const oy = (CANVAS - glyphH) / 2;
  const fmt = (n) => Number(n.toFixed(2));

  const bars = BARS.map(
    ([x, y, h]) =>
      `<rect x="${fmt(ox + x * unit)}" y="${fmt(oy + y * unit)}" width="${fmt(4 * unit)}" height="${fmt(h * unit)}" rx="${fmt(unit)}" fill="${BONE}"/>`,
  ).join("");

  const radius = fullBleed ? 0 : CORNER;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${CANVAS} ${CANVAS}"><rect width="${CANVAS}" height="${CANVAS}" rx="${radius}" fill="${TERRACOTTA}"/>${bars}</svg>`;
}

const TARGETS = [
  { file: "crm-192.png", size: 192, fullBleed: false },
  { file: "crm-512.png", size: 512, fullBleed: false },
  { file: "crm-512-maskable.png", size: 512, fullBleed: true },
  { file: "crm-180.png", size: 180, fullBleed: true },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const t of TARGETS) {
    const out = path.join(OUT_DIR, t.file);
    const svg = Buffer.from(buildSvg(t));
    await sharp(svg).png({ compressionLevel: 9 }).toFile(out);
    const meta = await sharp(out).metadata();
    if (meta.width !== t.size || meta.height !== t.size) {
      throw new Error(`${t.file}: esperado ${t.size}×${t.size}, salió ${meta.width}×${meta.height}`);
    }
    console.log(`${path.relative(ROOT, out)}  ${meta.width}×${meta.height}  ${t.fullBleed ? "a sangre" : "esquinas redondeadas"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
