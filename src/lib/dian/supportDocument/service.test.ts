// Emisión del documento soporte con la DIAN SIMULADA (como las pruebas de
// facturas y notas crédito): nunca hay red. La base es un almacén en memoria
// que respeta los `where` condicionados por estado, que son el cerrojo real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUYER, line, RESOLUTION } from "./__fixtures__/supportDoc";
import type { SupportDocDraft } from "./source";

const m = vi.hoisted(() => {
  type R = Record<string, unknown> & { id: string };
  const rows = new Map<string, R>();
  const seq = { ds: 1000, nas: 1, file: 0 };
  function matches(row: R, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
      const v = row[key];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { in?: unknown[]; lt?: Date };
        if (c.in) return c.in.includes(v);
        if (c.lt) return v instanceof Date && v < c.lt;
      }
      return v === cond;
    });
  }
  function apply(row: R, data: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && "increment" in (v as object)) {
        row[k] = (row[k] as number) + (v as { increment: number }).increment;
      } else row[k] = v;
    }
    row.updatedAt = new Date();
  }
  const store = {
    findFirst: vi.fn(async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      if (!row) return null;
      if (include) return { ...row, adjustments: [...rows.values()].filter((r) => r.adjustsId === row.id) };
      return { ...row };
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      return row ? { ...row } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error("not found");
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of rows.values()) {
        if (matches(row, where)) {
          apply(row, data);
          count++;
        }
      }
      return { count };
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.activeKey && [...rows.values()].some((r) => r.activeKey === data.activeKey)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const id = `doc${rows.size + 1}`;
      const row: R = {
        id,
        xmlZip: null,
        cuds: null,
        issuedAt: null,
        submissionFileName: null,
        trackId: null,
        errors: null,
        attempts: 0,
        lastError: null,
        adjustsId: null,
        reasonCode: null,
        expenseId: null,
        purchaseOrderId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.set(id, row);
      return { id, documentNumber: row.documentNumber };
    }),
  };
  const tx = { $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(), supportDocument: store };
  return {
    rows,
    seq,
    store,
    tx,
    config: vi.fn(),
    draft: vi.fn(),
    sign: vi.fn(),
    send: vi.fn(),
    testSend: vi.fn(),
    status: vi.fn(),
    statusZip: vi.fn(),
    dianConfigUpdate: vi.fn(),
  };
});
const tx = m.tx;

vi.mock("@/lib/db", () => ({
  db: {
    supportDocument: m.store,
    dianConfig: { updateMany: m.dianConfigUpdate, findUnique: vi.fn(async () => ({ id: "cfg" })) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(m.tx)),
  },
}));
vi.mock("./config", async (original) => ({ ...(await original<typeof import("./config")>()), loadSupportDocConfig: m.config }));
vi.mock("./source", async (original) => ({ ...(await original<typeof import("./source")>()), loadSupportDocDraft: m.draft }));
vi.mock("@/lib/dian/xades", () => ({ signXmlDian: m.sign }));
vi.mock("@/lib/dian/config", () => ({ resolveEmisor: vi.fn(async () => ({ ref: { kind: "restaurant", id: "r1" } })) }));
vi.mock("@/lib/dian/soap", async (original) => ({
  ...(await original<typeof import("@/lib/dian/soap")>()),
  sendBillSync: m.send,
  sendTestSetAsync: m.testSend,
  getStatus: m.status,
  getStatusZip: m.statusZip,
}));

import {
  createAdjustmentNote,
  createSupportDocument,
  refreshSupportDocumentStatus,
  resendSupportDocument,
} from "./service";

const NOW = new Date("2026-11-13T15:00:00Z");

const SUPPLIER = {
  id: "sup1",
  name: "Pedro Pérez",
  taxId: "1020304050",
  taxIdType: "CC",
  personType: "natural",
  address: "Calle 10 # 20-30",
  notObligatedToInvoice: true,
  cityCode: "05266",
  postalCode: "055422",
  countryCode: null,
  foreignCityName: null,
};

function draft(over: Partial<SupportDocDraft> = {}): SupportDocDraft {
  return {
    sourceType: "expense",
    sourceId: "e1",
    sourceLabel: "G-0001",
    supplier: SUPPLIER,
    operationDate: "2026-11-13",
    lines: [line()],
    paymentMeans: { id: "1", code: "1", dueDate: null },
    untransmittedWithholdings: [],
    ...over,
  };
}

