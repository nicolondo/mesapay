// Reglas de las solicitudes de factura frente a la factura electrónica
// aceptada: qué se cierra solo al aceptarse, qué "llegó después" y la
// condición de la limpieza histórica (la misma que aplica el SQL de la
// migración, que este archivo también vigila).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  CONSUMIDOR_FINAL_ID,
  acceptedInvoiceClosureCutoff,
  closesOnAcceptance,
  coveredRequestsWhere,
  historicalAcceptanceLowerBound,
  historicalCleanupCloses,
  invoiceXmlBuyerId,
  isLateInvoiceRequest,
} from "./invoiceRequestCoverage";
import { CONSUMIDOR_FINAL } from "./emit";

const at = (iso: string) => new Date(iso);

/** Lo mínimo del XML que genera ubl.ts: emisor y adquiriente. */
function invoiceXml(buyerId: string, issue = { date: "2026-10-30", time: "13:05:10-05:00" }) {
  const party = (tag: string, id: string) =>
    `<cac:${tag}><cbc:AdditionalAccountID>2</cbc:AdditionalAccountID><cac:Party>` +
    `<cac:PartyName><cbc:Name>X</cbc:Name></cac:PartyName><cac:PartyTaxScheme>` +
    `<cbc:RegistrationName>X</cbc:RegistrationName>` +
    `<cbc:CompanyID schemeName="13" schemeAgencyID="195">${id}</cbc:CompanyID>` +
    `</cac:PartyTaxScheme></cac:Party></cac:${tag}>`;
  return (
    `<Invoice><cbc:IssueDate>${issue.date}</cbc:IssueDate><cbc:IssueTime>${issue.time}</cbc:IssueTime>` +
    party("AccountingSupplierParty", "901944469") +
    party("AccountingCustomerParty", buyerId) +
    `</Invoice>`
  );
}

describe("adquiriente del XML aceptado", () => {
  it("el NIT de consumidor final es el mismo que usa la emisión", () => {
    expect(CONSUMIDOR_FINAL_ID).toBe(CONSUMIDOR_FINAL.companyId);
  });

  it("lee el CompanyID del adquiriente, no el del emisor", () => {
    expect(invoiceXmlBuyerId(invoiceXml(CONSUMIDOR_FINAL_ID))).toBe(CONSUMIDOR_FINAL_ID);
    expect(invoiceXmlBuyerId(invoiceXml("1020304050"))).toBe("1020304050");
  });

  it("sin bloque de adquiriente no afirma nada", () => {
    expect(invoiceXmlBuyerId("<Invoice/>")).toBeNull();
    expect(invoiceXmlBuyerId("no es xml")).toBeNull();
  });
});

describe("caso 'llegó después': cuándo aparece y cuándo no", () => {
  const issuedAt = at("2026-10-30T18:05:10.000Z");

  it("aparece: factura a consumidor final y la solicitud llegó después de emitirla", () => {
    expect(
      isLateInvoiceRequest({
        requestCreatedAt: at("2026-10-30T18:20:00.000Z"),
        issuedAt,
        buyerId: CONSUMIDOR_FINAL_ID,
      }),
    ).toBe(true);
  });

  it("no aparece si la factura salió con los datos de un cliente", () => {
    expect(
      isLateInvoiceRequest({
        requestCreatedAt: at("2026-10-30T18:20:00.000Z"),
        issuedAt,
        buyerId: "1020304050",
      }),
    ).toBe(false);
  });

  it("no aparece si la solicitud es anterior o igual a la emisión", () => {
    for (const createdAt of ["2026-10-30T17:00:00.000Z", "2026-10-30T18:05:10.000Z"]) {
      expect(
        isLateInvoiceRequest({ requestCreatedAt: at(createdAt), issuedAt, buyerId: CONSUMIDOR_FINAL_ID }),
      ).toBe(false);
    }
  });

  it("sin XML legible (sin fecha o sin adquiriente) no se marca nada", () => {
    const requestCreatedAt = at("2026-10-31T00:00:00.000Z");
    expect(isLateInvoiceRequest({ requestCreatedAt, issuedAt: null, buyerId: CONSUMIDOR_FINAL_ID })).toBe(false);
    expect(isLateInvoiceRequest({ requestCreatedAt, issuedAt, buyerId: null })).toBe(false);
  });
});

