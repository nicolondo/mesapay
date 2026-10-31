// Gastos recurrentes: la copia del mes hereda la cuenta del PUC y el centro
// de costos de la plantilla (antes caía en la cuenta que adivina la
// categoría y sin centro), y si el cron no corrió el día exacto, el gasto
// del mes se recupera en la próxima corrida del mismo mes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { expense: { findMany: m.findMany, create: m.create } } }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));

import { POST } from "./route";
import { materializeRecurring, recurringCopyDate } from "@/lib/erp/accounting";

const template = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  restaurantId: "r1",
  category: "Arriendo",
  description: "Local",
  amountCents: 3_000_000,
  supplierId: "s1",
  accountCode: "51201001",
  costCenterId: "cc-cocina",
  recurringDay: 5,
  createdAt: new Date("2026-09-01T12:00:00Z"),
  restaurant: { enabledModules: ["accounting"] },
  copies: [],
  ...over,
});

const call = () =>
  (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://x/api/cron/recurring-expenses", { method: "POST", headers: { "x-cron-secret": "s" } }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "s");
  m.create.mockResolvedValue({});
});

describe("cron de gastos recurrentes", () => {
  it("la copia hereda cuenta y centro de costos, con fecha del día de la plantilla", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T10:30:00Z"));
    m.findMany.mockResolvedValue([template()]);
    const res = await call();
    expect(await res.json()).toMatchObject({ created: 1 });
    expect(m.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: "r1",
        amountCents: 3_000_000,
        accountCode: "51201001",
        costCenterId: "cc-cocina",
        supplierId: "s1",
        templateId: "t1",
        date: new Date("2026-10-05T17:00:00Z"),
      }),
    });
    vi.useRealTimers();
  });

  it("si el cron no corrió el día 5, la corrida del 8 crea la copia fechada el 5", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:30:00Z"));
    m.findMany.mockResolvedValue([template(), template({ id: "t2", copies: [{ id: "c" }] })]);
    const res = await call();
    expect(await res.json()).toMatchObject({ created: 1 });
    expect(m.create.mock.calls[0]![0].data).toMatchObject({ templateId: "t1", date: new Date("2026-10-05T17:00:00Z") });
    vi.useRealTimers();
  });
});

describe("materializeRecurring", () => {
  const today = new Date("2026-10-08T10:30:00Z");
  it("toca las plantillas cuyo día ya llegó este mes y no tienen copia", () => {
    expect(
      materializeRecurring(
        [
          { id: "a", recurringDay: 8, createdAt: new Date("2026-01-01") },
          { id: "b", recurringDay: 3, createdAt: new Date("2026-01-01") },
          { id: "c", recurringDay: 9, createdAt: new Date("2026-01-01") },
          { id: "d", recurringDay: 2, createdAt: new Date("2026-01-01") },
        ],
        new Set(["d"]),
        today,
      ),
    ).toEqual(["a", "b"]);
  });

  it("una plantilla creada después de su día de este mes arranca el mes siguiente", () => {
    expect(
      materializeRecurring([{ id: "a", recurringDay: 3, createdAt: new Date("2026-10-06T15:00:00Z") }], new Set(), today),
    ).toEqual([]);
    // Creada el mismo día de su fecha: sí cuenta ese mes.
    expect(
      materializeRecurring([{ id: "a", recurringDay: 8, createdAt: new Date("2026-10-08T09:00:00Z") }], new Set(), today),
    ).toEqual(["a"]);
  });

  it("la copia se fecha a mediodía de Colombia de su día", () => {
    expect(recurringCopyDate(today, 3).toISOString()).toBe("2026-10-03T17:00:00.000Z");
  });
});
