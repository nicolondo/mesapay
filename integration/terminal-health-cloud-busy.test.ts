import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { GET as readPayment } from "../src/app/api/tenant/[slug]/payment/[paymentId]/route";
import { staffForRestaurant } from "../src/lib/staffAccess";
import { db } from "../src/lib/db";
import { readTerminalWarnings } from "../src/lib/payments/terminalHealth";

vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/staffAccess", () => ({ COLLECTOR_ROLES: ["mesero"], staffForRestaurant: vi.fn() }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*_test$/.test(database.pathname)) {
  throw new Error("Terminal health integration tests require an isolated local test database");
}

afterAll(() => db.$disconnect());

it("lee los 400 ya almacenados y distingue respuestas reales de rechazos de la nube", async () => {
  const tenant = await db.restaurant.create({ data: { slug: randomUUID(), name: "Terminal health test" } });
  const restaurantId = tenant.id;
  const ids: string[] = [];
  const since = Date.now() - 500_000;
  const at = (sec: number) => new Date(since + sec * 1000);
  try {
    const table = await db.table.create({ data: { restaurantId, number: 1, qrToken: randomUUID() } });
    // The additional order day covers a recent charge on an older open table.
    const order = await db.order.create({ data: { createdAt: new Date(Date.now() - 60 * 3600_000), restaurantId, tableId: table.id, shortCode: randomUUID(), totalCents: 1000, subtotalCents: 1000 } });
    const device = await db.terminalDevice.create({ data: { restaurantId, kushkiDeviceId: randomUUID(), serialNumber: randomUUID(), label: "Test" } });
    const warnings = () => readTerminalWarnings(restaurantId);
    async function claim(sec: number, timedOut = false) {
      const pay = await db.payment.create({ data: { orderId: order.id, method: "kushki_card_terminal", status: "declined", amountCents: 1000 } });
      ids.push(pay.id);
      await db.financialOperation.create({ data: { key: `terminal:${pay.id}`, paymentId: pay.id,
        deviceId: device.kushkiDeviceId, kind: "terminal", amountCents: 1000, status: "failed",
        createdAt: at(sec), gatewayTimedOutAt: timedOut ? at(sec + 60) : null } });
      return pay.id;
    }
    async function event(paymentId: string, sec: number, suffix: string, approved = false, type: string | null = "INTERNAL") {
      const failure = { ...(type && { type }), code: "TERMINAL_BUSY" };
      await db.kushkiWebhookEvent.create({ data: {
        restaurantId, eventId: `cloudterm:${paymentId}:${suffix}:${sec}`, type: approved ? "terminal.approved" : "terminal.declined",
        createdAt: at(sec), processedAt: at(sec), payload: { paymentId, raw: approved ? {} : suffix === "no" ? { failure } : failure },
      } });
    }
    await event(await claim(0), 1, "rejected");
    const timeoutId = await claim(10, true);
    expect(await warnings()).toEqual([]);
    // Several traces for the same push cannot manufacture a second charge.
    await event(timeoutId, 71, "no");
    expect(await warnings()).toEqual([]);
    const firstBusy = await claim(91);
    await event(firstBusy, 91, "rejected", false, null);
    expect(await warnings()).toMatchObject([{ count: 2, since: at(70).toISOString() }]);
    // The staff poll may win the race against POST /charge. A guest (even
    // copying the header) and an unrelated payment keep their original response.
    const poll = async (paymentId: string, staffHeader = true) => (await readPayment(
      new Request("http://localhost", { headers: staffHeader ? { "x-mesapay-staff-checkout": "1" } : {} }),
      { params: Promise.resolve({ slug: tenant.slug, paymentId }) },
    )).json();
    vi.mocked(staffForRestaurant).mockResolvedValue(null);
    expect(await poll(firstBusy)).not.toHaveProperty("staffTerminalError");
    vi.mocked(staffForRestaurant).mockResolvedValue({ user: { id: "staff", role: "mesero" }, expires: "" } as Awaited<ReturnType<typeof staffForRestaurant>>);
    expect(await poll(firstBusy, false)).not.toHaveProperty("staffTerminalError");
    expect(await poll(firstBusy)).toMatchObject({ status: "declined", staffTerminalError: "terminal_unresponsive" });
    expect(await poll(timeoutId)).not.toHaveProperty("staffTerminalError");
    const second = await claim(96);
    await event(second, 96, "no", false, "OTHER");
    expect(await warnings()).toMatchObject([{ count: 3 }]);
    // A claim and webhook describing the same failed charge count just once.
    await db.financialOperation.update({ where: { key: `terminal:${second}` }, data: { answeredAt: at(96), answerCode: "INTERNAL/TERMINAL_BUSY" } });
    expect(await warnings()).toMatchObject([{ count: 3 }]);
    await event(await claim(100), 101, "ok", true);
    expect(await warnings()).toEqual([]);
    expect(await poll(firstBusy)).not.toHaveProperty("staffTerminalError");
    await event(await claim(110), 111, "rejected");
    expect(await warnings()).toEqual([]);
    // An inconclusive sync answer can live only on the claim. A real device
    // answer, an approved amount mismatch or a completed print still clear it.
    for (const [index, recovery] of ["device", "mismatch", "print"].entries()) {
      const start = 120 + 90 * index;
      await claim(start, true);
      const busyId = await claim(start + 61);
      const noteAnswer = (id: string, answerCode: string, sec: number) => db.financialOperation.update({
        where: { key: `terminal:${id}` }, data: { answerCode, answeredAt: at(sec) },
      });
      if (recovery === "device") {
        await db.financialOperation.update({ where: { key: `terminal:${busyId}` }, data: { answerCode: "TERMINAL_BUSY" } });
      } else {
        await noteAnswer(busyId, "OTHER/TERMINAL_BUSY", start + 62);
      }
      expect(await warnings()).toMatchObject([{ count: 2 }]);
      if (recovery === "device") {
        await db.payment.update({ where: { id: busyId }, data: { status: "pending", reconciliationRequired: true } });
        expect(await poll(busyId)).toMatchObject({ status: "pending", terminalAttempt: { unresponsive: true } });
        await noteAnswer(await claim(start + 64), "TERMINAL/TER-004", start + 65);
      } else {
        const mismatch = recovery === "mismatch";
        await db.auditEvent.create({ data: {
          restaurantId, actorRole: "system", actorEmail: "system", summary: "synthetic recovery", occurredAt: at(start + 65),
          kind: mismatch ? "payment.terminal_amount_mismatch" : "terminal.print.completed",
          targetType: mismatch ? "payment" : "terminal", targetId: mismatch ? await claim(start + 64) : device.serialNumber,
        } });
      }
      expect(await warnings()).toEqual([]);
    }
    await claim(400, true);
    await event(await claim(470), 471, "rejected");
    expect(await warnings()).toMatchObject([{ count: 2 }]);
    await db.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 80 * 3600_000) } });
    expect(await warnings()).toEqual([]);
  } finally {
    await db.kushkiWebhookEvent.deleteMany({ where: { restaurantId } });
    await db.financialOperation.deleteMany({ where: { paymentId: { in: ids } } });
    await db.restaurant.delete({ where: { id: restaurantId } });
  }
});
