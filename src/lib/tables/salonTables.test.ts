import { describe, expect, it } from "vitest";
import { floorTablesOf, pendingManualInvoiceCount, terminalTablesWhere } from "./salonTables";

/**
 * Una factura manual nunca es una mesa del salón: Mesas sólo dibuja las
 * físicas y «Mesas en vivo» del datáfono deja afuera las manuales (y la de
 * recogida), en cualquier estado de la factura.
 */
const tables = [
  { id: "m1", kind: "standard", orders: [{ id: "o1" }] },
  { id: "m2", kind: "standard", orders: [] },
  { id: "pickup", kind: "pickup", orders: [] },
  { id: "fm-borrador", kind: "manual", orders: [{ id: "o2" }] },
  { id: "fm-enviada", kind: "manual", orders: [{ id: "o3" }] },
  // Manual ya cobrada o emitida por cobrar: su mesa oculta quedó libre.
  { id: "fm-libre", kind: "manual", orders: [] },
];

describe("floorTablesOf", () => {
  it("Mesas dibuja sólo las mesas físicas, nunca una factura manual", () => {
    expect(floorTablesOf(tables, false).map((t) => t.id)).toEqual(["m1", "m2"]);
  });
  it("en mostrador, la primera mesa física", () => {
    expect(floorTablesOf(tables, true).map((t) => t.id)).toEqual(["m1"]);
  });
});

describe("pendingManualInvoiceCount", () => {
  it("cuenta las manuales con cuenta viva (para el acceso), 0 para el mesero", () => {
    expect(pendingManualInvoiceCount(tables, false)).toBe(2);
    expect(pendingManualInvoiceCount(tables, true)).toBe(0);
  });
});

describe("terminalTablesWhere", () => {
  it("«Mesas en vivo» deja afuera las manuales y la de recogida", () => {
    expect(terminalTablesWhere("r1")).toEqual({ restaurantId: "r1", number: { gte: 0 }, kind: { not: "manual" } });
  });
});