describe("cierre automático al aceptarse", () => {
  it("riel síncrono: corta en la solicitud que usó la emisión; sin solicitud no cierra nada", () => {
    const used = at("2026-10-30T17:59:00.000Z");
    expect(acceptedInvoiceClosureCutoff({ rail: "emit", usedRequestCreatedAt: used })).toEqual(used);
    expect(acceptedInvoiceClosureCutoff({ rail: "emit", usedRequestCreatedAt: null })).toBeNull();
    expect(acceptedInvoiceClosureCutoff({ rail: "emit", usedRequestCreatedAt: undefined })).toBeNull();
  });

  it("riel diferido: corta en el instante de emisión del XML", () => {
    const issued = at("2026-10-30T18:05:10.000Z");
    expect(acceptedInvoiceClosureCutoff({ rail: "status", issuedAt: issued })).toEqual(issued);
    expect(acceptedInvoiceClosureCutoff({ rail: "status", issuedAt: null })).toBeNull();
  });

  it("cierra las pendientes hasta el corte; deja las que llegaron tarde y no toca las rechazadas", () => {
    const cutoff = at("2026-10-30T18:00:00.000Z");
    const requests = [
      { id: "antes", status: "pending", createdAt: at("2026-10-30T17:30:00.000Z") },
      { id: "justo", status: "pending", createdAt: cutoff },
      { id: "tarde", status: "pending", createdAt: at("2026-10-30T18:30:00.000Z") },
      { id: "rechazada", status: "rejected", createdAt: at("2026-10-30T17:00:00.000Z") },
      { id: "ya-generada", status: "generated", createdAt: at("2026-10-30T17:00:00.000Z") },
    ];
    expect(requests.filter((r) => closesOnAcceptance(r, cutoff)).map((r) => r.id)).toEqual(["antes", "justo"]);
    expect(requests.filter((r) => closesOnAcceptance(r, null))).toEqual([]);
  });

  it("el filtro del updateMany es el mismo: sólo pendientes de la orden, hasta el corte", () => {
    const cutoff = at("2026-10-30T18:00:00.000Z");
    expect(coveredRequestsWhere("order-1", cutoff)).toEqual({
      orderId: "order-1",
      status: "pending",
      createdAt: { lte: cutoff },
    });
  });
});

describe("limpieza histórica (migración): condición exacta", () => {
  const base = {
    requestStatus: "pending",
    requestCreatedAt: at("2026-10-01T15:00:00.000Z"),
    enabledModules: ["inventory", "einvoicing"],
    document: { kind: "invoice", state: "accepted", createdAt: at("2026-10-01T16:00:00.000Z") },
    invoiceCreatedAt: at("2026-10-01T15:59:58.000Z"),
  };

  it("cierra la pendiente anterior a la factura aceptada de un comercio con einvoicing", () => {
    expect(historicalCleanupCloses(base)).toBe(true);
  });

  it("la cota es la más tardía entre tirilla y documento DIAN, y es inclusiva", () => {
    expect(
      historicalAcceptanceLowerBound({
        documentCreatedAt: at("2026-10-01T16:00:00.000Z"),
        invoiceCreatedAt: at("2026-10-01T16:10:00.000Z"),
      }),
    ).toEqual(at("2026-10-01T16:10:00.000Z"));
    expect(historicalCleanupCloses({ ...base, requestCreatedAt: at("2026-10-01T16:00:00.000Z") })).toBe(true);
    // Placeholder de numeración agotada: el documento nació antes que la
    // tirilla; vale la tirilla.
    expect(
      historicalCleanupCloses({
        ...base,
        requestCreatedAt: at("2026-10-01T17:00:00.000Z"),
        document: { ...base.document, createdAt: at("2026-10-01T12:00:00.000Z") },
        invoiceCreatedAt: at("2026-10-01T18:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("deja pendiente la que llegó después de la cota (posible 'llegó después')", () => {
    expect(historicalCleanupCloses({ ...base, requestCreatedAt: at("2026-10-01T16:00:01.000Z") })).toBe(false);
  });

  it("no toca nada sin einvoicing, sin factura aceptada o fuera de pending", () => {
    expect(historicalCleanupCloses({ ...base, enabledModules: ["inventory"] })).toBe(false);
    expect(historicalCleanupCloses({ ...base, enabledModules: null })).toBe(false);
    expect(historicalCleanupCloses({ ...base, enabledModules: { einvoicing: true } })).toBe(false);
    for (const state of ["to_send", "sent", "pending", "rejected", "error"]) {
      expect(historicalCleanupCloses({ ...base, document: { ...base.document, state } })).toBe(false);
    }
    expect(historicalCleanupCloses({ ...base, document: { ...base.document, kind: "credit_note" } })).toBe(false);
    expect(historicalCleanupCloses({ ...base, document: null, invoiceCreatedAt: null })).toBe(false);
    for (const requestStatus of ["generated", "rejected"]) {
      expect(historicalCleanupCloses({ ...base, requestStatus })).toBe(false);
    }
  });

  it("el SQL de la migración aplica esa misma condición y sólo cambia el estado", () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        "../../../prisma/migrations/20261031160000_invoice_requests_covered_by_einvoice/migration.sql",
      ),
      "utf8",
    );
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).toContain(`ir."status" = 'pending'::"InvoiceRequestStatus"`);
    expect(code).toContain(`jsonb_typeof(r."enabledModules") = 'array'`);
    expect(code).toContain(`r."enabledModules" @> '["einvoicing"]'::jsonb`);
    expect(code).toContain(`dd."kind" = 'invoice'`);
    expect(code).toContain(`dd."state" = 'accepted'`);
    expect(code).toContain(`ir."createdAt" <= GREATEST(dd."createdAt", si."createdAt")`);
    // Un único UPDATE, sobre InvoiceRequest, y ningún cambio de esquema.
    expect(code.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(code).toMatch(/UPDATE "InvoiceRequest"/);
    expect(code).not.toMatch(/\b(ALTER|CREATE|DROP|DELETE|INSERT|TRUNCATE)\b/);
  });
});
