// Estado de cada pago en el detalle de la orden. Un pago rechazado (por
// Kushki o conciliado a mano como «Cobro rechazado») salía como «Pendiente»:
// el `PaymentStatus` es `declined`, no `failed`.
import { describe, expect, it } from "vitest";
import es from "../../../../../messages/es.json";
import en from "../../../../../messages/en.json";
import pt from "../../../../../messages/pt.json";
import { paymentPill } from "./paymentPill";

describe("paymentPill", () => {
  it("rechazado → «Rechazado», en rojo (nunca «Pendiente»)", () => {
    expect(paymentPill("declined")).toEqual({ key: "payDeclined", tone: "danger" });
    expect(es.opOrders.payDeclined).toBe("Rechazado");
  });

  it("los demás estados no cambian", () => {
    expect(paymentPill("approved")).toEqual({ key: "payApproved", tone: "ok" });
    expect(paymentPill("refunded")).toEqual({ key: "payRefunded", tone: "muted" });
    expect(paymentPill("pending")).toEqual({ key: "payPending", tone: "muted" });
    expect(paymentPill("algo_raro")).toEqual({ key: "payPending", tone: "muted" });
  });

  it("cada clave existe en es, en y pt", () => {
    for (const status of ["approved", "declined", "refunded", "pending"]) {
      const { key } = paymentPill(status);
      for (const catalog of [es, en, pt]) expect((catalog.opOrders as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});
