import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { payment: { findMany: m.findMany } } }));

import { loadInvoicePaymentDetails } from "./invoicePayments";

/**
 * El loader de la sección «Pagos». Lo que se blinda acá: el FALLBACK al
 * `raw` para las transacciones del DATÁFONO ya guardadas con las columnas
 * tipadas en NULL (el detalle vive en `authCode`/`cardData`…), para que
 * las facturas existentes también impriman franquicia/últimos 4/aprobación
 * al reimprimir (FESM8648), y la referencia de Kushki para el extracto.
 */
describe("loadInvoicePaymentDetails — fallback al raw del datáfono", () => {
  const base = {
    method: "kushki_card_terminal",
    amountCents: 7_407_800,
    tipCents: 0,
    cashTenderCents: null,
    billingCustomer: null,
    breBCharge: null,
  };

  beforeEach(() => m.findMany.mockReset());

  it("columnas tipadas en NULL + raw del terminal: el detalle sale del raw", async () => {
    m.findMany.mockResolvedValue([
      {
        ...base,
        kushkiTransactions: [
          {
            cardBrand: null,
            cardLast4: null,
            approvalCode: null,
            kushkiTxId: "cli-txn-1",
            raw: {
              approved: true,
              authCode: "123456",
              responseCode: "00",
              transactionReference: "4152912345678901",
              // La forma real del Sunmi: sin brand; aid EMV + pan enmascarado.
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
            },
          },
        ],
      },
    ]);
    const [p] = await loadInvoicePaymentDetails("order-1");
    expect(p).toMatchObject({
      cardBrand: "VISA",
      cardLast4: "4242",
      approvalCode: "123456",
      // La referencia del raw gana sobre el kushkiTxId (que para el
      // terminal puede ser nuestro client_transaction_id).
      kushkiReference: "4152912345678901",
    });
  });

  it("columnas tipadas presentes: mandan ellas; la referencia cae al kushkiTxId si el raw no trae", async () => {
    m.findMany.mockResolvedValue([
      {
        ...base,
        method: "kushki_card",
        kushkiTransactions: [
          {
            cardBrand: "MASTERCARD",
            cardLast4: "7788",
            approvalCode: "445566",
            kushkiTxId: "ktx-99",
            raw: {},
          },
        ],
      },
    ]);
    const [p] = await loadInvoicePaymentDetails("order-1");
    expect(p).toMatchObject({
      cardBrand: "MASTERCARD",
      cardLast4: "7788",
      approvalCode: "445566",
      kushkiReference: "ktx-99",
    });
  });

  it("tipadas a medias: el raw completa SOLO lo que falta", async () => {
    m.findMany.mockResolvedValue([
      {
        ...base,
        kushkiTransactions: [
          {
            cardBrand: "VISA",
            cardLast4: null,
            approvalCode: null,
            kushkiTxId: "cli-txn-2",
            raw: { authCode: "777777", cardData: "445654******0063" },
          },
        ],
      },
    ]);
    const [p] = await loadInvoicePaymentDetails("order-1");
    expect(p).toMatchObject({ cardBrand: "VISA", cardLast4: "0063", approvalCode: "777777" });
  });

  it("sin transacción Kushki (efectivo): sin referencia ni tarjeta", async () => {
    m.findMany.mockResolvedValue([
      { ...base, method: "cash", cashTenderCents: 8_000_000, kushkiTransactions: [] },
    ]);
    const [p] = await loadInvoicePaymentDetails("order-1");
    expect(p).toMatchObject({
      cardBrand: null,
      approvalCode: null,
      kushkiReference: null,
      cashTenderCents: 8_000_000,
    });
  });
});
