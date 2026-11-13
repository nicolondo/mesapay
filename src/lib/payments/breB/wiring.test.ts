// Guardarraíl: Bre-B (y cualquier medio nuevo) tiene que estar cableado en
// todo lo que enumera medios de pago —etiquetas en los tres idiomas,
// clasificación, habilitación, contabilidad, factura—. Si alguien agrega un
// medio al enum y se olvida de una pantalla, esto lo dice.
import fs from "node:fs";
import path from "node:path";
import { PaymentMethod } from "@prisma/client";
import { describe, expect, it } from "vitest";
import es from "../../../../messages/es.json";
import en from "../../../../messages/en.json";
import pt from "../../../../messages/pt.json";
import { CLIENT_NAMESPACES } from "@/i18n/clientMessages";
import {
  BRE_B_CREDENTIAL_METHODS,
  DEFAULT_ENABLED_PAYMENT_METHOD_SLUGS,
  PAYMENT_METHOD_CATALOG,
  PAYMENT_METHOD_SLUGS,
  hasBreBCredentials,
  offerablePaymentMethods,
  resolveEnabledPaymentMethods,
} from "@/lib/paymentMethods";
import { ONLINE_METHOD_SLUGS } from "@/lib/payments/onlinePayments";
import { REPORTING_METHODS } from "@/lib/salesAnalysis/filters";
import { PAYMENT_METHOD_LABEL } from "@/lib/shiftReport";
import { BRE_B_PAYMENT_MEANS_CODE } from "@/lib/dian/emit";
import { ONLINE_PAYMENT_METHODS, isReplaceablePending } from "../methods";
import { breBSecondsLeft, formatBreBCountdown, isBreBOpenState } from "./view";
import { breBExpired, verifyBreBApproval } from "./rules";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const LANGS = { es, en, pt } as Record<string, Record<string, Record<string, unknown>>>;
const ENUM = Object.values(PaymentMethod) as string[];

