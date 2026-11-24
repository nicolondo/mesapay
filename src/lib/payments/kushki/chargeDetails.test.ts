import { describe, expect, it } from "vitest";
import { extractKushkiCardInfo, extractKushkiReference } from "./chargeDetails";

/**
 * La extracción de los datos de la tarjeta entiende las DOS formas del
 * raw: el cobro en línea (`fullResponse:"v2"`, bloque `details`) y el
 * cobro del DATÁFONO en la nube, que manda OTRAS claves (`authCode`,
 * `cardData`, `responseCode`, `transactionReference`, a veces dentro de
 * `rawResponse`). Las filas de los cobros del Sunmi quedaban con todo en
 * NULL y la factura salía sin franquicia/últimos 4/aprobación (FESM8648).
 * Ningún fixture lleva un PAN completo: enmascarado siempre.
 */
describe("extractKushkiCardInfo — forma del cobro en línea (v2)", () => {
  it("lee el bloque details", () => {
    expect(
      extractKushkiCardInfo({
        ticketNumber: "T-1",
        details: {
          paymentBrand: "MASTERCARD",
          lastFourDigits: "7788",
          cardType: "CREDIT",
          approvalCode: "445566",
          processorName: "Credibanco",
        },
      }),
    ).toMatchObject({
      cardBrand: "MASTERCARD",
      cardLast4: "7788",
      cardType: "CREDIT",
      approvalCode: "445566",
      processorName: "Credibanco",
    });
  });
});

describe("extractKushkiCardInfo — forma del DATÁFONO (Sunmi, cloud)", () => {
  // La forma REAL de `cardData` vista en prod (claves exactas; el `pan`
  // enmascarado es ficticio): NO trae brand/maskedPan/last4.
  const terminalRaw = {
    approved: true,
    authCode: "123456",
    responseCode: "00",
    transactionReference: "4152912345678901",
    hostRespond: "APROBADA",
    cardData: {
      tc: "F00A1B2C3D4E5F60",
      aid: "A0000000031010",
      bin: "445654",
      cvm: "NO_CVM",
      pan: "445654******4242",
      arqc: "ARQC00AA11BB22CC",
      bank: "BANCOLOMBIA",
      entryMode: "CHIP",
      cardHolderName: "CLIENTE/PRUEBA",
    },
    rawResponse: { transaction_status: "APPROVAL", authorized_amount: 74078 },
  };

  it("authCode → aprobación; pan → últimos 4 (nunca el PAN, ni enmascarado); aid → franquicia", () => {
    const info = extractKushkiCardInfo(terminalRaw);
    expect(info).toMatchObject({
      cardBrand: "VISA", // A000000003… = Visa (RID EMV)
      cardLast4: "4242",
      cardBin: "445654",
      cardHolderName: "CLIENTE/PRUEBA",
      approvalCode: "123456",
    });
    // Jamás el número enmascarado entero en ningún campo extraído.
    for (const v of Object.values(info)) expect(String(v)).not.toBe("445654******4242");
  });

  it("la franquicia por el RID del AID: Mastercard, Amex; AID desconocido → primer dígito del pan", () => {
    const withCard = (over: Record<string, unknown>) =>
      extractKushkiCardInfo({ ...terminalRaw, cardData: { ...terminalRaw.cardData, ...over } });
    expect(withCard({ aid: "A0000000041010", pan: "554455******7788" }).cardBrand).toBe("MASTERCARD");
    expect(withCard({ aid: "A000000025010801", pan: "377344******0005" }).cardBrand).toBe("AMEX");
    // AID que no está en el mapa: decide el primer dígito VISIBLE del pan…
    expect(withCard({ aid: "A000000999", pan: "554455******7788" }).cardBrand).toBe("MASTERCARD");
    // …y si tampoco es visible, null antes que adivinar.
    expect(withCard({ aid: "A000000999", pan: "******7788" }).cardBrand).toBeNull();
  });

  it("`bank` es el emisor: NUNCA se usa como franquicia", () => {
    const info = extractKushkiCardInfo({
      ...terminalRaw,
      cardData: { ...terminalRaw.cardData, aid: "A000000999", pan: "******7788" },
    });
    expect(info.cardBrand).toBeNull();
    expect(info.cardBrand).not.toBe("BANCOLOMBIA");
  });

  it("cardData como string enmascarado (forma defensiva): sólo se derivan los últimos 4", () => {
    const info = extractKushkiCardInfo({ ...terminalRaw, cardData: "445654******0063" });
    expect(info.cardLast4).toBe("0063");
    for (const v of Object.values(info)) expect(String(v)).not.toContain("******");
  });

  it("otras formas dentro de rawResponse también cuentan (defensivo)", () => {
    const info = extractKushkiCardInfo({
      rawResponse: { authCode: "998877", cardData: { brand: "AMEX", last4: "0005" } },
    });
    expect(info).toMatchObject({ cardBrand: "AMEX", cardLast4: "0005", approvalCode: "998877" });
  });

  it("el `type` top-level del terminal NO se confunde con el tipo de tarjeta", () => {
    const info = extractKushkiCardInfo({ type: "TERMINAL-SUNMI", code: "-1", message: "User cancel" });
    expect(info.cardType).toBeNull();
    expect(info.cardBrand).toBeNull();
  });

  it("un raw pobre o ajeno no inventa nada", () => {
    expect(extractKushkiCardInfo(null).cardBrand).toBeNull();
    expect(extractKushkiCardInfo({}).approvalCode).toBeNull();
    expect(extractKushkiCardInfo("texto").cardLast4).toBeNull();
  });
});

describe("extractKushkiReference — la referencia para cruzar con el extracto", () => {
  it("terminal: transactionReference (top o rawResponse); en línea: ticketNumber", () => {
    expect(extractKushkiReference({ transactionReference: "4152912345678901" })).toBe("4152912345678901");
    expect(extractKushkiReference({ rawResponse: { transaction_reference: "REF-RR" } })).toBe("REF-RR");
    expect(extractKushkiReference({ ticketNumber: "T-778899" })).toBe("T-778899");
    expect(extractKushkiReference({})).toBeNull();
    expect(extractKushkiReference(null)).toBeNull();
  });
});
