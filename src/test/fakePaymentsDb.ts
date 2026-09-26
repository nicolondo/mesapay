/**
 * Base en memoria (órdenes + pagos) para probar los caminos de cobro con la
 * regla que de verdad los muerde: el trigger `mesapay_reserve_payment`
 * (prisma/migrations/20260918000100_restore_bypass_triggers). Al insertar un
 * pago `pending`/`approved` suma lo que ya reservan los pendientes y
 * aprobados (comida = monto − propina) y rechaza con
 * `amount_exceeds_outstanding` si se pasa de lo cobrable + 1.
 *
 * `$transaction` revierte TODO si el callback lanza, como Postgres: así un
 * test ve que un 409 no deja solicitudes declinadas a medias.
 *
 * Sólo implementa lo que usan las rutas de cobro (where con igualdad, `in`,
 * `notIn`, `not` y `OR`; `orderBy.createdAt`). `select` se ignora: devuelve
 * la fila entera.
 */

export type FakeOrder = {
  id: string;
  restaurantId: string;
  status: string;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  tipCents: number;
  totalCents: number;
  paidAt: Date | null;
  tableId: string | null;
  dinerId: string | null;
  locale: string;
};

export type FakePayment = {
  id: string;
  orderId: string;
  method: string;
  status: string;
  amountCents: number;
  tipCents: number;
  cashTenderCents: number | null;
  requestKey: string | null;
  collectedByUserId: string | null;
  providerRef: string | null;
  settledAt: Date | null;
  createdAt: Date;
};

type Where = Record<string, unknown>;

function matchesValue(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
    if (c.in && !c.in.includes(value)) return false;
    if (c.notIn && c.notIn.includes(value)) return false;
    if ("not" in c && value === c.not) return false;
    return true;
  }
  return value === cond;
}

function matches(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (!matchesValue(row[key], cond)) return false;
  }
  return true;
}

export function createFakePaymentsDb(init: {
  order: Partial<FakeOrder> & { id: string };
  payments?: Partial<FakePayment>[];
  /** Delegados extra para el `tx` (p. ej. `orderItem`, `reservation`) que usa una ruta puntual. */
  extraTx?: Record<string, unknown>;
}) {
  const state = {
    orders: [
      {
        restaurantId: "rest-1",
        status: "paying",
        subtotalCents: 0,
        taxCents: 0,
        discountCents: 0,
        tipCents: 0,
        totalCents: 0,
        paidAt: null,
        tableId: null,
        dinerId: null,
        locale: "es",
        ...init.order,
      } as FakeOrder,
    ],
    payments: [] as FakePayment[],
  };
  let seq = 0;
  const newPayment = (data: Partial<FakePayment>): FakePayment => ({
    id: data.id ?? `pay-${++seq}`,
    orderId: data.orderId ?? init.order.id,
    method: data.method ?? "cash",
    status: data.status ?? "pending",
    amountCents: data.amountCents ?? 0,
    tipCents: data.tipCents ?? 0,
    cashTenderCents: data.cashTenderCents ?? null,
    requestKey: data.requestKey ?? null,
    collectedByUserId: data.collectedByUserId ?? null,
    providerRef: data.providerRef ?? null,
    settledAt: data.settledAt ?? null,
    // Orden estable para `orderBy: createdAt`.
    createdAt: data.createdAt ?? new Date(Date.UTC(2026, 8, 25, 19, 0, seq)),
  });
  for (const p of init.payments ?? []) state.payments.push(newPayment(p));

  /** El trigger `mesapay_reserve_payment`, tal cual. */
  function reservePayment(row: FakePayment) {
    const o = state.orders.find((x) => x.id === row.orderId);
    if (!o) throw new Error("order_not_found");
    if (row.status !== "pending" && row.status !== "approved") return;
    if (o.status === "cancelled") throw new Error("order_closed");
    const claimed = state.payments
      .filter((p) => p.orderId === row.orderId && (p.status === "pending" || p.status === "approved"))
      .reduce((s, p) => s + p.amountCents - p.tipCents, 0);
    const cap = Math.max(0, o.subtotalCents + o.taxCents - o.discountCents) + 1;
    if (claimed + row.amountCents - row.tipCents > cap) {
      throw new Error('P2010 Raw query failed. Code: `23514`. Message: `ERROR: amount_exceeds_outstanding`');
    }
  }

  const payment = {
    create: async ({ data }: { data: Partial<FakePayment> }) => {
      if (data.requestKey && state.payments.some((p) => p.requestKey === data.requestKey)) {
        throw new Error("Unique constraint failed on the fields: (`requestKey`)");
      }
      const row = newPayment(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      reservePayment(row);
      state.payments.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: { where: Where }) => {
      const row = state.payments.find((p) => matches(p, where));
      return row ? { ...row } : null;
    },
    findFirst: async ({ where, orderBy }: { where?: Where; orderBy?: { createdAt?: "asc" | "desc" } }) => {
      const rows = state.payments.filter((p) => matches(p, where));
      if (orderBy?.createdAt) {
        rows.sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * (orderBy.createdAt === "desc" ? -1 : 1));
      }
      return rows[0] ? { ...rows[0] } : null;
    },
    findMany: async ({ where }: { where?: Where } = {}) =>
      state.payments.filter((p) => matches(p, where)).map((p) => ({ ...p })),
    count: async ({ where }: { where?: Where } = {}) => state.payments.filter((p) => matches(p, where)).length,
    updateMany: async ({ where, data }: { where?: Where; data: Partial<FakePayment> }) => {
      const rows = state.payments.filter((p) => matches(p, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakePayment> }) => {
      const row = state.payments.find((p) => p.id === where.id);
      if (!row) throw new Error("payment_not_found");
      Object.assign(row, data);
      return { ...row };
    },
  };

  const order = {
    findUnique: async ({ where }: { where: Where }) => {
      const row = state.orders.find((o) => matches(o, where));
      return row ? { ...row } : null;
    },
    findUniqueOrThrow: async ({ where }: { where: Where }) => {
      const row = state.orders.find((o) => matches(o, where));
      if (!row) throw new Error("order_not_found");
      return { ...row };
    },
    findFirst: async ({ where }: { where: Where }) => {
      const row = state.orders.find((o) => matches(o, where));
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeOrder> }) => {
      const row = state.orders.find((o) => o.id === where.id);
      if (!row) throw new Error("order_not_found");
      Object.assign(row, data);
      return { ...row };
    },
  };

  const tx = { $queryRaw: async () => [], ...init.extraTx, payment, order };

  async function $transaction<T>(cb: (t: typeof tx) => Promise<T>): Promise<T> {
    const snapshot = {
      orders: state.orders.map((o) => ({ ...o })),
      payments: state.payments.map((p) => ({ ...p })),
    };
    try {
      return await cb(tx);
    } catch (err) {
      // Rollback, como Postgres.
      state.orders = snapshot.orders;
      state.payments = snapshot.payments;
      throw err;
    }
  }

  return {
    state,
    tx,
    $transaction,
    /** Pago por id (lee el estado actual, también después de un rollback). */
    payment: (id: string) => state.payments.find((p) => p.id === id),
    order: () => state.orders[0],
  };
}