function config(env: "habilitacion" | "produccion" = "produccion") {
  return {
    configId: "cfg",
    environment: env,
    envCode: env === "produccion" ? "1" : "2",
    cert: { notBefore: new Date("2025-01-01"), notAfter: new Date("2030-01-01") },
    softwareId: "sw-ds",
    softwarePin: "12345",
    testSetId: env === "habilitacion" ? "test-set-1" : null,
    resolution: RESOLUTION,
    adjustmentPrefix: "NAS",
    status: "pending",
    emisor: {},
    buyer: BUYER,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows.clear();
  Object.assign(m.seq, { ds: 1000, nas: 1, file: 0 });
  // Numeración: el UPDATE devuelve el número asignado según el tipo pedido.
  tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("CreditNoteFileSeries")) return [{ lastNumber: ++m.seq.file }];
    if (sql.includes("SupportDocumentSeries")) {
      const kind = values[3];
      return [{ id: `series-${kind}`, assigned: kind === "adjustment_note" ? m.seq.nas++ : m.seq.ds++ }];
    }
    return [];
  });
  m.config.mockResolvedValue(config());
  m.draft.mockResolvedValue(draft());
  m.sign.mockImplementation((xml: string) => `${xml}<!--firmado-->`);
  m.send.mockResolvedValue({ state: "accepted", errors: [], raw: "<ok/>" });
  m.testSend.mockResolvedValue({ state: "pending", zipKey: "zip-key-1", errors: [], raw: "<pending/>" });
  m.status.mockResolvedValue({ state: "rejected", statusCode: "66", errors: [] });
  m.statusZip.mockResolvedValue({ state: "accepted", errors: [], raw: "<accepted/>" });
});

const create = () =>
  createSupportDocument({ restaurantId: "r1", userId: "u1", sourceType: "expense", sourceId: "e1", now: NOW });

describe("generar y transmitir", () => {
  it("numera dentro del rango, guarda los bytes firmados ANTES de enviar y queda aceptado", async () => {
    m.send.mockImplementation(async (zip: Buffer, args: { fileName: string }) => {
      const row = [...m.rows.values()][0];
      // Ya están el ZIP, el CUDS y el nombre de archivo del anexo.
      expect(Buffer.from(row.xmlZip as Uint8Array).equals(zip)).toBe(true);
      expect(row.cuds).toMatch(/^[a-f0-9]{96}$/);
      // ds + NIT(10) + PPP 000 + año 26 + consecutivo hexadecimal (anexo §8.4).
      expect(row.submissionFileName).toBe("ds09003730760002600000001.xml");
      expect(args.fileName).toBe("z09003730760002600000001.zip");
      return { state: "accepted", errors: [], raw: "<ok/>" };
    });
    const r = await create();
    expect(r).toMatchObject({ documentNumber: "DS1000", state: "accepted", errors: [] });
    const row = [...m.rows.values()][0];
    expect(row).toMatchObject({ activeKey: "expense:e1", environment: "1", attempts: 1, totalCents: 10_000_000 });
    expect(m.sign.mock.calls[0][0]).toContain("<cbc:InvoiceTypeCode>05</cbc:InvoiceTypeCode>");
    expect(m.sign.mock.calls[0][2]).toEqual({ signingTime: "2026-11-13T10:00:00-05:00" });
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.testSend).not.toHaveBeenCalled();
  });

  it("habilitación: va al set de pruebas con el TestSetId y queda pendiente con el ZipKey", async () => {
    m.config.mockResolvedValue(config("habilitacion"));
    const r = await create();
    expect(r.state).toBe("pending");
    expect(m.testSend.mock.calls[0][1]).toBe("test-set-1");
    expect(m.send).not.toHaveBeenCalled();
    const row = [...m.rows.values()][0];
    expect(row).toMatchObject({ environment: "2", trackId: "zip-key-1" });
    // La consulta posterior por ZipKey lo acepta y el comercio pasa a "en pruebas".
    const after = await refreshSupportDocumentStatus({ restaurantId: "r1", id: row.id, now: NOW });
    expect(after.state).toBe("accepted");
    expect(m.statusZip).toHaveBeenCalledWith("zip-key-1", expect.anything());
    expect(m.dianConfigUpdate).toHaveBeenCalledWith({
      where: { id: "cfg", supportDocStatus: "pending" },
      data: { supportDocStatus: "testing" },
    });
  });

  it("no permite un segundo documento soporte para el mismo gasto", async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ code: "already_exists" });
    expect(m.rows.size).toBe(1);
  });

  it("no gasta número si el proveedor no está marcado o le faltan datos", async () => {
    m.draft.mockResolvedValue(draft({ supplier: { ...SUPPLIER, notObligatedToInvoice: false } }));
    await expect(create()).rejects.toMatchObject({ code: "supplier_not_flagged" });
    m.draft.mockResolvedValue(draft({ supplier: { ...SUPPLIER, postalCode: null } }));
    await expect(create()).rejects.toMatchObject({ code: "supplier_incomplete", detail: ["postal_code"] });
    m.draft.mockResolvedValue(draft({ supplier: null }));
    await expect(create()).rejects.toMatchObject({ code: "no_supplier" });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(m.rows.size).toBe(0);
  });

  it("no genera fuera de la vigencia de la autorización (DSAD09)", async () => {
    m.config.mockResolvedValue({ ...config(), resolution: { ...RESOLUTION, endDate: "2026-11-12" } });
    await expect(create()).rejects.toMatchObject({ code: "resolution_expired" });
    expect(m.rows.size).toBe(0);
  });
});

