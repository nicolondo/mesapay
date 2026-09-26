import { describe, expect, it } from "vitest";
import {
  COMPACT_LINE_SPACING_DOTS,
  DEFAULT_LINE_SPACING,
  chunk,
  columnsForWidth,
  itemRow,
  lineSpacing,
  pairRows,
  qr,
  selectFont,
  smallColumnsForWidth,
  wrap,
} from "./commands";

/**
 * Los comandos nuevos de la factura electrónica, byte a byte. Igual que
 * los snapshots de la tirilla: del otro lado hay una térmica en una caja
 * a 500 km, y un byte corrido en `GS ( k` es un QR que no sale o una
 * impresora que se traba.
 */
describe("qr — GS ( k", () => {
  it("emite los cinco comandos en orden: modelo 2, módulo 4, corrección M, datos, imprimir", () => {
    expect(qr("AB").toString("hex")).toBe(
      "1d286b040031413200" + // fn 65: modelo 2
        "1d286b0300314304" + // fn 67: módulo de 4 puntos
        "1d286b0300314531" + // fn 69: corrección M (49)
        "1d286b0500315030" + // fn 80: guardar; pL pH = 2 + 3 = 5
        "4142" + // "AB"
        "1d286b0300315130", // fn 81: imprimir
    );
  });

  it("pL/pH es el largo de los datos + 3, en little endian", () => {
    // 300 + 3 = 303 = 0x012f ⇒ pL 0x2f, pH 0x01.
    const b = qr("x".repeat(300));
    const store = Buffer.from([0x1d, 0x28, 0x6b, 0x2f, 0x01, 0x31, 0x50, 0x30]);
    expect(b.indexOf(store)).toBeGreaterThan(0);
    expect(b.length).toBe(9 + 8 + 8 + 8 + 300 + 8);
  });

  it("tamaño y corrección configurables, con el módulo acotado a 1..16", () => {
    const h = qr("A", { size: 5, correction: "H" }).toString("hex");
    expect(h).toContain("1d286b0300314305");
    expect(h).toContain("1d286b0300314533");
    expect(qr("A", { size: 99 }).toString("hex")).toContain("1d286b0300314310");
    expect(qr("A", { size: 0 }).toString("hex")).toContain("1d286b0300314301");
    expect(qr("A", { correction: "L" }).toString("hex")).toContain("1d286b0300314530");
  });

  it("la URL de consulta de la DIAN viaja byte a byte, entera", () => {
    const url =
      "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=" +
      "a".repeat(96);
    const b = qr(url);
    expect(b.includes(Buffer.from(url, "latin1"))).toBe(true);
    // Y va después del encabezado de "guardar" y antes de "imprimir".
    const data = b.indexOf(Buffer.from(url, "latin1"));
    expect(b.subarray(data - 8, data - 5).toString("hex")).toBe("1d286b");
    expect(b.subarray(-8).toString("hex")).toBe("1d286b0300315130");
  });
});

describe("selectFont — ESC M", () => {
  it("A es 0 (la normal) y B es 1 (la chica)", () => {
    expect(selectFont("A").toString("hex")).toBe("1b4d00");
    expect(selectFont("B").toString("hex")).toBe("1b4d01");
  });
});

describe("smallColumnsForWidth — columnas de la fuente B", () => {
  it("80mm → 64 columnas, 58mm → 42", () => {
    expect(smallColumnsForWidth(80)).toBe(64);
    expect(smallColumnsForWidth(58)).toBe(42);
  });

  it("un CUFE (96 hex) entra en 2 renglones en 80mm y en 3 en 58mm", () => {
    expect(Math.ceil(96 / smallColumnsForWidth(80))).toBe(2);
    expect(Math.ceil(96 / smallColumnsForWidth(58))).toBe(3);
  });

  it("nunca menos columnas que la fuente normal", () => {
    for (const mm of [58, 64, 72, 80]) {
      expect(smallColumnsForWidth(mm)).toBeGreaterThanOrEqual(columnsForWidth(mm));
    }
  });
});

