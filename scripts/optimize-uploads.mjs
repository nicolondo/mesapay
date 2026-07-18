#!/usr/bin/env node
// Optimiza IN-PLACE las imágenes ya subidas (public/uploads o el dir que se
// pase): rota según EXIF, achica al lado mayor (1200px) y recomprime. El
// archivo conserva SU MISMO NOMBRE, así las URLs guardadas en la BD siguen
// funcionando. Solo se reemplaza si el resultado es más liviano.
//
// Uso (en el server):
//   cd /opt/mesapay/current && node scripts/optimize-uploads.mjs /opt/mesapay/shared/uploads
//
// Recomendado antes: backup con hardlinks (barato, conserva los originales
// porque acá escribimos tmp + rename, no sobre el inode):
//   cp -al /opt/mesapay/shared/uploads /opt/mesapay/shared/uploads-backup-$(date +%Y%m%d)
import { readdir, stat, rename, writeFile, unlink } from "fs/promises";
import path from "path";
import sharp from "sharp";

const dir = process.argv[2] || path.join(process.cwd(), "public", "uploads");
const MAX_DIM = 1200;
const MIN_BYTES = 20 * 1024; // < 20KB no vale la pena tocar
const CONCURRENCY = 3; // VPS compartida: sin saturar CPU

/** Recomprime un archivo según su formato. Devuelve bytes ahorrados (0 = no tocado). */
async function optimizeOne(file) {
  const ext = path.extname(file).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return { saved: 0, skipped: true };
  const full = path.join(dir, file);
  const st = await stat(full);
  if (!st.isFile() || st.size < MIN_BYTES) return { saved: 0, skipped: true };

  let pipeline = sharp(full, { failOn: "error" }).rotate().resize({
    width: MAX_DIM,
    height: MAX_DIM,
    fit: "inside",
    withoutEnlargement: true,
  });
  // Mismo formato de salida que de entrada (el nombre no cambia).
  let minGain = 0.05; // por defecto: reemplazar si ahorra ≥5%
  if (ext === ".png") {
    // PNGs pueden ser logos/transparencias: cuantizar con calidad alta y
    // exigir una ganancia clara antes de reemplazar.
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 90 });
    minGain = 0.1;
  } else if (ext === ".webp") {
    pipeline = pipeline.webp({ quality: 78, effort: 6 });
  } else {
    pipeline = pipeline.jpeg({ quality: 80, mozjpeg: true });
  }

  let out;
  try {
    out = await pipeline.toBuffer();
  } catch (err) {
    console.error(`  ✗ ${file}: ${err.message?.slice(0, 80)}`);
    return { saved: 0, skipped: true };
  }
  if (out.length >= st.size * (1 - minGain)) return { saved: 0, skipped: false };

  // tmp + rename: atómico y deja intactos los inodes del backup con hardlinks.
  const tmp = full + ".opt-tmp";
  await writeFile(tmp, out);
  await rename(tmp, full).catch(async (e) => {
    await unlink(tmp).catch(() => {});
    throw e;
  });
  return { saved: st.size - out.length, skipped: false };
}

const files = await readdir(dir);
console.log(`Optimizando ${files.length} archivos en ${dir}…`);
let saved = 0;
let touched = 0;
let processed = 0;

for (let i = 0; i < files.length; i += CONCURRENCY) {
  const batch = files.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map((f) => optimizeOne(f).catch((e) => {
    console.error(`  ✗ ${f}: ${e.message?.slice(0, 80)}`);
    return { saved: 0, skipped: true };
  })));
  for (const r of results) {
    processed++;
    if (r.saved > 0) {
      touched++;
      saved += r.saved;
    }
  }
  if (processed % 60 < CONCURRENCY) {
    console.log(`  …${processed}/${files.length} (ahorrado ${(saved / 1024 / 1024).toFixed(1)}MB)`);
  }
}

console.log(`Listo: ${touched}/${files.length} archivos optimizados, ${(saved / 1024 / 1024).toFixed(1)}MB ahorrados.`);
