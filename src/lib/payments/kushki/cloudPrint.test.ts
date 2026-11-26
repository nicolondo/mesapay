import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { KUSHKI_BP_BUSINESS_CODE: undefined, KUSHKI_CLOUD_TERMINAL_PATH: undefined } }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));
import { decryptData, tokenPassword } from "./cloudTerminal";
import {
  buildInvoiceCommands,
  getCloudPrintJobStatus,
  printOnCloudTerminal,
  waitForCloudPrintJob,
  type CloudPrintJobState,
  type PrintCommand,
} from "./cloudPrint";
import type { InvoiceSnapshot } from "@/lib/invoice";

/**
 * El Print API cloud de Kushki ONE, según su contrato (2026-11-13): crear
 * es POST …/sync/print y un 202 es ENCOLADO (no impreso); el estado real
 * sale de POST …/sync/print_job con { print_job_id }. Se blinda la ruta, lo
 * que va cifrado, y el sondeo: «impresa» sólo con COMPLETED. Nunca se llama
 * a Kushki: `fetch` es de mentira.
 */

const target = { serialNumber: "SN-1", businessCode: "BC-1", mode: "production" as const };

type Call = { url: string; payload: Record<string, unknown> };

/** Un relay de mentira que descifra lo que recibe y responde lo pedido. */
function relay(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const ts = Number(init.headers.timestamp);
    const password = tokenPassword("BC-1" + "SN-1", ts);
    const { data } = JSON.parse(init.body) as { data: string };
    calls.push({ url, payload: JSON.parse(decryptData(data, ts, password)) });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { fn, calls };
}

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  log.mockRestore();
  err.mockRestore();
});

describe("crear el trabajo: POST …/sync/print", () => {
  it("la ruta del contrato y el cuerpo cifrado { printJobId, commands, externalReference } (sin skipIfBusy)", async () => {
    const r = relay([{ status: 202, body: { printJobId: "job-1", status: "PENDING", message: "Impresión encolada correctamente." } }]);
    vi.stubGlobal("fetch", r.fn);
    const out = await printOnCloudTerminal({
      ...target,
      printJobId: "job-1",
      externalReference: "prebill-o-1",
      commands: [{ type: "text", text: "Hola\n", align: "CENTER", size: 24 }, { type: "feed", lines: 3 }, { type: "cut" }],
    });
    expect(r.calls[0].url).toMatch(/\/terminal\/v1\/SN-1\/sync\/print$/);
    expect(r.calls[0].payload).toEqual({
      printJobId: "job-1",
      externalReference: "prebill-o-1",
      commands: [{ type: "text", text: "Hola\n", align: "CENTER", size: 24 }, { type: "feed", lines: 3 }, { type: "cut" }],
    });
    // 202 = encolado, no impreso.
    expect(out).toMatchObject({ ok: true, printJobId: "job-1", status: "PENDING", httpStatus: 202 });
    // La respuesta 2xx también queda en el log (sin el documento).
    expect(log).toHaveBeenCalledWith(
      "[kushki/cloud-print] encolada",
      expect.objectContaining({ httpStatus: 202, status: "PENDING", printJobId: "job-1" }),
    );
  });

  it("un 4xx no es ok y se registra con el cuerpo", async () => {
    vi.stubGlobal("fetch", relay([{ status: 400, body: { code: "PRINT-001", message: "invalid commands" } }]).fn);
    const out = await printOnCloudTerminal({ ...target, printJobId: "job-2", commands: [] });
    expect(out).toMatchObject({ ok: false, httpStatus: 400, message: "invalid commands" });
    expect(err).toHaveBeenCalledWith("[kushki/cloud-print] rechazada", expect.objectContaining({ httpStatus: 400 }));
  });

  it("sin respuesta (red caída) no lanza", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await printOnCloudTerminal({ ...target, printJobId: "job-3", commands: [] })).toMatchObject({
      ok: false,
      message: "network_error",
    });
  });
});

describe("estado del trabajo: POST …/sync/print_job", () => {
  it("manda { print_job_id } en el cuerpo y lee status, errorCode y errorMessage", async () => {
    const r = relay([{ status: 200, body: { printJobId: "job-1", status: "FAILED", errorCode: "OUT_OF_PAPER", errorMessage: "Sin papel" } }]);
    vi.stubGlobal("fetch", r.fn);
    const st = await getCloudPrintJobStatus({ ...target, printJobId: "job-1" });
    expect(r.calls[0].url).toMatch(/\/terminal\/v1\/SN-1\/sync\/print_job$/);
    expect(r.calls[0].payload).toEqual({ print_job_id: "job-1" });
    expect(st).toEqual({ ok: true, httpStatus: 200, status: "FAILED", errorCode: "OUT_OF_PAPER", errorMessage: "Sin papel" });
  });

  it("404 (no existe) no es un estado", async () => {
    vi.stubGlobal("fetch", relay([{ status: 404, body: { message: "not found" } }]).fn);
    expect(await getCloudPrintJobStatus({ ...target, printJobId: "x" })).toEqual({ ok: false, httpStatus: 404 });
  });
});

