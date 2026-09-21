// El adquiriente de la factura electrónica: consumidor final cuando nadie
// pidió factura, y el comensal —con el mapeo del Anexo Técnico 1.9— cuando
// cargó sus datos. Antes TODA factura salía a "Consumidor final" aunque el
// cliente hubiera dejado nombre, cédula, dirección y correo.
import { describe, expect, it, vi } from "vitest";

// emit.ts importa el cliente Prisma en el tope (claimDianDocument). Lo que
// se prueba acá es puro; se stubea para que el import no abra conexión.
vi.mock("@/lib/db", () => ({ db: {} }));

import {
  CONSUMIDOR_FINAL,
  customerPartyFor,
  resolveCustomerMunicipio,
  type InvoiceRequestParty,
} from "./emit";

function request(over: Partial<InvoiceRequestParty> = {}): InvoiceRequestParty {
  return {
    customerName: "Ana Pérez",
    docType: "CC",
    docNumber: "1.020.304.050",
    address: "Calle 1 # 2-3",
    city: "Envigado",
    department: "Antioquia",
    email: "ana@correo.com",
    ...over,
  };
}

describe("customerPartyFor — sin solicitud", () => {
  it("es el consumidor final de siempre (NIT 222222222222, tipo 13, natural)", () => {
    expect(customerPartyFor(null)).toBe(CONSUMIDOR_FINAL);
    expect(customerPartyFor(undefined)).toBe(CONSUMIDOR_FINAL);
    expect(CONSUMIDOR_FINAL).toMatchObject({
      companyId: "222222222222",
      idSchemeName: "13",
      personType: "2",
      taxLevelCode: "R-99-PN",
      taxRegimeCode: "49",
    });
  });
});

describe("customerPartyFor — tipo de documento (anexo 6.2.1)", () => {
  it.each([
    ["CC", "13"],
    ["CE", "22"],
    ["PA", "41"],
  ] as const)("%s ⇒ schemeName %s, persona natural, sin DV", (docType, scheme) => {
    const p = customerPartyFor(request({ docType, docNumber: "AB123456" }));
    expect(p.idSchemeName).toBe(scheme);
    expect(p.personType).toBe("2");
    expect(p.taxLevelCode).toBe("R-99-PN");
    expect(p.taxRegimeCode).toBe("49");
    expect(p.dv).toBeNull();
  });

  it("NIT ⇒ schemeName 31, persona jurídica, con el DV calculado", () => {
    // Son y Melona: 901944469, DV 1 — el mismo NIT que el emisor calcula.
    const p = customerPartyFor(request({ docType: "NIT", docNumber: "901944469" }));
    expect(p.idSchemeName).toBe("31");
    expect(p.personType).toBe("1");
    expect(p.companyId).toBe("901944469");
    expect(p.dv).toBe("1");
  });

  it("NIT con guión: se descarta el DV escrito y se recalcula", () => {
    const p = customerPartyFor(request({ docType: "NIT", docNumber: "901944469-9" }));
    expect(p.companyId).toBe("901944469");
    expect(p.dv).toBe("1");
  });

  it("un tipo desconocido cae a cédula (13) en vez de romper", () => {
    expect(customerPartyFor(request({ docType: "XX" })).idSchemeName).toBe("13");
  });
});

describe("customerPartyFor — identificación (NumAdq del CUFE)", () => {
  it("la cédula va sólo con dígitos: el comensal la escribe con puntos", () => {
    expect(customerPartyFor(request()).companyId).toBe("1020304050");
    expect(
      customerPartyFor(request({ docNumber: " 10 203 040 50 " })).companyId,
    ).toBe("1020304050");
  });

  it("el pasaporte conserva las letras y pierde separadores", () => {
    expect(
      customerPartyFor(request({ docType: "PA", docNumber: "AB-123 456" })).companyId,
    ).toBe("AB123456");
  });

  it("sin identificación usable sale a consumidor final (no vale un rechazo)", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(customerPartyFor(request({ docNumber: "sin número" }))).toBe(CONSUMIDOR_FINAL);
    expect(customerPartyFor(request({ customerName: "   " }))).toBe(CONSUMIDOR_FINAL);
    warned.mockRestore();
  });
});

