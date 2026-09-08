// @ts-check
/**
 * Regenera `src/lib/dane/municipios.json` desde la fuente oficial.
 *
 * POR QUÉ EXISTE ESTE SCRIPT (y por qué el JSON está commiteado):
 * el código DANE del municipio viaja dentro de la factura electrónica
 * (cac:Address/cbc:ID) y define qué punto de facturación resuelve la
 * DIAN. Un código equivocado = factura rechazada. Entonces el catálogo
 * NO se escribe a mano ni se genera "de memoria": se baja del dataset
 * DIVIPOLA que publica el DANE y se verifica antes de escribirlo.
 *
 * Está commiteado (y no se baja en runtime) porque la búsqueda tiene
 * que funcionar sin depender de que datos.gov.co esté arriba, y porque
 * así el diff de un cambio de catálogo se revisa en el PR.
 *
 * FUENTE
 *   datos.gov.co — dataset `gdxc-w37w`, "DIVIPOLA- Códigos municipios".
 *   owner/tableAuthor: "Departamento Administrativo Nacional de
 *   Estadística - DANE"; provenance: "official".
 *   Descripción del dataset: "Actualización a corte 30 diciembre 2024".
 *
 * VERIFICACIÓN CRUZADA (hecha al generar; ver también municipios.test.ts)
 *   Se contrastó contra `pqwj-3fi4` ("MinSalud Divipola - Municipios",
 *   publicado por el Ministerio de Salud, copia independiente de la
 *   misma DIVIPOLA): 1.122 municipios en ambos, 1.120 códigos idénticos
 *   con el MISMO departamento asignado. Las 2 diferencias son
 *   renumeraciones conocidas del DANE que MinSalud todavía no refleja
 *   (27086 "Belén de Bajirá" → 27493 "Nuevo Belén de Bajirá", por el
 *   diferendo Chocó/Antioquia; y 94663 "Mapiripana" → 94885 "La
 *   Guadalupe" en Guainía). Gana el DANE, que es la autoridad.
 *
 * USO
 *   node scripts/generate-dane-municipios.mjs
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATASET_ID = "gdxc-w37w";
const CSV_URL = `https://www.datos.gov.co/api/views/${DATASET_ID}/rows.csv?accessType=DOWNLOAD`;
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/dane/municipios.json",
);

/** Conectores que en toponimia española van en minúscula salvo al inicio. */
const LOWER = new Set(["de", "del", "la", "las", "los", "y", "e"]);

/**
 * El DANE publica los nombres en MAYÚSCULA SOSTENIDA ("BOGOTÁ, D.C.").
 * Los guardamos en capitalización normal porque este nombre termina
 * impreso en la factura y en la tirilla, no solo en un <select>.
 * @param {string} raw
 */
function titleCase(raw) {
  return raw
    .toLocaleLowerCase("es-CO")
    .split(/(\s+|-)/)
    .map((tok, i) => {
      if (!/\S/.test(tok)) return tok;
      // "d.c." → "D.C." (Bogotá). Cualquier sigla con puntos va en mayúscula.
      if (/^[a-záéíóúñü]\.([a-záéíóúñü]\.)+$/.test(tok)) {
        return tok.toLocaleUpperCase("es-CO");
      }
      const bare = tok.replace(/[,.]/g, "");
      if (i > 0 && LOWER.has(bare)) return tok;
      return tok.charAt(0).toLocaleUpperCase("es-CO") + tok.slice(1);
    })
    .join("");
}

/**
 * Parser CSV mínimo con soporte de comillas: el dataset trae comas
 * dentro de los campos ("BOGOTÁ, D.C.") y coordenadas con coma decimal.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const res = await fetch(CSV_URL);
if (!res.ok) {
  throw new Error(`No pude bajar el CSV del DANE: HTTP ${res.status}`);
}
const rows = parseCsv(await res.text());
const header = rows[0].map((h) => h.trim());
const iDept = header.indexOf("Código Departamento");
const iDeptName = header.indexOf("Nombre Departamento");
const iCode = header.indexOf("Código Municipio");
const iName = header.indexOf("Nombre Municipio");
if ([iDept, iDeptName, iCode, iName].some((i) => i < 0)) {
  throw new Error(
    `El CSV cambió de encabezados; abortamos antes de escribir basura. Header: ${header.join(" | ")}`,
  );
}

const municipios = rows.slice(1).map((r) => ({
  code: r[iCode].trim(),
  name: titleCase(r[iName].trim()),
  deptCode: r[iDept].trim(),
  deptName: titleCase(r[iDeptName].trim()),
}));

// --- Verificación: si algo de esto falla NO escribimos el archivo. ------
const errores = [];
if (municipios.length < 1100 || municipios.length > 1200) {
  errores.push(`cantidad sospechosa de municipios: ${municipios.length}`);
}
const vistos = new Set();
for (const m of municipios) {
  if (!/^\d{5}$/.test(m.code)) errores.push(`código no son 5 dígitos: ${m.code}`);
  if (!/^\d{2}$/.test(m.deptCode))
    errores.push(`departamento no son 2 dígitos: ${m.deptCode} (${m.code})`);
  if (!m.code.startsWith(m.deptCode))
    errores.push(`${m.code} no empieza por su departamento ${m.deptCode}`);
  if (vistos.has(m.code)) errores.push(`código duplicado: ${m.code}`);
  vistos.add(m.code);
  if (!m.name) errores.push(`municipio sin nombre: ${m.code}`);
}
// Anclas conocidas: si el catálogo se corrompe, estas son las primeras
// que lo delatan (Envigado es el caso real que motivó todo esto).
for (const [code, name] of [
  ["11001", "Bogotá, D.C."],
  ["05266", "Envigado"],
  ["05001", "Medellín"],
  // Ojo: el DANE nombra a Cali "Santiago de Cali" y a Cartagena
  // "Cartagena de Indias". Guardamos el nombre oficial (es el que va a
  // la factura); la búsqueda igual los encuentra por subcadena.
  ["76001", "Santiago de Cali"],
  ["13001", "Cartagena de Indias"],
]) {
  const m = municipios.find((x) => x.code === code);
  if (!m || m.name !== name) {
    errores.push(`ancla rota: ${code} debería ser ${name}, es ${m?.name}`);
  }
}
if (errores.length) {
  console.error(errores.join("\n"));
  throw new Error("El catálogo DANE no pasó la verificación; no escribo nada.");
}

municipios.sort(
  (a, b) => a.deptName.localeCompare(b.deptName, "es") || a.name.localeCompare(b.name, "es"),
);

// Una línea por municipio: el diff de un PR se lee.
const json =
  "[\n" +
  municipios
    .map(
      (m) =>
        `  { "code": ${JSON.stringify(m.code)}, "name": ${JSON.stringify(m.name)}, "deptCode": ${JSON.stringify(m.deptCode)}, "deptName": ${JSON.stringify(m.deptName)} }`,
    )
    .join(",\n") +
  "\n]\n";
writeFileSync(OUT, json, "utf8");
console.log(
  `OK — ${municipios.length} municipios, ${new Set(municipios.map((m) => m.deptCode)).size} departamentos → ${OUT}`,
);
