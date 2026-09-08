import { describe, it, expect } from "vitest";
import {
  DANE_MUNICIPIOS,
  findMunicipioByCode,
  isValidMunicipioCode,
  municipioLabel,
  searchMunicipios,
  suggestMunicipioFromText,
} from "./municipios";

/**
 * Estas pruebas son el chequeo de integridad del catálogo: si alguien
 * regenera `municipios.json` con una fuente mala, o lo edita a mano y
 * mete un código de 4 dígitos, esto lo caza antes del deploy. Un código
 * DANE malo = factura electrónica rechazada por la DIAN.
 */
describe("catálogo DANE de municipios", () => {
  it("tiene la cantidad de municipios que publica el DANE (1.122)", () => {
    // DIVIPOLA a corte 30-dic-2024: 1.104 municipios + 18 áreas no
    // municipalizadas. Si el DANE crea o fusiona municipios este número
    // cambia y el test debe actualizarse a conciencia, no a la ligera.
    expect(DANE_MUNICIPIOS.length).toBe(1122);
  });

  it("cubre los 33 departamentos (32 + Bogotá D.C.)", () => {
    const deptos = new Set(DANE_MUNICIPIOS.map((m) => m.deptCode));
    expect(deptos.size).toBe(33);
  });

  it("todo código de municipio son 5 dígitos y empieza por su departamento", () => {
    const malos = DANE_MUNICIPIOS.filter(
      (m) =>
        !/^\d{5}$/.test(m.code) ||
        !/^\d{2}$/.test(m.deptCode) ||
        !m.code.startsWith(m.deptCode),
    );
    expect(malos).toEqual([]);
  });

  it("no tiene códigos duplicados", () => {
    const codes = DANE_MUNICIPIOS.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("no tiene nombres vacíos ni en MAYÚSCULA SOSTENIDA", () => {
    // El DANE publica en mayúscula sostenida; el generador normaliza,
    // porque este nombre se imprime en la factura y en la tirilla.
    const malos = DANE_MUNICIPIOS.filter(
      (m) => !m.name.trim() || !m.deptName.trim() || m.name === m.name.toUpperCase(),
    );
    expect(malos).toEqual([]);
  });

  it("cada departamento es consistente: un código, un nombre", () => {
    const porCodigo = new Map<string, Set<string>>();
    for (const m of DANE_MUNICIPIOS) {
      const set = porCodigo.get(m.deptCode) ?? new Set<string>();
      set.add(m.deptName);
      porCodigo.set(m.deptCode, set);
    }
    const inconsistentes = [...porCodigo].filter(([, n]) => n.size !== 1);
    expect(inconsistentes).toEqual([]);
  });

  it("trae los códigos reales que ya nos rechazó la DIAN", () => {
    // Envigado es el caso que originó todo: las facturas salían con el
    // código de Bogotá y la DIAN respondía FAB10a/FAJ50.
    expect(findMunicipioByCode("05266")).toMatchObject({
      name: "Envigado",
      deptCode: "05",
      deptName: "Antioquia",
    });
    expect(findMunicipioByCode("11001")).toMatchObject({
      name: "Bogotá, D.C.",
      deptCode: "11",
    });
    expect(findMunicipioByCode("05001")?.name).toBe("Medellín");
    // Nombres oficiales DANE: no son "Cali" ni "Cartagena".
    expect(findMunicipioByCode("76001")?.name).toBe("Santiago de Cali");
    expect(findMunicipioByCode("13001")?.name).toBe("Cartagena de Indias");
  });

  it("findMunicipioByCode y isValidMunicipioCode rechazan lo que no existe", () => {
    expect(findMunicipioByCode("99999")).toBeNull();
    expect(findMunicipioByCode(null)).toBeNull();
    expect(findMunicipioByCode("")).toBeNull();
    expect(isValidMunicipioCode("05266")).toBe(true);
    expect(isValidMunicipioCode("5266")).toBe(false);
    expect(isValidMunicipioCode("99999")).toBe(false);
  });
});

describe("searchMunicipios", () => {
  it("ignora tildes y mayúsculas", () => {
    for (const q of ["Medellín", "medellin", "MEDELLIN", "medellín"]) {
      expect(searchMunicipios(q)[0]?.code).toBe("05001");
    }
    expect(searchMunicipios("bogota")[0]?.code).toBe("11001");
    expect(searchMunicipios("envigado")[0]?.code).toBe("05266");
  });

  it("encuentra por palabra interna: 'cali' → Santiago de Cali", () => {
    const codes = searchMunicipios("cali").map((m) => m.code);
    expect(codes).toContain("76001");
  });

  it("permite desambiguar con el departamento", () => {
    // Hay varias "Providencia"; escribir el departamento acota.
    const nariño = searchMunicipios("providencia, nariño");
    expect(nariño.map((m) => m.code)).toContain("52565");
    const varias = searchMunicipios("providencia");
    expect(varias.length).toBeGreaterThan(1);
  });

  it("busca por código DANE", () => {
    expect(searchMunicipios("05266")[0]?.code).toBe("05266");
    expect(searchMunicipios("052").every((m) => m.code.startsWith("052"))).toBe(
      true,
    );
  });

  it("no devuelve nada con menos de 2 caracteres (no manda 1.122 filas)", () => {
    expect(searchMunicipios("")).toEqual([]);
    expect(searchMunicipios("m")).toEqual([]);
  });

  it("respeta el límite pedido", () => {
    expect(searchMunicipios("san", 5).length).toBe(5);
    expect(searchMunicipios("san", 8).length).toBe(8);
  });

  it("devuelve vacío para basura", () => {
    expect(searchMunicipios("zzzzqqq")).toEqual([]);
  });
});

describe("municipioLabel", () => {
  it("muestra 'Municipio, Departamento'", () => {
    expect(municipioLabel(findMunicipioByCode("05266")!)).toBe(
      "Envigado, Antioquia",
    );
  });

  it("no repite Bogotá dos veces", () => {
    expect(municipioLabel(findMunicipioByCode("11001")!)).toBe("Bogotá, D.C.");
  });
});

describe("suggestMunicipioFromText (comercios que ya existen)", () => {
  it("sugiere solo cuando el texto libre es inequívoco", () => {
    expect(suggestMunicipioFromText("Envigado")?.code).toBe("05266");
    expect(suggestMunicipioFromText("  medellin ")?.code).toBe("05001");
    expect(suggestMunicipioFromText("Envigado, Antioquia")?.code).toBe("05266");
    expect(suggestMunicipioFromText("Bogotá")?.code).toBe("11001");
    expect(suggestMunicipioFromText("Bogota D.C.")?.code).toBe("11001");
  });

  it("NO adivina cuando hay ambigüedad o el texto no calza", () => {
    // Varios municipios se llaman igual: adivinar acá manda las
    // facturas al municipio equivocado.
    expect(suggestMunicipioFromText("Providencia")).toBeNull();
    // Nada de match difuso ni por prefijo.
    expect(suggestMunicipioFromText("Envig")).toBeNull();
    expect(suggestMunicipioFromText("Medellin, Antioquia (sede norte)")).toBeNull();
    expect(suggestMunicipioFromText("Ciudad de México")).toBeNull();
    expect(suggestMunicipioFromText("")).toBeNull();
    expect(suggestMunicipioFromText(null)).toBeNull();
  });
});
