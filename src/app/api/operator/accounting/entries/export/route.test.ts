// GET /accounting/entries/export: CSV "comprobantes detallados" con el
// dialecto Excel-ES (BOM, `;`, coma decimal) y celdas anti-fórmula.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", userId: "user-1" }),
  isDenied: () => false,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (ns: string) => {
    const t = (key: string) => `${ns}.${key}`;
    t.has = (key: string) => ns === "opErp" && key === "jSource_sale";
    return t;
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    journalEntry: { findMany: m.findMany },
    ledgerAccount: {
      findMany: async () => [
        { code: "110505", name: "Caja general" },
        { code: "413505", name: "Ingresos; restaurante" },
      ],
    },
  },
}));
import { GET } from "./route";

const get = (qs: string) =>
  GET(new Request(`http://localhost/api/operator/accounting/entries/export${qs}`));

beforeEach(() => {
  vi.resetAllMocks();
  m.findMany.mockResolvedValue([
    {
      id: "e1",
      date: new Date("2026-09-10T12:00:00Z"),
      voucherNumber: 7,
      source: "manual",
      memo: "=SUMA(A1)",
      thirdPartyName: "-Proveedor raro",
      thirdPartyTaxId: "900123456",
      lines: [
        { accountCode: "110505", debitCents: 123456, creditCents: 0, costCenter: { name: "Sede norte" } },
        { accountCode: "413505", debitCents: 0, creditCents: 123456, costCenter: null },
      ],
    },
    {
      id: "e2",
      date: new Date("2026-09-30T23:59:59.999Z"),
      voucherNumber: null,
      source: "sale",
      memo: "Ventas del mes",
      thirdPartyName: null,
      thirdPartyTaxId: null,
      lines: [{ accountCode: "110505", debitCents: 50, creditCents: 0, costCenter: null }],
    },
  ]);
});

describe("GET /accounting/entries/export", () => {
  it("exige un rango de fechas válido", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?desde=2026-09-30&hasta=2026-09-01")).status).toBe(400);
  });

  it("genera el CSV con BOM, `;`, coma decimal y prefijo anti-fórmula", async () => {
    const res = await get("?desde=2026-09-01&hasta=2026-09-30");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="comprobantes-2026-09-01-a-2026-09-30.csv"',
    );
    // `res.text()` se come el BOM al decodificar: se mira en los bytes.
    const buf = Buffer.from(await res.arrayBuffer());
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.subarray(3).toString("utf8").split("\r\n");
    expect(lines[0]).toBe(
      [
        "opComprobantes.csvDate",
        "opComprobantes.csvVoucher",
        "opComprobantes.csvSource",
        "opComprobantes.csvMemo",
        "opComprobantes.csvThirdParty",
        "opComprobantes.csvTaxId",
        "opComprobantes.csvAccount",
        "opComprobantes.csvAccountName",
        "opComprobantes.csvCostCenter",
        "opComprobantes.csvDebit",
        "opComprobantes.csvCredit",
      ].join(";"),
    );
    // Memo y tercero peligrosos van con `'`; el nombre de cuenta con `;` va entre comillas.
    expect(lines[1]).toBe(
      "2026-09-10;#000007;opComprobantes.jSource_manual;'=SUMA(A1);'-Proveedor raro;900123456;110505;Caja general;Sede norte;1234,56;0,00",
    );
    expect(lines[2]).toBe(
      "2026-09-10;#000007;opComprobantes.jSource_manual;'=SUMA(A1);'-Proveedor raro;900123456;413505;\"Ingresos; restaurante\";;0,00;1234,56",
    );
    // Sin número → columna vacía; origen automático → etiqueta de opErp.
    expect(lines[3]).toBe("2026-09-30;;opErp.jSource_sale;Ventas del mes;;;110505;Caja general;;0,50;0,00");
    expect(lines[4]).toBe("");
    // El rango llega al where con `hasta` inclusivo.
    expect(m.findMany.mock.calls[0][0].where.date).toEqual({
      gte: new Date("2026-09-01T00:00:00Z"),
      lt: new Date("2026-10-01T00:00:00Z"),
    });
  });
});
