import { describe, expect, it } from "vitest";
import {
  catalogoFormatos,
  concepto1001DeCategoria,
  CONCEPTOS_1001,
  isConcepto1012,
  isFormatoExogena,
  parseAnoGravable,
  resolucionesDelAno,
  umbralPagosCents,
  umbralSaldosCents,
  UVT_POR_ANO,
  uvtDelAno,
  versionFormato,
} from "./normativa";

describe("UVT por año gravable", () => {
  it("usa la tabla oficial y cae al fallback del contador cuando el año no está", () => {
    expect(uvtDelAno(2024, 1)).toBe(47065);
    expect(uvtDelAno(2025, 1)).toBe(49799);
    expect(uvtDelAno(2026, 1)).toBe(52374);
    expect(uvtDelAno(2031, 55000)).toBe(55000);
    expect(UVT_POR_ANO[2023]).toBe(42412);
  });

  it("cuantías menores: 3 UVT en pagos, 12 UVT en saldos (en centavos)", () => {
    expect(umbralPagosCents(49799)).toBe(3 * 49799 * 100);
    expect(umbralSaldosCents(49799)).toBe(12 * 49799 * 100);
  });
});

describe("versiones y catálogo por año", () => {
  it("AG 2025: 1001 v11, 1005 v9, 1006 v8, 1007 v9, 1008/1009 v7, 1010 v9, 1011 v6, 1012 v7, 2276 v4", () => {
    const v = (c: string) => versionFormato(c, 2025);
    expect([v("1001"), v("1005"), v("1006"), v("1007"), v("1008"), v("1009")]).toEqual([11, 9, 8, 9, 7, 7]);
    expect([v("1010"), v("1011"), v("1012"), v("2276"), v("1003")]).toEqual([9, 6, 7, 4, 7]);
  });

  it("AG 2024 conserva 1001 v10 y 1005 v7; AG 2026 mantiene el 1001 en v11", () => {
    expect(versionFormato("1001", 2024)).toBe(10);
    expect(versionFormato("1005", 2024)).toBe(7);
    expect(versionFormato("1001", 2026)).toBe(11);
    expect(versionFormato("1647", 2026)).toBe(3);
  });

  it("el catálogo trae los diez formatos con nombre, versión y origen; sólo el 2276 no tiene XML", () => {
    const cat = catalogoFormatos(2025);
    expect(cat.map((f) => f.codigo)).toEqual(["1001", "1005", "1006", "1007", "1008", "1009", "1010", "1011", "1012", "2276"]);
    expect(cat.every((f) => f.nombre.length > 0 && f.version > 0)).toBe(true);
    expect(cat.filter((f) => !f.xml).map((f) => f.codigo)).toEqual(["2276"]);
    expect(cat.find((f) => f.codigo === "1010")?.origen).toBe("manual");
    expect(isFormatoExogena("1001")).toBe(true);
    expect(isFormatoExogena("1003")).toBe(false);
  });

  it("rotula las resoluciones del año", () => {
    expect(resolucionesDelAno(2024)).toContain("000162/2023");
    expect(resolucionesDelAno(2025)).toContain("000227/2025");
    expect(resolucionesDelAno(2026)).toContain("000237/2025");
  });
});

describe("conceptos", () => {
  it("1001: la categoría del gasto se lleva al concepto con la heurística del PUC", () => {
    expect(concepto1001DeCategoria("Arriendo local")).toBe(CONCEPTOS_1001.ARRENDAMIENTOS);
    expect(concepto1001DeCategoria("Honorarios contador")).toBe(CONCEPTOS_1001.HONORARIOS);
    expect(concepto1001DeCategoria("Comisiones datáfono")).toBe(CONCEPTOS_1001.COMISIONES);
    expect(concepto1001DeCategoria("Intereses bancarios")).toBe(CONCEPTOS_1001.INTERESES);
    expect(concepto1001DeCategoria("Servicios públicos")).toBe(CONCEPTOS_1001.SERVICIOS);
    expect(concepto1001DeCategoria("Internet")).toBe(CONCEPTOS_1001.SERVICIOS);
    expect(concepto1001DeCategoria("Mantenimiento")).toBe(CONCEPTOS_1001.SERVICIOS);
    expect(concepto1001DeCategoria("Nómina")).toBe(CONCEPTOS_1001.SALARIOS);
    expect(concepto1001DeCategoria("Otros")).toBe(CONCEPTOS_1001.OTROS);
  });

  it("1012: sólo los conceptos del anexo", () => {
    expect(isConcepto1012("1110")).toBe(true);
    expect(isConcepto1012("1206")).toBe(true);
    expect(isConcepto1012("1315")).toBe(false);
  });
});

describe("parseAnoGravable", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  it("vacío ⇒ el año anterior; cuatro dígitos en rango ⇒ ese año; lo demás ⇒ null", () => {
    expect(parseAnoGravable(null, now)).toBe(2025);
    expect(parseAnoGravable("", now)).toBe(2025);
    expect(parseAnoGravable("2024", now)).toBe(2024);
    expect(parseAnoGravable("24", now)).toBeNull();
    expect(parseAnoGravable("1999", now)).toBeNull();
    expect(parseAnoGravable("abcd", now)).toBeNull();
  });
});
