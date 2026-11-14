// @ts-check
/**
 * Regenera los catálogos del DOCUMENTO SOPORTE que no existen en otro lado
 * del repo:
 *   · src/lib/dian/supportDocument/data/postalCodes.json — tabla 16.4.4
 *     «Código postal» (DSAJ73: rechazo si el código del vendedor residente
 *     no está en la tabla).
 *   · src/lib/dian/supportDocument/data/countries.json — tabla 16.4.1
 *     «Países» (DSAJ16/DSAJ17: código alfa-2 y "Nombre común" del país del
 *     vendedor no residente).
 *
 * FUENTE: «Caja de herramientas Documento Soporte — Validación previa»,
 * versión 1.1, publicada por la DIAN:
 *   https://www.dian.gov.co/impuestos/factura-electronica/Documents/Caja_de_herramientas_Documento_Soporte_Validacion_Previa.zip
 * Listas genericode `Listas de valores/CodigoPostal-2.1.gc` y `Paises-2.1.gc`.
 *
 * Uso: descomprimir el zip y correr
 *   node scripts/generate-dian-ds-catalogs.mjs "<ruta a 'Listas de valores'>"
 * Los JSON van commiteados (igual que los municipios DANE): la validación no
 * depende de que la DIAN esté arriba y el diff de un cambio se revisa en el PR.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Uso: node scripts/generate-dian-ds-catalogs.mjs <carpeta 'Listas de valores'>");
  process.exit(1);
}
const out = path.resolve("src/lib/dian/supportDocument/data");

/** Filas de una lista genericode: [[valor columna 1, valor columna 2…], …]. */
function rows(file) {
  const xml = readFileSync(path.join(dir, file), "utf8");
  return [...xml.matchAll(/<Row>([\s\S]*?)<\/Row>/g)].map((m) =>
    [...m[1].matchAll(/<SimpleValue>([^<]*)<\/SimpleValue>/g)].map((v) => v[1].trim()),
  );
}

const postal = [...new Set(rows("CodigoPostal-2.1.gc").map((r) => r[0]))]
  .filter((c) => /^\d{6}$/.test(c))
  .sort();
if (postal.length < 3000) throw new Error(`Muy pocos códigos postales: ${postal.length}`);
writeFileSync(path.join(out, "postalCodes.json"), JSON.stringify(postal) + "\n");

const countries = rows("Paises-2.1.gc")
  .filter((r) => /^[A-Z]{2}$/.test(r[0]) && r[1])
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.code.localeCompare(b.code));
if (!countries.some((c) => c.code === "CO" && c.name === "Colombia")) throw new Error("Falta Colombia");
writeFileSync(path.join(out, "countries.json"), JSON.stringify(countries) + "\n");

console.log(`postalCodes: ${postal.length} · countries: ${countries.length}`);
