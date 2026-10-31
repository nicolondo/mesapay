// Lista de facturas electrónicas: filtros de la URL, `where` de Prisma
// (estado, días operativos, búsqueda), paginación y estado DIAN visible.
import { describe, expect, it } from "vitest";
import {
  INVOICE_PAGE_SIZE,
  businessRange,
  dianStateWhere,
  invoiceDianStatus,
  invoiceDisplayNumber,
  invoiceListHref,
  invoiceListWhere,
  invoicePageCount,
  invoicePageWindow,
  invoiceSearchWhere,
  invoiceStateBucket,
  last30BusinessDays,
  parseInvoiceListParams,
} from "./invoiceList";
import { MAX_ATTEMPTS } from "./retry";

describe("filtros en la URL", () => {
  it("sin parámetros: todas, sin fechas, página 1", () => {
    expect(parseInvoiceListParams({})).toEqual({ state: "all", from: null, to: null, q: "", page: 1 });
  });

  it("lee estado, rango, búsqueda y página", () => {
    expect(
      parseInvoiceListParams({ state: "rejected", from: "2026-10-01", to: "2026-10-31", q: "  FESM7845 ", page: "3" }),
    ).toEqual({ state: "rejected", from: "2026-10-01", to: "2026-10-31", q: "FESM7845", page: 3 });
  });

  it("lo que no entiende cae al valor por defecto (nunca rompe la pantalla)", () => {
    expect(
      parseInvoiceListParams({ state: "borradas", from: "2026-02-31", to: "ayer", page: "-2" }),
    ).toEqual({ state: "all", from: null, to: null, q: "", page: 1 });
    expect(parseInvoiceListParams({ page: "1.5" }).page).toBe(1);
    expect(parseInvoiceListParams({ q: "x".repeat(300) }).q).toHaveLength(100);
    expect(parseInvoiceListParams({ state: ["accepted", "rejected"] }).state).toBe("accepted");
  });

  it("un rango al revés se da vuelta", () => {
    const p = parseInvoiceListParams({ from: "2026-10-31", to: "2026-10-01" });
    expect([p.from, p.to]).toEqual(["2026-10-01", "2026-10-31"]);
  });

  it("el enlace omite los valores por defecto y conserva el resto", () => {
    expect(invoiceListHref({})).toBe("/operator/facturas");
    expect(invoiceListHref({ state: "all", page: 1, q: "" })).toBe("/operator/facturas");
    expect(invoiceListHref({ state: "rejected", from: "2026-10-02", to: "2026-10-31" })).toBe(
      "/operator/facturas?state=rejected&from=2026-10-02&to=2026-10-31",
    );
    const round = parseInvoiceListParams(
      Object.fromEntries(new URL(invoiceListHref({ state: "in_process", q: "Ana Pérez", page: 2 }), "https://x.test").searchParams),
    );
    expect(round).toEqual({ state: "in_process", from: null, to: null, q: "Ana Pérez", page: 2 });
  });
});

describe("estado DIAN visible y su filtro", () => {
  it("cada estado del documento cae en un único filtro", () => {
    const cases: [string, number, string, string][] = [
      ["accepted", 1, "accepted", "accepted"],
      ["rejected", 1, "rejected", "rejected"],
      ["error", 1, "error_retrying", "in_process"],
      ["error", MAX_ATTEMPTS, "error_stuck", "rejected"],
      ["sent", 0, "in_process", "in_process"],
      ["pending", 1, "in_process", "in_process"],
      ["to_send", 0, "not_sent", "in_process"],
    ];
    for (const [state, attempts, status, bucket] of cases) {
      const s = invoiceDianStatus({ state, attempts });
      expect(s).toBe(status);
      expect(invoiceStateBucket(s)).toBe(bucket);
    }
  });

  it("el where de cada filtro coincide con ese reparto", () => {
    expect(dianStateWhere("all")).toBeNull();
    expect(dianStateWhere("accepted")).toEqual({ state: "accepted" });
    expect(dianStateWhere("rejected")).toEqual({
      OR: [{ state: "rejected" }, { state: "error", attempts: { gte: MAX_ATTEMPTS } }],
    });
    expect(dianStateWhere("in_process")).toEqual({
      OR: [
        { state: { in: ["to_send", "sent", "pending"] } },
        { state: "error", attempts: { lt: MAX_ATTEMPTS } },
      ],
    });
  });
});

