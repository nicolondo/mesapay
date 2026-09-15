// Idempotencia del envío automático vs. reenvío manual (`force`).
//
// Son las dos mitades de la misma pieza y se contradicen si una se rompe:
// el camino automático NO puede mandar dos correos (los dos rieles de la
// aceptación corren sin coordinarse), y el reenvío manual TIENE que poder
// mandar aunque `emailedAt` ya tenga valor — es justamente para eso.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  docFindUnique: vi.fn(),
  docUpdateMany: vi.fn(),
  docUpdate: vi.fn(),
  requestFindFirst: vi.fn(),
  sendEmail: vi.fn(),
  renderEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    dianDocument: {
      findUnique: m.docFindUnique,
      updateMany: m.docUpdateMany,
      update: m.docUpdate,
    },
    invoiceRequest: { findFirst: m.requestFindFirst },
  },
}));
vi.mock("@/lib/mailer", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/simpleInvoice", () => ({
  brandedInvoiceFrom: () => "Son y Melona <facturas@mesapay.co>",
  invoiceUrlFor: (id: string) => `https://mesapay.co/factura/${id}`,
}));
vi.mock("@/lib/invoice", () => ({
  formatInvoiceNumber: () => "FESM6484",
}));
vi.mock("@/lib/dian/crypto", () => ({ dianQrUrl: () => "https://dian/qr" }));
vi.mock("@/lib/dian/attachedDocument", () => ({
  attachedDocumentFileName: () => "adFESM6484.xml",
  buildAttachedDocumentXml: () => "<AttachedDocument/>",
  invoiceIssueInstant: () => ({
    at: new Date("2026-09-01T15:00:00.000Z"),
    date: "2026-09-01",
    time: "10:00:00-05:00",
  }),
}));
vi.mock("@/lib/dian/emit", () => ({
  bogotaIssueTime: () => "10:00:00-05:00",
  CONSUMIDOR_FINAL: {},
}));
vi.mock("@/lib/dian/config", () => ({
  resolveEmisor: async () => ({ legalName: "SON Y MELONA S.A.S." }),
  emisorToSupplierParty: () => ({}),
}));
vi.mock("@/lib/dian/soap", () => ({
  extractApplicationResponse: async () => "<ApplicationResponse/>",
  unzipFirstXml: async () => "<Invoice/>",
  zipInvoice: async () => Buffer.from("zip"),
}));
// Parcial a propósito: `resolveDianRecipient` corre DE VERDAD (decidir a
// quién le llega la factura es parte de lo que se prueba acá).
vi.mock("@/lib/dian/invoiceEmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dian/invoiceEmail")>()),
  renderDianInvoiceEmail: m.renderEmail,
}));

import { sendDianInvoiceEmail } from "./sendInvoiceEmail";

// La fila de DianDocument, con la semántica real de `updateMany`: el
// `where` acotado es lo único que impide el correo duplicado, así que el
// doble no puede simplificarlo sin dejar de probar nada.
type Row = { emailedAt: Date | null; emailError: string | null; state: string };
let row: Row;

