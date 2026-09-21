// Libro de comprobantes: filtros de URL y cursor keyset (puros, sin DB).
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import {
  buildCursorWhere,
  buildEntriesWhere,
  decodeCursor,
  encodeCursor,
} from "./journalQuery";

describe("buildEntriesWhere", () => {
  it("fechas inclusivas y búsqueda por número exacto", () => {
    const w = buildEntriesWhere("r1", { desde: "2026-09-01", hasta: "2026-09-30", q: "#12" });
    expect(w).toEqual({
      restaurantId: "r1",
      date: { gte: new Date("2026-09-01T00:00:00Z"), lt: new Date("2026-10-01T00:00:00Z") },
      voucherNumber: 12,
    });
  });

  it("texto → memo contains insensible; fechas inválidas se ignoran", () => {
    const w = buildEntriesWhere("r1", { desde: "ayer", q: " ajuste " });
    expect(w).toEqual({
      restaurantId: "r1",
      memo: { contains: "ajuste", mode: "insensitive" },
    });
  });
});

describe("cursor", () => {
  const c = {
    date: "2026-09-10T12:00:00.000Z",
    voucherNumber: 5,
    createdAt: "2026-09-10T15:00:00.000Z",
    id: "e-1",
  };

  it("codifica y decodifica; rechaza basura", () => {
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ ...c, voucherNumber: null }))).toEqual({
      ...c,
      voucherNumber: null,
    });
    expect(decodeCursor("no-es-base64-json")).toBeNull();
    expect(decodeCursor(Buffer.from('{"date":"x"}').toString("base64url"))).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });

  it("después de un numerado vienen los menores y luego los sin numerar del mismo día", () => {
    const w = buildCursorWhere(c);
    expect(w).toEqual({
      OR: [
        { date: { lt: new Date(c.date) } },
        {
          date: new Date(c.date),
          OR: [
            { voucherNumber: { lt: 5 } },
            { voucherNumber: null },
            {
              voucherNumber: 5,
              OR: [
                { createdAt: { lt: new Date(c.createdAt) } },
                { createdAt: new Date(c.createdAt), id: { lt: "e-1" } },
              ],
            },
          ],
        },
      ],
    });
  });

  it("después de un sin numerar sólo siguen sin numerar del mismo día", () => {
    const w = buildCursorWhere({ ...c, voucherNumber: null });
    expect(w.OR?.[1]).toEqual({
      date: new Date(c.date),
      voucherNumber: null,
      OR: [
        { createdAt: { lt: new Date(c.createdAt) } },
        { createdAt: new Date(c.createdAt), id: { lt: "e-1" } },
      ],
    });
  });
});
