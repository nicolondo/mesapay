import { describe, expect, it } from "vitest";
import {
  canonicalDocumentNumber,
  creditNoteMatchesSearch,
  invoiceMatchesSearch,
  parseDocumentSearch,
} from "./orderSearch";

const parse = (q: string) => {
  const s = parseDocumentSearch(q);
  if (!s) throw new Error(`no es un número de documento: ${q}`);
  return s;
};

describe("canonicalDocumentNumber", () => {
  it("sin mayúsculas, espacios, guiones ni ceros a la izquierda del consecutivo", () => {
    expect(canonicalDocumentNumber("fesm 7913")).toBe("FESM7913");
    expect(canonicalDocumentNumber(" FESM-06482 ")).toBe("FESM6482");
    expect(canonicalDocumentNumber("#0042")).toBe("42");
    expect(canonicalDocumentNumber("nc.12")).toBe("NC12");
  });
});

describe("parseDocumentSearch", () => {
  it("con prefijo: los consecutivos posibles y la nota crédito", () => {
    const s = parse("FESM7913");
    expect(s.numericOnly).toBe(false);
    expect(s.invoiceNumbers).toContain(7913);
    expect(s.creditNoteNumber).toBe("FESM7913");
  });

  it("un prefijo que termina en dígito también se contempla", () => {
    expect(parse("FE17913").invoiceNumbers).toEqual(expect.arrayContaining([17913, 7913]));
  });

  it("el número solo: exactamente ese consecutivo, sin notas crédito", () => {
    expect(parse("07913")).toEqual({ canonical: "7913", numericOnly: true, invoiceNumbers: [7913], creditNoteNumber: null });
  });

  it("no es un número de documento: sin dígitos al final, cero o fuera de rango INT4", () => {
    expect(parseDocumentSearch("")).toBeNull();
    expect(parseDocumentSearch("4F2A9C")).toBeNull();
    expect(parseDocumentSearch("FESM")).toBeNull();
    expect(parseDocumentSearch("0")).toBeNull();
    expect(parseDocumentSearch("99999999999")).toBeNull();
    // Con prefijo, los sufijos que entran en INT4 siguen siendo candidatos.
    expect(parse("FE99999999999").invoiceNumbers).not.toContain(99999999999);
  });
});

describe("invoiceMatchesSearch — el prefijo real de la factura", () => {
  const fesm = { prefix: "FESM", invoiceNumber: 7913 };
  const pos = { prefix: "POS", invoiceNumber: 7913 };
  const bare = { prefix: null, invoiceNumber: 7913 };

  it("con prefijo: sólo la de ese prefijo, sin importar mayúsculas ni espacios", () => {
    expect(invoiceMatchesSearch(parse("FESM7913"), fesm)).toBe(true);
    expect(invoiceMatchesSearch(parse("fesm 7913"), fesm)).toBe(true);
    expect(invoiceMatchesSearch(parse("FESM-07913"), fesm)).toBe(true);
    expect(invoiceMatchesSearch(parse("FESM7913"), pos)).toBe(false);
    expect(invoiceMatchesSearch(parse("FESM7913"), bare)).toBe(false);
    expect(invoiceMatchesSearch(parse("FESM791"), fesm)).toBe(false);
  });

  it("el número solo trae la factura con ese consecutivo, con cualquier prefijo", () => {
    expect(invoiceMatchesSearch(parse("7913"), fesm)).toBe(true);
    expect(invoiceMatchesSearch(parse("7913"), pos)).toBe(true);
    expect(invoiceMatchesSearch(parse("7913"), bare)).toBe(true);
    expect(invoiceMatchesSearch(parse("791"), fesm)).toBe(false);
  });

  it("prefijo con dígito final: «FE17913» es FE1 + 7913, no FE + 7913", () => {
    expect(invoiceMatchesSearch(parse("FE17913"), { prefix: "FE1", invoiceNumber: 7913 })).toBe(true);
    expect(invoiceMatchesSearch(parse("FE17913"), { prefix: "FE", invoiceNumber: 7913 })).toBe(false);
    expect(invoiceMatchesSearch(parse("FE17913"), { prefix: "FE", invoiceNumber: 17913 })).toBe(true);
  });
});

describe("creditNoteMatchesSearch", () => {
  it("con su prefijo, como el número de la nota; el número solo no", () => {
    expect(creditNoteMatchesSearch(parse("nc 12"), "NC12")).toBe(true);
    expect(creditNoteMatchesSearch(parse("NC12"), "NC-012")).toBe(true);
    expect(creditNoteMatchesSearch(parse("NC12"), "NC13")).toBe(false);
    expect(creditNoteMatchesSearch(parse("12"), "NC12")).toBe(false);
  });
});