describe("esperar el resultado real", () => {
  /** Reloj y sueño de mentira: cada sueño avanza el reloj. */
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }
  const seq = (...states: CloudPrintJobState[]) => {
    const list = [...states];
    return vi.fn(async () => list.shift() ?? states[states.length - 1]);
  };

  it("202 → PENDING → IN_PROGRESS → COMPLETED: impresa", async () => {
    const getStatus = seq(
      { ok: true, status: "PENDING" },
      { ok: true, status: "IN_PROGRESS" },
      { ok: true, status: "COMPLETED" },
    );
    expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({ state: "completed" });
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it("FAILED con OUT_OF_PAPER: falló, con el código", async () => {
    const getStatus = seq({ ok: true, status: "FAILED", errorCode: "OUT_OF_PAPER", errorMessage: "Sin papel" });
    expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({
      state: "failed",
      errorCode: "OUT_OF_PAPER",
      errorMessage: "Sin papel",
    });
  });

  it("sigue PENDING al vencer ~30 s: queda encolada (se reintenta con el mismo id)", async () => {
    const getStatus = seq({ ok: true, status: "PENDING" });
    const out = await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus, intervalMs: 2500, timeoutMs: 30_000 });
    expect(out).toEqual({ state: "pending", lastStatus: "PENDING" });
    expect(getStatus.mock.calls.length).toBe(12);
  });

  it.each([{ error: "timeout" }, { httpStatus: 504 }, { errorCode: "TERMINAL_BUSY", httpStatus: 400 }])(
    "un sondeo fallido %o se recupera al confirmar el trabajo", async error => {
      const getStatus = seq({ ok: false, ...error }, { ok: true, status: "COMPLETED" });
      expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({ state: "completed" });
      expect(getStatus).toHaveBeenCalledTimes(2);
    });

  it("una respuesta válida reinicia la cuenta de sondeos fallidos", async () => {
    const getStatus = seq({ ok: false, error: "timeout" }, { ok: true, status: "IN_PROGRESS" },
      { ok: false, httpStatus: 504 }, { ok: false, error: "timeout" });
    expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({
      state: "pending", backoff: true, lastStatus: "IN_PROGRESS",
    });
    expect(getStatus).toHaveBeenCalledTimes(4);
  });

  it("un error del sondeo no corta: se vuelve a preguntar", async () => {
    const getStatus = seq({ ok: false, httpStatus: 500 }, { ok: true, status: "COMPLETED" });
    expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({ state: "completed" });
  });
});