const send = (force?: boolean) =>
  sendDianInvoiceEmail({
    documentId: "doc-1",
    environment: "produccion",
    ...(force !== undefined && { force }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  row = { emailedAt: null, emailError: null, state: "accepted" };

  m.docFindUnique.mockImplementation(async () => ({
    id: "doc-1",
    restaurantId: "rest-1",
    state: row.state,
    cufe: "CUFE",
    xmlZip: Buffer.from("zip"),
    responseXml: "<Response/>",
    emailedAt: row.emailedAt,
    simpleInvoice: {
      id: "inv-1",
      email: "comensal@gmail.com",
      invoiceNumber: 6484,
      snapshot: {
        restaurantName: "Son y Melona",
        paidAtIso: "2026-09-01T15:00:00.000Z",
      },
      totalCents: 12_345_600,
      order: {
        id: "ord-1",
        locale: "es",
        simpleInvoiceEmail: null,
        paidAt: new Date("2026-09-01T15:00:00.000Z"),
      },
    },
  }));
  m.docUpdateMany.mockImplementation(
    async (args: {
      where: { emailedAt?: Date | null };
      data: { emailedAt?: Date | null; emailError?: string | null };
    }) => {
      if ("emailedAt" in args.where) {
        const want = args.where.emailedAt ?? null;
        const got = row.emailedAt;
        const same =
          want === null
            ? got === null
            : got !== null && got.getTime() === want.getTime();
        if (!same) return { count: 0 };
      }
      Object.assign(row, args.data);
      return { count: 1 };
    },
  );
  m.docUpdate.mockImplementation(
    async (args: {
      data: { emailedAt?: Date | null; emailError?: string | null };
    }) => {
      Object.assign(row, args.data);
      return {};
    },
  );
  m.requestFindFirst.mockResolvedValue(null);
  m.sendEmail.mockResolvedValue(true);
  m.renderEmail.mockResolvedValue({ subject: "s", html: "h", text: "t" });
});

describe("camino automático — sigue siendo idempotente", () => {
  it("manda una vez y la segunda pasada no vuelve a mandar", async () => {
    const first = await send();
    expect(first).toEqual({
      ok: true,
      to: "comensal@gmail.com",
      emailedAt: expect.any(String),
      attachment: true,
    });
    expect(m.sendEmail).toHaveBeenCalledTimes(1);

    const second = await send();
    expect(second).toEqual({ ok: false, reason: "already_emailed" });
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("los dos rieles de la aceptación a la vez ⇒ un solo correo", async () => {
    // Ambos leen `emailedAt: null`; el `updateMany` acotado es el que
    // desempata. Sin esa cláusula el comensal recibe la factura dos veces.
    const [a, b] = await Promise.all([send(), send()]);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = a.ok ? b : a;
    expect(loser).toEqual({ ok: false, reason: "already_emailed" });
  });

  it("si el correo falla se libera la marca para poder reintentar", async () => {
    m.sendEmail.mockResolvedValue(false);
    const res = await send();
    expect(res).toEqual({ ok: false, reason: "send_failed" });
    expect(row.emailedAt).toBeNull();
    expect(row.emailError).toBe("send_failed");
  });
});

describe("reenvío manual (force) — manda aunque ya se haya mandado", () => {
  it("con emailedAt puesto, force vuelve a mandar", async () => {
    row.emailedAt = new Date("2026-09-02T10:00:00.000Z");
    const res = await send(true);
    expect(res.ok).toBe(true);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0][0]).toMatchObject({
      to: "comensal@gmail.com",
    });
    // La marca queda actualizada al envío NUEVO.
    expect(row.emailedAt?.toISOString()).not.toBe("2026-09-02T10:00:00.000Z");
    expect(row.emailError).toBeNull();
  });

  it("el caso Son y Melona: aceptada con emailedAt en null, sale", async () => {
    // La 6484 se aceptó ANTES de que existiera el envío automático. Sin
    // force también saldría; lo que importa es que el reenvío la cubra.
    const res = await send(true);
    expect(res).toEqual({
      ok: true,
      to: "comensal@gmail.com",
      emailedAt: expect.any(String),
      attachment: true,
    });
  });

  it("un reenvío fallido NO borra la constancia del envío anterior", async () => {
    const before = new Date("2026-09-02T10:00:00.000Z");
    row.emailedAt = before;
    m.sendEmail.mockResolvedValue(false);

    const res = await send(true);
    expect(res).toEqual({ ok: false, reason: "send_failed" });
    expect(row.emailedAt?.toISOString()).toBe(before.toISOString());
    expect(row.emailError).toBe("send_failed");
  });
});

describe("guardarraíles — lo que NO se manda", () => {
  it.each(["to_send", "sent", "pending", "rejected", "error"])(
    "estado %s ⇒ not_accepted, ni con force",
    async (state) => {
      row.state = state;
      expect(await send(true)).toEqual({ ok: false, reason: "not_accepted" });
      expect(m.sendEmail).not.toHaveBeenCalled();
    },
  );

  it("documento inexistente ⇒ not_found", async () => {
    m.docFindUnique.mockResolvedValue(null);
    expect(await send(true)).toEqual({ ok: false, reason: "not_found" });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("nadie pidió factura ⇒ no_recipient, y no se toca emailedAt", async () => {
    m.docFindUnique.mockImplementation(async () => ({
      id: "doc-1",
      restaurantId: "rest-1",
      state: "accepted",
      cufe: "CUFE",
      xmlZip: null,
      responseXml: null,
      emailedAt: row.emailedAt,
      simpleInvoice: {
        id: "inv-1",
        email: null,
        invoiceNumber: 6484,
        snapshot: { restaurantName: "Son y Melona", paidAtIso: "2026-09-01T15:00:00.000Z" },
        totalCents: 1,
        order: { id: "ord-1", locale: "es", simpleInvoiceEmail: null, paidAt: null },
      },
    }));
    expect(await send(true)).toEqual({ ok: false, reason: "no_recipient" });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(row.emailedAt).toBeNull();
    expect(row.emailError).toBe("no_recipient");
  });

  it("aceptado pero sin CUFE ⇒ incomplete_document", async () => {
    m.docFindUnique.mockResolvedValue({
      id: "doc-1",
      restaurantId: "rest-1",
      state: "accepted",
      cufe: null,
      xmlZip: null,
      responseXml: null,
      emailedAt: null,
      simpleInvoice: null,
    });
    expect(await send(true)).toEqual({
      ok: false,
      reason: "incomplete_document",
    });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});