describe("where de la lista", () => {
  const params = { state: "all" as const, from: null, to: null, q: "" };

  it("sólo facturas del comercio con documento DIAN de tipo factura", () => {
    expect(invoiceListWhere("rest-1", params, 5)).toEqual({
      restaurantId: "rest-1",
      dianDocument: { is: { kind: "invoice" } },
    });
  });

  it("el filtro de estado va dentro del documento DIAN", () => {
    expect(invoiceListWhere("rest-1", { ...params, state: "accepted" }, 0).dianDocument).toEqual({
      is: { kind: "invoice", state: "accepted" },
    });
  });

  it("el rango es de días operativos: con corte a las 5, el día 30 va de 05:00 del 30 a 05:00 del 31", () => {
    const where = invoiceListWhere("rest-1", { ...params, from: "2026-10-30", to: "2026-10-30" }, 5);
    expect(where.createdAt).toEqual({
      gte: new Date("2026-10-30T10:00:00.000Z"),
      lt: new Date("2026-10-31T10:00:00.000Z"),
    });
    // Con corte a medianoche: el día calendario de Bogotá.
    expect(businessRange("2026-10-30", null, 0)).toEqual({ gte: new Date("2026-10-30T05:00:00.000Z") });
    expect(businessRange(null, "2026-10-30", 0)).toEqual({ lt: new Date("2026-10-31T05:00:00.000Z") });
    expect(businessRange(null, null, 5)).toBeNull();
  });

  it("los últimos 30 días operativos incluyen hoy (con la madrugada en el día anterior)", () => {
    // 31-oct 03:00 Bogotá, corte 5 ⇒ el día operativo es el 30.
    expect(last30BusinessDays(5, new Date("2026-10-31T08:00:00.000Z"))).toEqual({
      from: "2026-10-01",
      to: "2026-10-30",
    });
    expect(last30BusinessDays(0, new Date("2026-10-31T08:00:00.000Z"))).toEqual({
      from: "2026-10-02",
      to: "2026-10-31",
    });
  });
});

describe("búsqueda", () => {
  const ors = (q: string) => invoiceSearchWhere(q);

  it("por número, con o sin prefijo", () => {
    expect(ors("FESM7845")).toContainEqual({ invoiceNumber: 7845 });
    expect(ors("7845")).toContainEqual({ invoiceNumber: 7845 });
    expect(ors("fesm-7845")).toContainEqual({ invoiceNumber: 7845 });
    expect(ors("Ana")).not.toContainEqual(expect.objectContaining({ invoiceNumber: expect.anything() }));
  });

  it("por código de pedido, correo, nombre y NIT del cliente", () => {
    const where = ors("002A77");
    expect(where).toContainEqual({ order: { shortCode: { contains: "002A77", mode: "insensitive" } } });
    expect(where).toContainEqual({ email: { contains: "002A77", mode: "insensitive" } });
    expect(where).toContainEqual({ order: { simpleInvoiceEmail: { contains: "002A77", mode: "insensitive" } } });
    const request = where.find((w) => "order" in w && w.order && "invoiceRequests" in w.order) as {
      order: { invoiceRequests: { some: { OR: unknown[] } } };
    };
    expect(request.order.invoiceRequests.some.OR).toEqual([
      { customerName: { contains: "002A77", mode: "insensitive" } },
      { email: { contains: "002A77", mode: "insensitive" } },
      { docNumber: { contains: "002A77", mode: "insensitive" } },
    ]);
  });

  it("un NIT escrito con puntos y DV busca el número como lo guarda la solicitud", () => {
    const where = ors("900.123.456-7");
    const request = where.find((w) => "order" in w && w.order && "invoiceRequests" in w.order) as {
      order: { invoiceRequests: { some: { OR: { docNumber?: unknown }[] } } };
    };
    expect(request.order.invoiceRequests.some.OR).toContainEqual({
      docNumber: { contains: "900123456", mode: "insensitive" },
    });
  });

  it("vacía no filtra; con texto el OR va al where de la lista", () => {
    expect(ors("   ")).toEqual([]);
    const where = invoiceListWhere("rest-1", { state: "all", from: null, to: null, q: "ana@correo.com" }, 0);
    expect(where.OR).toEqual(ors("ana@correo.com"));
  });
});

describe("paginación", () => {
  it("50 por página, la más nueva primero (skip/take)", () => {
    expect(INVOICE_PAGE_SIZE).toBe(50);
    expect(invoicePageWindow(1)).toEqual({ skip: 0, take: 50 });
    expect(invoicePageWindow(3)).toEqual({ skip: 100, take: 50 });
    expect(invoicePageWindow(0)).toEqual({ skip: 0, take: 50 });
  });

  it("cantidad de páginas", () => {
    expect(invoicePageCount(0)).toBe(1);
    expect(invoicePageCount(50)).toBe(1);
    expect(invoicePageCount(51)).toBe(2);
    expect(invoicePageCount(961)).toBe(20);
  });

  it("número con el prefijo congelado en la tirilla", () => {
    expect(invoiceDisplayNumber("FESM", 7845)).toBe("FESM7845");
    expect(invoiceDisplayNumber(null, 12)).toBe("12");
  });
});