describe("buildInvoiceCommands — la tirilla del datáfono (55 mm)", () => {
  const PRICE = 3_390_000;
  const BASE = Math.round(PRICE / 1.08);
  const TIP = Math.round(BASE * 0.1);
  const snapshot: InvoiceSnapshot = {
    restaurantName: "Son y Melona",
    logoUrl: null,
    legalName: "SON Y MELONA S.A.S.",
    taxId: "901.234.567-8",
    legalAddress: "Carrera 43A # 1-50, local 102",
    legalCity: "Envigado",
    legalPhone: "604 444 5566",
    dianResolution: "18764000012345",
    dianResolutionFrom: 1,
    dianResolutionTo: 100000,
    dianResolutionDate: "2026-01-15T00:00:00.000Z",
    invoicePrefix: "FESM",
    shortCode: "002A77-77C496-58E6EF-6C25C8",
    tableLabel: "Mesa 4",
    paidAtIso: "2026-11-12T17:53:00.000Z",
    items: [
      {
        qty: 1,
        name: "Plato del Día (Casero Del Dia)",
        priceCents: PRICE,
        menuItemId: "mi-1",
        taxKind: null,
        taxPct: null,
        modifiers: [
          "Opción de sopa: Fríjoles",
          "Opción de proteína: Pollo a la parrilla",
          "Bebida: Limonada natural",
        ],
        notes: null,
      },
    ],
    subtotalCents: PRICE,
    salesTaxKind: "inc",
    salesTaxPct: 8,
    embeddedTaxCents: PRICE - BASE,
    embeddedBaseCents: BASE,
    discountCents: 0,
    tipCents: TIP,
    totalCents: PRICE + TIP,
    customer: null,
  };

  /**
   * Los comandos como los dibujaría el papel del datáfono (32 columnas a
   * tamaño 24): `columns` 2:1 reparte 21/11 y rellena con espacios; cada
   * `text` va tal cual (ya viene envuelto por este módulo). Sirve para
   * LEER el diseño en los asserts, no para reproducir píxeles.
   */
  function renderCommands(commands: PrintCommand[]): string {
    const out: string[] = [];
    for (const c of commands) {
      if (c.type === "text") out.push(...c.text.replace(/\n$/, "").split("\n"));
      else if (c.type === "columns") {
        const [l, r] = c.columns;
        out.push(l.text + " " + (r?.text ?? "").padStart(Math.max(0, 31 - l.text.length)));
      } else if (c.type === "divider") out.push("-".repeat(32));
      else if (c.type === "qr") out.push("[QR]");
    }
    return out.join("\n");
  }

  const commands = () =>
    buildInvoiceCommands(
      snapshot,
      6723,
      "https://mesapay.co/factura/inv-1",
      undefined,
      null,
      [
        {
          method: "kushki_card_terminal",
          amountCents: PRICE + TIP,
          tipCents: TIP,
          cardBrand: "VISA",
          cardLast4: "4242",
          approvalCode: "123456",
        },
      ],
    );

  it("snapshot del diseño en texto", () => {
    expect(renderCommands(commands())).toMatchSnapshot();
  });

  it("ninguna palabra partida: todo texto viene pre-envuelto a su ancho", () => {
    for (const c of commands()) {
      if (c.type !== "text") continue;
      const size = c.size ?? 24;
      const cols = Math.floor((32 * 24) / size);
      for (const l of c.text.split("\n")) {
        expect(l.length, `"${l}" a tamaño ${size}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("el nombre largo nunca comparte columna con el precio: la primera línea entra en 20 columnas", () => {
    const cols = commands().filter((c): c is Extract<PrintCommand, { type: "columns" }> => c.type === "columns");
    for (const c of cols) {
      expect(c.columns[0].text.length).toBeLessThanOrEqual(20);
    }
    // El resto del nombre sigue en renglones `text` completos.
    const text = renderCommands(commands());
    expect(text).toContain("(Casero Del Dia)");
  });

  it("la fecha va en su propio renglón, entera", () => {
    const text = renderCommands(commands());
    const dateLine = text.split("\n").find((l) => l.includes("12:53"));
    expect(dateLine).toBeDefined();
    expect(dateLine).toMatch(/12\/11\/2026/);
  });

  it("modificadores: uno por renglón, sangrados y envueltos por palabra", () => {
    const lines = renderCommands(commands()).split("\n");
    expect(lines).toContain("   - Opción de sopa: Fríjoles");
    expect(lines).toContain("   - Opción de proteína: Pollo a");
    expect(lines).toContain("   la parrilla");
    expect(lines).toContain("   - Bebida: Limonada natural");
  });

  it("la sección «Pagos» sale con el detalle de la tarjeta y el TOTAL PAGADO", () => {
    const text = renderCommands(commands());
    expect(text).toContain("Pagos");
    // El detalle de la tarjeta, entero (envuelto por palabra en 32 col).
    expect(text.replace(/\n {3}/g, " ")).toContain("VISA · ····4242 · Aprob. 123456");
    expect(text).toContain("TOTAL PAGADO");
  });

  it("sin pagos no hay sección (como siempre)", () => {
    const sin = buildInvoiceCommands(snapshot, 6723, "https://mesapay.co/factura/inv-1");
    expect(renderCommands(sin)).not.toContain("TOTAL PAGADO");
  });

  it("separadores: ningún divider del equipo — la línea fina de guiones en texto", () => {
    // El `divider` del Sunmi sale grueso (el dueño pidió «sólidas y
    // delgadas», FESM8648) y no avanza renglón (FESM8617/8618): el
    // separador es una línea de TEXTO de 32 guiones, que consume su renglón.
    const all = commands();
    expect(all.some((c) => c.type === "divider")).toBe(false);
    const separators = all.filter((c) => c.type === "text" && c.text === "-".repeat(32) + "\n");
    expect(separators.length).toBeGreaterThanOrEqual(4);
    // El del encabezado va justo después del teléfono (texto): al ser texto
    // no puede salir montado sobre él.
    const tel = all.findIndex((c) => c.type === "text" && c.text.startsWith("Tel"));
    const next = all[tel + 1];
    expect(next.type === "text" && next.text).toBe("-".repeat(32) + "\n");
  });
});
