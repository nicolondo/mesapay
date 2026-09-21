import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  disableStatement,
  disableUserTriggers,
  enableStatement,
  enableUserTriggers,
  listUserTriggers,
  quoteIdentifier,
  type UserTrigger,
} from "./triggers";
import type { Client } from "./snapshot";

/**
 * `$queryRaw`/`$executeRaw` llegan de dos formas: tagged template
 * (`strings, ...values`) o un `Prisma.Sql` ya armado. Se normaliza a Sql para
 * leer el texto y los parámetros.
 */
const sqlOf = (call: unknown[]): Prisma.Sql =>
  typeof (call[0] as { sql?: unknown })?.sql === "string"
    ? (call[0] as Prisma.Sql)
    : Prisma.sql(call[0] as TemplateStringsArray, ...(call.slice(1) as Prisma.Sql[]));

type RawFn = (...args: unknown[]) => Promise<unknown>;
function fakeTx(rows: UserTrigger[]) {
  const queryRaw = vi.fn<RawFn>(async () => rows);
  const executeRaw = vi.fn<RawFn>(async () => 0);
  return {
    tx: { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Client,
    queryRaw,
    executeRaw,
  };
}

describe("trigger statements", () => {
  it("quotes identifiers and refuses anything that is not a plain name", () => {
    expect(quoteIdentifier("Order")).toBe('"Order"');
    expect(quoteIdentifier("reserve_payment")).toBe('"reserve_payment"');
    for (const bad of ['Order"; DROP TABLE x; --', "a b", "", "1abc", "tabla-x"]) {
      expect(() => quoteIdentifier(bad)).toThrow("backup_invalid_identifier");
    }
  });
  it("builds DISABLE and the matching ENABLE for each previous state", () => {
    const base = { table: "Payment", trigger: "reserve_payment" };
    expect(disableStatement({ ...base, enabled: "O" })).toBe('ALTER TABLE "Payment" DISABLE TRIGGER "reserve_payment"');
    expect(enableStatement({ ...base, enabled: "O" })).toBe('ALTER TABLE "Payment" ENABLE TRIGGER "reserve_payment"');
    expect(enableStatement({ ...base, enabled: "A" })).toBe('ALTER TABLE "Payment" ENABLE ALWAYS TRIGGER "reserve_payment"');
    expect(enableStatement({ ...base, enabled: "R" })).toBe('ALTER TABLE "Payment" ENABLE REPLICA TRIGGER "reserve_payment"');
  });
});

describe("listUserTriggers", () => {
  it("asks pg_catalog only for user triggers of the given tables", async () => {
    const { tx, queryRaw } = fakeTx([]);
    await listUserTriggers(tx, ["Order", "Payment"]);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql.sql).toMatch(/NOT t\.tgisinternal/);
    expect(sql.sql).toMatch(/current_schema\(\)/);
    expect(sql.text).toMatch(/c\.relname IN \(\$1,\$2\)/);
    expect(sql.values).toEqual(["Order", "Payment"]);
  });
  it("does not hit the database for an empty table list", async () => {
    const { tx, queryRaw } = fakeTx([]);
    expect(await listUserTriggers(tx, [])).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("disable / enable", () => {
  const found: UserTrigger[] = [
    { table: "Order", trigger: "order_event", enabled: "O" },
    { table: "Payment", trigger: "reserve_payment", enabled: "O" },
    { table: "Payment", trigger: "already_off", enabled: "D" },
    { table: "Shift", trigger: "audit_always", enabled: "A" },
  ];
  it("disables only the active ones and returns them for re-enabling", async () => {
    const { tx, executeRaw } = fakeTx(found);
    const disabled = await disableUserTriggers(tx, ["Order", "Payment", "Shift"]);
    expect(disabled.map((t) => t.trigger)).toEqual(["order_event", "reserve_payment", "audit_always"]);
    expect(executeRaw.mock.calls.map((c) => sqlOf(c).sql)).toEqual([
      'ALTER TABLE "Order" DISABLE TRIGGER "order_event"',
      'ALTER TABLE "Payment" DISABLE TRIGGER "reserve_payment"',
      'ALTER TABLE "Shift" DISABLE TRIGGER "audit_always"',
    ]);
    // Los identificadores van embebidos (DDL no admite parámetros) y nunca
    // llevan valores: todo lo que se ejecuta viene de pg_catalog y está citado.
    for (const call of executeRaw.mock.calls) expect(sqlOf(call).values).toEqual([]);
  });
  it("re-enables each trigger in its previous mode", async () => {
    const { tx, executeRaw } = fakeTx([]);
    await enableUserTriggers(tx, found.filter((t) => t.enabled !== "D"));
    expect(executeRaw.mock.calls.map((c) => sqlOf(c).sql)).toEqual([
      'ALTER TABLE "Order" ENABLE TRIGGER "order_event"',
      'ALTER TABLE "Payment" ENABLE TRIGGER "reserve_payment"',
      'ALTER TABLE "Shift" ENABLE ALWAYS TRIGGER "audit_always"',
    ]);
  });
  it("refuses a trigger name that did not come from pg_catalog", async () => {
    const { tx, executeRaw } = fakeTx([{ table: "Order", trigger: 'x"; DROP TABLE "Order"; --', enabled: "O" }]);
    await expect(disableUserTriggers(tx, ["Order"])).rejects.toThrow("backup_invalid_identifier");
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