describe("rechazos y errores", () => {
  it("un rechazo se corrige y se reenvía con el MISMO número, armado de nuevo desde el gasto", async () => {
    m.send.mockResolvedValueOnce({ state: "rejected", statusCode: "99", errors: ["Regla: DSAJ73, Rechazo: código postal"], raw: "<no/>" });
    const first = await create();
    expect(first).toMatchObject({ state: "rejected", errors: ["Regla: DSAJ73, Rechazo: código postal"] });
    const firstCuds = [...m.rows.values()][0].cuds;
    m.draft.mockResolvedValue(draft({ supplier: { ...SUPPLIER, postalCode: "055420" } }));
    const again = await resendSupportDocument({ restaurantId: "r1", id: first.id, now: new Date(NOW.getTime() + 60_000) });
    expect(again).toMatchObject({ documentNumber: "DS1000", state: "accepted" });
    const row = [...m.rows.values()][0];
    expect(row.cuds).not.toBe(firstCuds);
    expect((row.snapshot as { seller: { address: { postalZone: string } } }).seller.address.postalZone).toBe("055420");
    expect(m.seq.ds).toBe(1001);
  });

  it("error de canal: consulta por CUDS y, si la DIAN no lo tiene, reenvía los MISMOS bytes", async () => {
    m.send.mockRejectedValueOnce(new Error("socket hang up — SECRETO"));
    const first = await create();
    expect(first).toMatchObject({ state: "error", errors: ["transport_error"] });
    expect(JSON.stringify([...m.rows.values()][0].errors)).not.toContain("SECRETO");
    const bytes = Buffer.from([...m.rows.values()][0].xmlZip as Uint8Array);
    const again = await resendSupportDocument({ restaurantId: "r1", id: first.id, now: NOW });
    expect(again.state).toBe("accepted");
    expect(m.status).toHaveBeenCalledTimes(1);
    expect(m.sign).toHaveBeenCalledTimes(1);
    expect(Buffer.from(m.send.mock.calls[1][0]).equals(bytes)).toBe(true);
  });

  it("si la DIAN ya lo tenía aceptado, no se retransmite", async () => {
    m.send.mockRejectedValueOnce(new Error("timeout"));
    const first = await create();
    m.status.mockResolvedValue({ state: "accepted", errors: [], raw: "<ya/>" });
    const again = await resendSupportDocument({ restaurantId: "r1", id: first.id, now: NOW });
    expect(again.state).toBe("accepted");
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("un bloqueo de configuración al reenviar no toca el estado ni manda nada", async () => {
    m.send.mockResolvedValueOnce({ state: "rejected", statusCode: "99", errors: ["Regla: DSAB24b"], raw: "" });
    const first = await create();
    m.config.mockResolvedValue({ ...config(), envCode: "2", environment: "habilitacion" });
    await expect(resendSupportDocument({ restaurantId: "r1", id: first.id, now: NOW })).rejects.toMatchObject({
      code: "environment_changed",
    });
    expect([...m.rows.values()][0].state).toBe("rejected");
  });

  it("dos envíos simultáneos: sólo el que gana el reclamo firma", async () => {
    m.send.mockResolvedValueOnce({ state: "rejected", statusCode: "99", errors: ["x"], raw: "" });
    const first = await create();
    const row = m.rows.get(first.id)!;
    row.state = "sent"; // otro proceso lo tiene
    const r = await resendSupportDocument({ restaurantId: "r1", id: first.id, now: NOW }).catch((e) => e);
    expect(r).toMatchObject({ code: "not_resendable" });
    expect(m.sign).toHaveBeenCalledTimes(1);
  });
});

describe("nota de ajuste", () => {
  async function acceptedDs() {
    m.draft.mockResolvedValue(
      draft({ lines: [line({ unitPriceCents: 1_000_000, lineTotalCents: 1_000_000, ivaCents: 190_000, ivaPct: "19.00" })] }),
    );
    return create();
  }

  it("anulación: CreditNote 95 con numeración interna, referencia al DS y libera el gasto", async () => {
    const ds = await acceptedDs();
    const nas = await createAdjustmentNote({
      restaurantId: "r1",
      userId: "u1",
      supportDocumentId: ds.id,
      reasonCode: "2",
      reasonText: "El gasto se registró dos veces por error",
      now: NOW,
    });
    expect(nas).toMatchObject({ documentNumber: "NAS1", state: "accepted" });
    const xml = m.sign.mock.calls[1][0] as string;
    expect(xml).toContain("<cbc:CreditNoteTypeCode>95</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cbc:ID>DS1000</cbc:ID>");
    expect(xml).not.toContain("InvoiceControl");
    const note = m.rows.get(nas.id)!;
    expect(note).toMatchObject({ kind: "adjustment_note", adjustsId: ds.id, subtotalCents: 1_000_000, taxCents: 190_000 });
    expect(note.submissionFileName).toMatch(/^nas0900373076/);
    // El gasto queda libre para un documento soporte nuevo.
    expect(m.rows.get(ds.id)!.activeKey).toBeNull();
    await expect(
      createAdjustmentNote({ restaurantId: "r1", userId: "u1", supportDocumentId: ds.id, reasonCode: "4", reasonText: "Ajuste de precio pactado con el vendedor", amountCents: 10, now: NOW }),
    ).rejects.toMatchObject({ code: "not_adjustable" });
  });

  it("ajuste parcial: reparte la base y el IVA y no deja pasar más de lo que queda", async () => {
    const ds = await acceptedDs();
    const nas = await createAdjustmentNote({
      restaurantId: "r1",
      userId: "u1",
      supportDocumentId: ds.id,
      reasonCode: "3",
      reasonText: "Descuento concedido después de la compra",
      amountCents: 250_000,
      now: NOW,
    });
    expect(m.rows.get(nas.id)).toMatchObject({ subtotalCents: 250_000, taxCents: 47_500, totalCents: 297_500 });
    expect(m.rows.get(ds.id)!.activeKey).toBe("expense:e1");
    await expect(
      createAdjustmentNote({ restaurantId: "r1", userId: "u1", supportDocumentId: ds.id, reasonCode: "3", reasonText: "Otro descuento concedido después", amountCents: 800_000, now: NOW }),
    ).rejects.toMatchObject({ code: "adjustment_exceeds" });
  });

  it("exige descripción de al menos 20 caracteres y un concepto de la tabla 16.2.4", async () => {
    const ds = await acceptedDs();
    await expect(
      createAdjustmentNote({ restaurantId: "r1", userId: "u1", supportDocumentId: ds.id, reasonCode: "2", reasonText: "corto", now: NOW }),
    ).rejects.toMatchObject({ code: "reason_too_short" });
    await expect(
      createAdjustmentNote({ restaurantId: "r1", userId: "u1", supportDocumentId: ds.id, reasonCode: "9", reasonText: "x".repeat(30), now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_reason" });
  });

  it("sólo se ajusta un documento soporte aceptado", async () => {
    m.send.mockResolvedValueOnce({ state: "rejected", statusCode: "99", errors: ["x"], raw: "" });
    const ds = await create();
    await expect(
      createAdjustmentNote({ restaurantId: "r1", userId: "u1", supportDocumentId: ds.id, reasonCode: "2", reasonText: "x".repeat(25), now: NOW }),
    ).rejects.toMatchObject({ code: "not_adjustable" });
  });
});