describe("customerPartyFor — nombre, dirección y correo", () => {
  it("lleva el nombre, el correo (cac:Contact) y la dirección con municipio DANE", () => {
    const p = customerPartyFor(request());
    expect(p.name).toBe("Ana Pérez");
    expect(p.email).toBe("ana@correo.com");
    expect(p.address).toEqual({
      cityCode: "05266",
      cityName: "Envigado",
      deptCode: "05",
      deptName: "Antioquia",
      line: "Calle 1 # 2-3",
    });
  });

  it("sin correo no manda cadena vacía", () => {
    expect(customerPartyFor(request({ email: null })).email).toBeNull();
    expect(customerPartyFor(request({ email: "  " })).email).toBeNull();
  });

  it("si el municipio no resuelve, la factura sale SIN dirección en vez de inventar un código", () => {
    const p = customerPartyFor(request({ city: "Ciudad Gótica", department: "Antioquia" }));
    expect(p.address).toBeNull();
    // El resto del adquiriente sigue intacto: nombre, cédula, correo.
    expect(p.companyId).toBe("1020304050");
    expect(p.email).toBe("ana@correo.com");
  });
});

describe("customerPartyFor — nominativa SIN dirección (la solicitud ya no la pide)", () => {
  const SIN_DIRECCION = { address: null, city: null, department: null };

  it("omite el bloque de dirección y conserva nombre, documento, régimen y correo", () => {
    const con = customerPartyFor(request());
    const sin = customerPartyFor(request(SIN_DIRECCION));
    expect(sin.address).toBeNull();
    // Todo lo demás es byte-idéntico al adquiriente con dirección.
    expect({ ...sin, address: undefined }).toEqual({ ...con, address: undefined });
    expect(sin).toMatchObject({
      name: "Ana Pérez",
      companyId: "1020304050",
      idSchemeName: "13",
      personType: "2",
      taxLevelCode: "R-99-PN",
      taxRegimeCode: "49",
      email: "ana@correo.com",
    });
  });

  it("acepta los campos ausentes (undefined) o vacíos, no sólo null", () => {
    const sinCampos: InvoiceRequestParty = {
      customerName: "Ana Pérez",
      docType: "CC",
      docNumber: "1.020.304.050",
      email: "ana@correo.com",
    };
    expect(customerPartyFor(sinCampos).address).toBeNull();
    expect(customerPartyFor(request({ address: "", city: "", department: "" })).address).toBeNull();
    expect(customerPartyFor(request({ address: "  ", city: " ", department: null })).address).toBeNull();
  });

  it("NIT sin dirección: persona jurídica con DV, también sin bloque de dirección", () => {
    const p = customerPartyFor(
      request({ ...SIN_DIRECCION, docType: "NIT", docNumber: "901944469", customerName: "ACME S.A.S." }),
    );
    expect(p.address).toBeNull();
    expect(p).toMatchObject({ idSchemeName: "31", personType: "1", companyId: "901944469", dv: "1" });
  });

  it("no manda medio bloque: municipio resuelto pero sin línea de dirección ⇒ sin dirección", () => {
    expect(customerPartyFor(request({ address: null })).address).toBeNull();
    expect(customerPartyFor(request({ address: "   " })).address).toBeNull();
  });

  it("con dirección completa sigue saliendo el bloque igual que antes", () => {
    expect(customerPartyFor(request()).address).toEqual({
      cityCode: "05266",
      cityName: "Envigado",
      deptCode: "05",
      deptName: "Antioquia",
      line: "Calle 1 # 2-3",
    });
  });
});

describe("resolveCustomerMunicipio", () => {
  it("desambigua con el departamento: 'ciudad, departamento' primero", () => {
    // Hay dos "Armenia" (Antioquia y Quindío); con el departamento queda
    // una sola, y la del comensal es la que él dijo.
    expect(resolveCustomerMunicipio("Armenia", "Quindío")?.code).toBe("63001");
    expect(resolveCustomerMunicipio("Armenia", "Antioquia")?.code).toBe("05059");
    expect(resolveCustomerMunicipio("Envigado", "Antioquia")?.code).toBe("05266");
    expect(resolveCustomerMunicipio("Medellín", "Antioquia")?.code).toBe("05001");
  });

  it("rescata Bogotá aunque el departamento venga como 'Bogotá D.C.' o 'Cundinamarca'", () => {
    expect(resolveCustomerMunicipio("Bogotá", "Bogotá D.C.")?.code).toBe("11001");
    expect(resolveCustomerMunicipio("Bogotá", "Cundinamarca")?.code).toBe("11001");
    expect(resolveCustomerMunicipio("Bogota D.C.", "")?.code).toBe("11001");
  });

  it("no adivina: texto ambiguo o vacío ⇒ null", () => {
    // "Armenia" a secas pega con dos municipios: no se elige por él.
    expect(resolveCustomerMunicipio("Armenia", "")).toBeNull();
    expect(resolveCustomerMunicipio("Armenia", "Cundinamarca")).toBeNull();
    expect(resolveCustomerMunicipio("", "Antioquia")).toBeNull();
    expect(resolveCustomerMunicipio(null, null)).toBeNull();
  });
});
