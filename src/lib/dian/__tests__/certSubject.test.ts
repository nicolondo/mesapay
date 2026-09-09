// El DN del certificado se muestra en /operator/settings/facturacion-dian.
// Estos tests fijan los dos defectos reales que reportó el comercio: los
// "undefined=" (OIDs que node-forge no conoce) y el apellido roto (UTF-8
// leído como latin1). Si alguien rompe esto, la pantalla vuelve a mostrar
// un volcado ilegible.
import { describe, expect, it } from "vitest";
import { fixLatin1Mojibake, parseCertSubject } from "../certSubject";

// "Ñ" en UTF-8 son los bytes C3 91; leídos como latin1 dan "Ã" más
// un carácter de control invisible (U+0091). Se escribe con escapes a
// propósito: pegado literal no se distingue de un "Ã" suelto.
const ENIE_ROTA = "\u00c3\u0091";

/** El subject exacto que quedó guardado para Son y Melona. */
const REAL_DN =
  `surname=LONDO${ENIE_ROTA}O ARANGO, streetAddress=CR 6 24 A SUR 285 LC 112, ` +
  "ST=ANTIOQUIA, OU=FACTURA ELECTRONICA, serialNumber=2448296, " +
  "undefined=9019444691, undefined=1037604600, O=SON Y MELONA S.A.S., " +
  "L=ENVIGADO, givenName=JUAN, C=CO, CN=SON Y MELONA S.A.S.";

describe("fixLatin1Mojibake", () => {
  it("repara UTF-8 leído como latin1", () => {
    expect(fixLatin1Mojibake(`LONDO${ENIE_ROTA}O`)).toBe("LONDOÑO");
  });

  it("deja intacto un texto que ya está bien decodificado", () => {
    expect(fixLatin1Mojibake("LONDOÑO ARANGO")).toBe("LONDOÑO ARANGO");
    expect(fixLatin1Mojibake("SON Y MELONA S.A.S.")).toBe("SON Y MELONA S.A.S.");
    // Con caracteres fuera de latin1 no hay nada que reinterpretar.
    expect(fixLatin1Mojibake("東京")).toBe("東京");
  });

  it("devuelve el original si la reinterpretación no es UTF-8 válido", () => {
    // C2 80 FF: el FF suelto no existe en UTF-8 → TextDecoder tira y
    // nos quedamos con el texto tal cual (nunca propagamos la excepción).
    const roto = "\u00c2\u0080\u00ff";
    expect(fixLatin1Mojibake(roto)).toBe(roto);
  });

  it("no rompe con string vacío", () => {
    expect(fixLatin1Mojibake("")).toBe("");
  });
});

describe("parseCertSubject", () => {
  it("lee el DN real: repara el apellido y no pierde los OIDs sin nombre", () => {
    const p = parseCertSubject(REAL_DN);

    expect(p.commonName).toBe("SON Y MELONA S.A.S.");
    expect(p.organization).toBe("SON Y MELONA S.A.S.");
    expect(p.serialNumber).toBe("2448296");
    expect(p.locality).toBe("ENVIGADO");
    expect(p.state).toBe("ANTIOQUIA");
    expect(p.country).toBe("CO");

    // Orden original, todo limpio, nada descartado.
    expect(p.fields).toEqual([
      { key: "surname", value: "LONDOÑO ARANGO" },
      { key: "streetAddress", value: "CR 6 24 A SUR 285 LC 112" },
      { key: "ST", value: "ANTIOQUIA" },
      { key: "OU", value: "FACTURA ELECTRONICA" },
      { key: "serialNumber", value: "2448296" },
      // Los "undefined=" pierden el nombre del campo, NO el valor (NIT/cédula).
      { key: null, value: "9019444691" },
      { key: null, value: "1037604600" },
      { key: "O", value: "SON Y MELONA S.A.S." },
      { key: "L", value: "ENVIGADO" },
      { key: "givenName", value: "JUAN" },
      { key: "C", value: "CO" },
      { key: "CN", value: "SON Y MELONA S.A.S." },
    ]);
  });

  it("lee un DN limpio", () => {
    const p = parseCertSubject("CN=Juan Pérez, O=Acme, L=Bogotá, C=CO");
    expect(p.commonName).toBe("Juan Pérez");
    expect(p.organization).toBe("Acme");
    expect(p.locality).toBe("Bogotá");
    expect(p.country).toBe("CO");
    expect(p.state).toBeNull();
    expect(p.serialNumber).toBeNull();
    expect(p.fields).toHaveLength(4);
  });

  it("no parte un valor que lleva coma adentro", () => {
    const p = parseCertSubject("CN=Acme, O=SON Y MELONA, S.A.S., L=ENVIGADO");
    expect(p.organization).toBe("SON Y MELONA, S.A.S.");
    expect(p.locality).toBe("ENVIGADO");
    expect(p.fields).toHaveLength(3);
  });

  it("acepta los nombres largos además del shortName", () => {
    const p = parseCertSubject(
      "commonName=Acme, organizationName=Acme SAS, localityName=Medellín, " +
        "stateOrProvinceName=Antioquia, countryName=CO",
    );
    expect(p.commonName).toBe("Acme");
    expect(p.organization).toBe("Acme SAS");
    expect(p.locality).toBe("Medellín");
    expect(p.state).toBe("Antioquia");
    expect(p.country).toBe("CO");
  });

  it("trata un OID crudo como campo sin nombre", () => {
    const p = parseCertSubject("2.5.4.5=123456, CN=Acme");
    expect(p.fields[0]).toEqual({ key: null, value: "123456" });
  });

  it("con string vacío no devuelve nada", () => {
    const p = parseCertSubject("");
    expect(p.fields).toEqual([]);
    expect(p.commonName).toBeNull();
    expect(p.organization).toBeNull();
    expect(p.serialNumber).toBeNull();
    expect(p.locality).toBeNull();
    expect(p.state).toBeNull();
    expect(p.country).toBeNull();
  });
});
