#!/usr/bin/env node
/**
 * Revisa el CSS que sale de `next build` contra el piso de soporte
 * (Firefox 107 del datáfono Sunmi, Chrome/WebView 99, Safari iOS 15.4).
 *
 *   node scripts/check-css-compat.mjs [carpeta]   (por defecto .next/static)
 *
 * Sale con código 1 si algo quedaría roto en ese piso. Las reglas están en
 * src/lib/css/cssCompatCheck.cjs; los respaldos los agrega el plugin
 * src/lib/css/postcssLegacyFallbacks.cjs (postcss.config.mjs) y Lightning CSS
 * según el "browserslist" de package.json.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { checkCss } = require("../src/lib/css/cssCompatCheck.cjs");

const dir = process.argv[2] ?? ".next/static";
if (!existsSync(dir)) {
  console.error(`No existe ${dir}: corre \`npm run build\` primero.`);
  process.exit(2);
}

function* cssFiles(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) yield* cssFiles(p);
    else if (name.endsWith(".css")) yield p;
  }
}

let errors = 0;
let warnings = 0;
let files = 0;
for (const file of cssFiles(dir)) {
  files++;
  const res = checkCss(readFileSync(file, "utf8"), { from: file });
  warnings += res.warnings.length;
  if (!res.errors.length) continue;
  errors += res.errors.length;
  console.error(`\n✗ ${relative(process.cwd(), file)} — ${res.errors.length} problema(s):`);
  for (const e of res.errors.slice(0, 40)) console.error(`  [${e.kind}] ${e.message}\n      ${e.where}`);
  if (res.errors.length > 40) console.error(`  … y ${res.errors.length - 40} más`);
}

if (!files) {
  console.error(`No hay archivos .css en ${dir}.`);
  process.exit(2);
}
if (errors) {
  console.error(
    `\n${errors} problema(s) de compatibilidad con Firefox 107 / Chrome 99 / Safari iOS 15.4 en ${files} archivo(s) CSS.` +
      "\nVer src/lib/css/cssCompatCheck.cjs para el porqué de cada regla.",
  );
  process.exit(1);
}
console.log(`CSS compatible con Firefox 107 / Chrome 99 / Safari iOS 15.4: ${files} archivo(s), ${warnings} aviso(s) de mejora progresiva.`);