describe("interlineado — ESC 3 n / ESC 2", () => {
  it("ESC 3 n fija n puntos, acotado a 0..255", () => {
    expect(lineSpacing(24).toString("hex")).toBe("1b3318");
    expect(lineSpacing(0).toString("hex")).toBe("1b3300");
    expect(lineSpacing(300).toString("hex")).toBe("1b33ff");
    expect(lineSpacing(-5).toString("hex")).toBe("1b3300");
    expect(lineSpacing(22.9).toString("hex")).toBe("1b3316");
  });

  it("ESC 2 vuelve al de fábrica (sin parámetro)", () => {
    expect(DEFAULT_LINE_SPACING.toString("hex")).toBe("1b32");
  });

  it("el compacto es el alto de la fuente A: renglones pegados que no se pisan", () => {
    expect(COMPACT_LINE_SPACING_DOTS).toBe(24);
  });
});

describe("wrap — firstWidth", () => {
  it("achica sólo el primer renglón; los siguientes usan el ancho completo", () => {
    expect(
      wrap("uno dos tres cuatro cinco seis", 12, { firstWidth: 7, cont: "  " }),
    ).toEqual(["uno dos", "  tres", "  cuatro", "  cinco seis"]);
  });

  it("sin firstWidth se comporta igual que siempre", () => {
    expect(wrap("uno dos tres", 7)).toEqual(["uno dos", "tres"]);
  });

  it("una palabra más larga que el primer renglón se parte a ese ancho", () => {
    expect(wrap("abcdefghij", 8, { firstWidth: 4 })).toEqual(["abcd", "efghij"]);
  });
});

describe("itemRow — precio en el PRIMER renglón", () => {
  it("un ítem que entra va en un renglón con el precio pegado a la derecha", () => {
    expect(itemRow("2x Bretaña", "$ 12.000", 24)).toEqual(["2x Bretaña      $ 12.000"]);
  });

  it("un nombre largo sigue abajo con TODO el ancho, sin repetir la columna del precio", () => {
    const out = itemRow(
      "1x Hamburguesa doble con tocineta y queso cheddar",
      "$ 45.000",
      32,
      { cont: "   " },
    );
    expect(out[0].endsWith("$ 45.000")).toBe(true);
    expect(out[0]).toHaveLength(32);
    for (const l of out.slice(1)) {
      expect(l.startsWith("   ")).toBe(true);
      expect(l).not.toContain("$");
      expect(l.length).toBeLessThanOrEqual(32);
    }
    // Con `padRow` (precio en el último, columna reservada) eran 3.
    expect(out).toHaveLength(2);
  });

  it("un valor que no deja lugar al texto cae al comportamiento de padRow", () => {
    expect(itemRow("TOTAL", "$ 1.234.567.890", 16)).toEqual([
      "TOTAL",
      " $ 1.234.567.890",
    ]);
  });
});

describe("pairRows — de a dos por renglón", () => {
  it("empareja cuando entran y deja solo al que no", () => {
    expect(pairRows(["SM1234", "Fecha 8/09/26", "Mesa 7 A4F2", "Cliente: Consumidor final"], 32)).toEqual([
      "SM1234             Fecha 8/09/26",
      "Mesa 7 A4F2",
      "Cliente: Consumidor final",
    ]);
  });

  it("uno que no entra en el renglón se parte con wrap", () => {
    expect(pairRows(["Carrera 43A #1-50, Medellín"], 12)).toEqual([
      "Carrera 43A",
      "#1-50,",
      "Medellín",
    ]);
  });
});

describe("chunk — partir a lo bruto", () => {
  it("renglones de exactamente width caracteres, el último con lo que sobra", () => {
    expect(chunk("CUFE: abcdefghij", 7)).toEqual(["CUFE: a", "bcdefgh", "ij"]);
    expect(chunk("", 7)).toEqual([]);
  });
});
