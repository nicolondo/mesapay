import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  digitsAsNumber,
  expenseDocumentLabel,
  formatExpenseNumber,
  numberPendingExpenses,
  parseExpenseNumber,
  planExpenseNumbers,
} from "./expenseNumber";

const at = (iso: string) => new Date(iso);

describe("formatExpenseNumber", () => {
  it("G- y cuatro dígitos, sin cortar los números grandes", () => {
    expect(formatExpenseNumber(1)).toBe("G-0001");
    expect(formatExpenseNumber(73)).toBe("G-0073");
    expect(formatExpenseNumber(12345)).toBe("G-12345");
  });
  it("sin número (plantilla o gasto pendiente) no inventa uno", () => {
    expect(formatExpenseNumber(null)).toBeNull();
    expect(formatExpenseNumber(undefined)).toBeNull();
    expect(formatExpenseNumber(0)).toBeNull();
  });
});

describe("parseExpenseNumber / digitsAsNumber", () => {
  it("reconoce el consecutivo como se escribe en el buscador", () => {
    for (const text of ["G-0012", "g12", "G 12", "g-12", " #12 ", "G0012"]) {
      expect(parseExpenseNumber(text), text).toBe(12);
    }
  });
  it("no confunde un documento del proveedor ni texto con un consecutivo", () => {
    for (const text of ["FE-12", "12", "gas", "G-", "G-12a", "G-99999999999"]) {
      expect(parseExpenseNumber(text), text).toBeNull();
    }
  });
  it("sólo dígitos: puede ser consecutivo (además de NIT o factura)", () => {
    expect(digitsAsNumber("0012")).toBe(12);
    expect(digitsAsNumber("12a")).toBeNull();
    expect(digitsAsNumber("0")).toBeNull();
  });
});

describe("planExpenseNumbers", () => {
  it("sigue el contador y reparte en orden de creación (empate por id)", () => {
    const plan = planExpenseNumbers({
      nextNumber: 8,
      maxAssigned: 7,
      pending: [
        { id: "c", createdAt: at("2026-11-13T15:00:02Z") },
        { id: "b", createdAt: at("2026-11-13T15:00:01Z") },
        { id: "a", createdAt: at("2026-11-13T15:00:01Z") },
      ],
    });
    expect(plan.assignments).toEqual([
      { id: "a", number: 8 },
      { id: "b", number: 9 },
      { id: "c", number: 10 },
    ]);
    expect(plan.nextNumber).toBe(11);
  });
  it("nunca reutiliza: si se borró el último (G-0007), el siguiente sigue siendo G-0008", () => {
    // El mayor asignado que queda es 6, pero el contador ya pasó por el 7.
    const plan = planExpenseNumbers({ nextNumber: 8, maxAssigned: 6, pending: [{ id: "x", createdAt: at("2026-11-13T00:00:00Z") }] });
    expect(plan.assignments).toEqual([{ id: "x", number: 8 }]);
  });
  it("un contador atrasado (copia restaurada por una versión anterior) no choca con los números que ya existen", () => {
    const plan = planExpenseNumbers({ nextNumber: 3, maxAssigned: 40, pending: [{ id: "x", createdAt: at("2026-11-13T00:00:00Z") }] });
    expect(plan.assignments).toEqual([{ id: "x", number: 41 }]);
    expect(plan.nextNumber).toBe(42);
  });
  it("el primer gasto del comercio es G-0001; sin pendientes no cambia nada", () => {
    expect(planExpenseNumbers({ nextNumber: 1, maxAssigned: null, pending: [{ id: "x", createdAt: at("2026-01-01T00:00:00Z") }] }).assignments).toEqual([
      { id: "x", number: 1 },
    ]);
    expect(planExpenseNumbers({ nextNumber: 5, maxAssigned: 4, pending: [] })).toEqual({ assignments: [], nextNumber: 5 });
  });
});

describe("numberPendingExpenses (transacción)", () => {
  function fakeTx(opts: { next: number; max: number | null; pending: Array<{ id: string; createdAt: Date }> }) {
    const log: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        log.push(strings.join("?").replace(/\s+/g, " ").trim());
        return [{ expenseNextNumber: opts.next }];
      }),
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        log.push(`${strings.join("?").replace(/\s+/g, " ").trim()} [${values.join(",")}]`);
        return 1;
      }),
      expense: {
        findMany: vi.fn(async () => {
          log.push("findMany");
          return opts.pending;
        }),
        aggregate: vi.fn(async () => ({ _max: { number: opts.max } })),
        updateMany: vi.fn(async (args: { where: { id: string }; data: { number: number } }) => {
          log.push(`update ${args.where.id}=${args.data.number}`);
          return { count: 1 };
        }),
      },
    };
    return { tx, log };
  }

  it("bloquea la fila del comercio ANTES de leer los pendientes, numera y adelanta el contador", async () => {
    const { tx, log } = fakeTx({
      next: 74,
      max: 73,
      pending: [
        { id: "nuevo", createdAt: at("2026-11-13T15:00:05Z") },
        { id: "de-la-version-vieja", createdAt: at("2026-11-13T15:00:01Z") },
      ],
    });
    const assigned = await numberPendingExpenses(tx as never, "r1");
    expect(log[0]).toMatch(/SELECT "expenseNextNumber" FROM "Restaurant" WHERE "id" = \? FOR NO KEY UPDATE/);
    expect(log.slice(1, 4)).toEqual(["findMany", "update de-la-version-vieja=74", "update nuevo=75"]);
    expect(log[4]).toMatch(/UPDATE "Restaurant" SET "expenseNextNumber" = \? WHERE "id" = \? \[76,r1\]/);
    expect([...assigned]).toEqual([
      ["de-la-version-vieja", 74],
      ["nuevo", 75],
    ]);
    // Sólo números a los que todavía no tienen (nunca pisa uno asignado).
    expect(tx.expense.updateMany.mock.calls[0]![0].where).toEqual({ id: "de-la-version-vieja", number: null });
  });

  it("sin pendientes no escribe nada", async () => {
    const { tx } = fakeTx({ next: 5, max: 4, pending: [] });
    expect((await numberPendingExpenses(tx as never, "r1")).size).toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.expense.updateMany).not.toHaveBeenCalled();
  });
});

describe("expenseDocumentLabel", () => {
  it("consecutivo y documento del proveedor; sin número, el documento o el respaldo", () => {
    expect(expenseDocumentLabel({ number: 12, documentNumber: "FE-1280" }, "Arriendo")).toBe("G-0012 · FE-1280");
    expect(expenseDocumentLabel({ number: 12, documentNumber: " " }, "Arriendo")).toBe("G-0012");
    expect(expenseDocumentLabel({ number: null, documentNumber: "FE-1" }, "Arriendo")).toBe("FE-1");
    expect(expenseDocumentLabel({ number: null, documentNumber: null }, "Arriendo")).toBe("Arriendo");
  });
});
