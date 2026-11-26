import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { recordPrintFault } from "../src/lib/payments/terminalPrinterLock";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*_test$/.test(database.pathname)) {
  throw new Error("Terminal print integration tests require an isolated local test database");
}

afterAll(() => db.$disconnect());

it("actualiza la falla sin perder la primera hora ni el último estado conocido", async () => {
  const serial = randomUUID();
  const device = { serialNumber: serial, kushkiDeviceId: serial };
  const { jobId, createdAt } = await db.terminalPrintReservation.create({ data: { serial, jobId: randomUUID() } });
  const read = () => db.terminalPrintReservation.findUniqueOrThrow({ where: { serial } });
  const firstFaultAt = new Date(createdAt.getTime() + 1000);
  try {
    vi.setSystemTime(firstFaultAt);
    await recordPrintFault(device, jobId, createdAt, "unconfirmed", "IN_PROGRESS");
    expect(await read()).toMatchObject({ fault: "unconfirmed", faultAt: firstFaultAt, lastJobStatus: "IN_PROGRESS" });

    vi.setSystemTime(new Date(firstFaultAt.getTime() + 5000));
    await recordPrintFault(device, jobId, createdAt, "timeout");
    expect(await read()).toMatchObject({ fault: "timeout", faultAt: firstFaultAt, lastJobStatus: "IN_PROGRESS" });
  } finally {
    vi.useRealTimers();
    await db.terminalPrintReservation.delete({ where: { serial } });
  }
});
