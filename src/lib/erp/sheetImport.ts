// Lee la PRIMERA hoja de un .xlsx (buffer) y la devuelve como texto
// tabulado para pasársela a la IA. Usa jszip + @xmldom/xmldom (ya son
// dependencias del proyecto, de DIAN) — evita sumar SheetJS, que tiene
// advisories de seguridad conocidas en su versión de npm.
//
// Es un parser MÍNIMO de OOXML: shared strings + valores inline/numéricos
// de la primera worksheet. Suficiente para que la IA lea las filas; no
// pretende cubrir todo el formato (fórmulas, estilos, celdas combinadas).
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

/** "A1" → 0, "B1" → 1, "AA1" → 26. Preserva el orden de columnas. */
function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function sheetToText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);

  // Tabla de strings compartidas (opcional).
  const shared: string[] = [];
  const sst = zip.file("xl/sharedStrings.xml");
  if (sst) {
    const doc = new DOMParser().parseFromString(await sst.async("string"), "text/xml");
    const sis = doc.getElementsByTagName("si");
    for (let i = 0; i < sis.length; i++) {
      // Un <si> puede traer varios <t> (rich text) — se concatenan.
      const ts = sis[i].getElementsByTagName("t");
      let s = "";
      for (let j = 0; j < ts.length; j++) s += ts[j].textContent ?? "";
      shared.push(s);
    }
  }

  // Primera worksheet (sheet1.xml, con fallback al primer sheet*.xml).
  const sheet =
    zip.file("xl/worksheets/sheet1.xml") ??
    zip.file(/^xl\/worksheets\/sheet.*\.xml$/)[0];
  if (!sheet) return "";
  const doc = new DOMParser().parseFromString(await sheet.async("string"), "text/xml");

  const rows = doc.getElementsByTagName("row");
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].getElementsByTagName("c");
    const values: string[] = [];
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j];
      const col = colIndex(c.getAttribute("r") ?? "");
      const t = c.getAttribute("t");
      let val = "";
      if (t === "inlineStr") {
        const inl = c.getElementsByTagName("t");
        val = inl.length ? (inl[0].textContent ?? "") : "";
      } else {
        const vEls = c.getElementsByTagName("v");
        const raw = vEls.length ? (vEls[0].textContent ?? "") : "";
        val = t === "s" ? (shared[Number(raw)] ?? "") : raw;
      }
      // Rellenar columnas vacías para no correr el orden.
      while (values.length < col) values.push("");
      values.push(val.replace(/[\r\n\t]+/g, " ").trim());
    }
    lines.push(values.join("\t"));
  }
  return lines.join("\n");
}