const at = (obj: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

describe("etiquetas de todos los medios de pago, en es/en/pt", () => {
  it("avisos de pagos pendientes: cada método del enum tiene nombre", () => {
    for (const [lang, msgs] of Object.entries(LANGS)) {
      for (const m of ENUM) expect(at(msgs, `pendingPayment.methods.${m}`), `${lang}: ${m}`).toBeTruthy();
    }
  });

  it("análisis de ventas: cada método filtrable tiene nombre", () => {
    for (const [lang, msgs] of Object.entries(LANGS)) {
      for (const m of REPORTING_METHODS) expect(at(msgs, `salesAnalysis.method.${m}`), `${lang}: ${m}`).toBeTruthy();
    }
    expect(REPORTING_METHODS).toContain("kushki_bre_b");
  });

  it("cierre de turno (respaldo sin idioma): todos los métodos", () => {
    for (const m of ENUM) expect(PAYMENT_METHOD_LABEL[m as PaymentMethod], m).toBeTruthy();
  });

  it.each([
    ["src/app/operator/reports/ShiftPanel.tsx", "opReports.methodKushkiBreB"],
    ["src/app/operator/reports/page.tsx", "opReports.methodKushkiBreB"],
    ["src/app/operator/shifts/[id]/page.tsx", "opShifts.methodKushkiBreB"],
    ["src/app/operator/orders/[id]/page.tsx", "opOrders.mKushkiBreB"],
    ["src/app/operator/payments/page.tsx", "opPayments.mKushkiBreB"],
    ["src/app/operator/contabilidad/ContabilidadClient.tsx", "opErp.mKushkiBreB"],
    ["src/lib/print/invoiceDoc.ts", "emailInvoice.methodBreB"],
    ["src/app/terminal/TerminalGrid.tsx", "opTerminal.methodBreB"],
    ["src/app/t/[slug]/pay/[orderId]/done/page.tsx", "done.methodBreB"],
    ["src/app/r/[slug]/pago/[token]/PayLinkClient.tsx", "payLink.methodBreB"],
    ["src/app/api/operator/reports/close-of-day/route.ts", null],
  ])("%s rotula Bre-B", (file, key) => {
    expect(read(file)).toContain("kushki_bre_b");
    if (key) for (const [lang, msgs] of Object.entries(LANGS)) expect(at(msgs, key), `${lang}: ${key}`).toBeTruthy();
  });

  it("las pantallas del comensal reciben el namespace breB", () => {
    expect(CLIENT_NAMESPACES.t).toContain("breB");
    expect(CLIENT_NAMESPACES.r).toContain("breB");
  });
});

describe("clasificación", () => {
  it("Bre-B es pasarela en línea y, pendiente, plata en vuelo (nunca una solicitud reemplazable)", () => {
    expect(ONLINE_PAYMENT_METHODS).toContain("kushki_bre_b");
    expect(isReplaceablePending({ method: "kushki_bre_b", status: "pending", providerRef: null }, false)).toBe(false);
    expect(ONLINE_METHOD_SLUGS).toContain("kushki_bre_b");
  });

  it("el barrido de 30 minutos lo manda a conciliación", () => {
    expect(read("src/app/api/cron/stock-consumption/route.ts")).toMatch(/STALE_PROVIDER_METHODS[^;]*kushki_bre_b/);
  });

  it("no se devuelve por la API (Kushki no documenta devoluciones de Bre-B)", () => {
    const refund = read("src/app/api/operator/payments/[id]/refund/route.ts");
    const set = refund.match(/REFUNDABLE_METHODS = new Set\(\[([^\]]*)\]/)![1];
    expect(set).not.toContain("kushki_bre_b");
    for (const [lang, msgs] of Object.entries(LANGS)) expect(at(msgs, "opOrders.breBRefundManual"), lang).toBeTruthy();
  });

  it("la wallet de tarjeta/PSE no lo cuenta (lo recauda otro comercio de Kushki)", () => {
    for (const file of ["src/lib/walletIncoming/local.ts", "src/lib/walletTracking/sources.ts"]) {
      const line = read(file).split("\n").find((l) => /const METHODS/.test(l))!;
      expect(line, file).not.toContain("kushki_bre_b");
    }
  });

  it("contabilidad: va a pasarela, como tarjeta y PSE", () => {
    expect(read("src/lib/erp/posting.ts")).toMatch(/kushki_bre_b"\) return ENGINE\.PASARELA/);
  });

  it("factura electrónica: toda con Bre-B declara transferencia (47)", () => {
    expect(BRE_B_PAYMENT_MEANS_CODE).toBe("47");
  });
});

describe("habilitación por comercio", () => {
  it("Bre-B está en el catálogo, APAGADO por defecto y exige sus credenciales", () => {
    expect(PAYMENT_METHOD_SLUGS).toContain("kushki_bre_b");
    expect(PAYMENT_METHOD_CATALOG.find((m) => m.slug === "kushki_bre_b")).toMatchObject({
      defaultOff: true,
      requires: "bre_b_credentials",
    });
    expect(DEFAULT_ENABLED_PAYMENT_METHOD_SLUGS).not.toContain("kushki_bre_b");
    expect(resolveEnabledPaymentMethods(null)).not.toContain("kushki_bre_b");
    expect(resolveEnabledPaymentMethods("basura")).not.toContain("kushki_bre_b");
    expect(BRE_B_CREDENTIAL_METHODS).toEqual(["kushki_bre_b"]);
  });

  it("los comercios de siempre no pierden ni ganan medios con `null`", () => {
    expect(resolveEnabledPaymentMethods(null).sort()).toEqual(
      ["cash", "external_terminal", "kushki_apple_pay", "kushki_card", "kushki_card_terminal", "kushki_pse"].sort(),
    );
  });

  it("habilitado pero sin las DOS llaves: no se ofrece", () => {
    const stored = ["cash", "kushki_bre_b"];
    expect(offerablePaymentMethods(stored, { kushkiBreBPublicKey: "pub", kushkiBreBPrivateKeyEnc: "enc" })).toContain("kushki_bre_b");
    expect(offerablePaymentMethods(stored, { kushkiBreBPublicKey: "pub", kushkiBreBPrivateKeyEnc: null })).toEqual(["cash"]);
    expect(offerablePaymentMethods(stored, { kushkiBreBPublicKey: " ", kushkiBreBPrivateKeyEnc: "enc" })).toEqual(["cash"]);
    expect(hasBreBCredentials(null)).toBe(false);
  });
});

describe("reglas de una aprobación", () => {
  const expected = { amountCents: 4_550_000, currency: "COP", token: "tok", transactionReference: "ref", ticketNumber: "111" };
  const outcome = { amountCents: 4_550_000, currency: null, token: "tok", transactionReference: null, ticketNumber: "111" };

  it("monto y referencias iguales: se salda", () => {
    expect(verifyBreBApproval(expected, outcome)).toEqual({ ok: true });
    expect(verifyBreBApproval(expected, { ...outcome, currency: "COP" })).toEqual({ ok: true });
  });

  it.each([
    [{ amountCents: 4_540_000 }, "amount_mismatch"],
    [{ amountCents: null }, "amount_unverified"],
    [{ currency: "USD" }, "currency_mismatch"],
    [{ token: "otro" }, "reference_mismatch"],
    [{ ticketNumber: "222" }, "reference_mismatch"],
    [{ transactionReference: "otra" }, "reference_mismatch"],
  ])("%o → %s (no se salda)", (change, code) => {
    expect(verifyBreBApproval(expected, { ...outcome, ...change })).toEqual({ ok: false, code });
  });

  it("vencido con un margen de gracia; cuenta regresiva con la hora del servidor", () => {
    const now = new Date("2026-11-13T15:00:00Z");
    expect(breBExpired(new Date("2026-11-13T14:59:55Z"), now)).toBe(false);
    expect(breBExpired(new Date("2026-11-13T14:59:50Z"), now)).toBe(true);
    expect(breBExpired(null, now)).toBe(false);
    expect(breBSecondsLeft("2026-11-13T15:04:07Z", now.getTime())).toBe(247);
    expect(breBSecondsLeft("2026-11-13T14:00:00Z", now.getTime())).toBe(0);
    expect(formatBreBCountdown(247)).toBe("4:07");
    expect(isBreBOpenState("uncertain")).toBe(true);
    expect(isBreBOpenState("canceled")).toBe(false);
  });
});
