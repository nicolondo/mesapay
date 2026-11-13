// Aviso de pagos pendientes del staff: un pago EN LÍNEA que quedó sin
// confirmar (`reconciliationRequired`) tiene que decir cómo se destraba la
// cuenta. Antes sólo había «Actualizar saldo»: la mesa quedaba bloqueada sin
// salida visible, aunque «Conciliar pago» existía en el detalle de la orden.
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import es from "../../../messages/es.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
import { PendingPaymentNotice, type PendingPaymentView } from "./PendingPaymentNotice";

const online = (over: Partial<PendingPaymentView> = {}): PendingPaymentView => ({
  id: "pay-1",
  method: "kushki_apple_pay",
  amountCents: 8_580_000,
  tipCents: 780_000,
  cashTenderCents: null,
  createdAt: "2026-11-13T18:00:00.000Z",
  replaceable: false,
  reconciliationRequired: false,
  ...over,
});

function notice(props: Partial<ComponentProps<typeof PendingPaymentNotice>>) {
  const child = createElement(PendingPaymentNotice, {
    pendings: [online()],
    order: { shortCode: "TEST", tableNumber: 4 },
    onConfirmed: () => {},
    ...props,
  });
  // eslint-disable-next-line react/no-children-prop -- Required by the provider's props type.
  return renderToStaticMarkup(createElement(NextIntlClientProvider,
    { locale: "es", timeZone: "America/Bogota", messages: es, children: child }));
}

const RECONCILE_HREF = "/operator/orders/order-7?conciliar=pay-1#conciliar-pay-1";

describe("PendingPaymentNotice: pago en línea sin confirmar", () => {
  it("el administrador ve «Conciliar pago», que lleva al bloque de conciliación de la orden", () => {
    const html = notice({ pendings: [online({ reconciliationRequired: true })], orderId: "order-7", canResolveTerminal: true });
    expect(html).toContain(es.pendingPayment.inFlightReviewKicker);
    expect(html).toContain(es.pendingPayment.inFlightReviewBody);
    expect(html).toMatch(new RegExp(`<a[^>]*href="${RECONCILE_HREF.replace(/[?]/g, "\\?")}"[^>]*>${es.pendingPayment.reconcile}</a>`));
    // Mismo nombre que el bloque al que lleva (título de ReconcilePayment).
    expect(es.pendingPayment.reconcile).toBe(es.paymentReconciliation.title);
    expect(html).not.toContain(es.pendingPayment.reconcileAskAdmin);
    expect(html).not.toContain(es.pendingPayment.inFlightKicker);
  });

  it("quien no es administrador ve que debe pedírselo al administrador, sin enlace", () => {
    const html = notice({ pendings: [online({ reconciliationRequired: true })], orderId: "order-7", canResolveTerminal: false });
    expect(html).toContain(es.pendingPayment.inFlightReviewKicker);
    expect(html).toContain(es.pendingPayment.reconcileAskAdmin);
    expect(html).not.toContain("/operator/orders/");
  });

  it("sin marcar para conciliación sigue siendo «Pago en línea en curso», sin acción de conciliar", () => {
    const html = notice({ orderId: "order-7", canResolveTerminal: true });
    expect(html).toContain(es.pendingPayment.inFlightKicker);
    expect(html).toContain(es.pendingPayment.inFlightBody);
    expect(html).not.toContain(es.pendingPayment.inFlightReviewKicker);
    expect(html).not.toContain("/operator/orders/");
  });
});
