import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import es from "../../../../../../messages/es.json";

/**
 * Lo que el comensal VE en el estado del pedido (TipPreview) es lo que le
 * COBRA el flujo de pago (PayClient) con la misma propina: los dos reciben
 * del servidor el mismo `tipBase` (la cuenta y su parte sin impuesto) y lo
 * pasan por `tips.tipCentsFor`. Se renderizan las dos pantallas reales.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/t/sample/pay/o1",
  useSearchParams: () => new URLSearchParams(),
}));

import { TipPreview } from "./TipPreview";
import { PayClient } from "../../pay/[orderId]/PayClient";

const intl = {
  locale: "es",
  timeZone: "America/Bogota",
  messages: es,
} as unknown as ComponentProps<typeof NextIntlClientProvider>;
const render = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(NextIntlClientProvider, intl, el));
// Texto plano; "$ 10,000" (Intl) y "$10,000" (fmtCOP) se comparan igual.
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/\$ /g, "$");

// $108.000 con INC 8 % embebido: sin impuesto, $100.000.
const TIP_BASE = { chargeableCents: 10_800_000, preTaxCents: 10_000_000 };

function preview(tipBase = TIP_BASE, baseCents = 10_800_000) {
  return text(render(createElement(TipPreview, {
    orderId: "o1", currency: "COP", locale: "es",
    grossSubtotalCents: 10_800_000, discountCents: 0, discountPct: null, paidFoodCents: 0,
    baseCents, tipBase,
    taxLine: { kind: "inc", pct: 8, taxCents: 800_000 },
    payHref: "/t/sample/pay/o1", addMoreHref: "/t/sample/menu",
  })));
}

function payScreen(tipBase: typeof TIP_BASE | null = TIP_BASE, operatorMode = false) {
  return text(render(createElement(PayClient, {
    tenantSlug: "sample", tenantName: "Muestra", orderId: "o1", shortCode: "TEST", tableId: "t1",
    locationLabel: "Mesa 1", subtotalCents: 10_800_000, grossSubtotalCents: 10_800_000,
    paidCents: 0, paidTipCents: 0, alreadyPaid: false,
    items: [{ id: "i1", name: "Consumo", qty: 1, priceCents: 10_800_000, guestName: null }],
    serviceMode: "table", kushkiReady: false, kushkiPublicKey: null, kushkiMode: "mock", currency: "COP",
    card3ds: false, enabledMethods: ["cash"], pseBanks: [], operatorMode,
    salesTax: { kind: "inc", pct: 8 }, tipBase,
  } as never)));
}

describe("previsualización = cobro, sobre el valor antes de impuestos", () => {
  it("estado del pedido: 10 % de $100.000 = $10.000 y total $118.000, con la aclaración de la base", () => {
    const t = preview();
    expect(t).toContain("Propina 10 % $10,000");
    expect(t).toContain("Total con propina $118,000");
    expect(t).toContain("Sobre $100,000, el valor antes de impuestos.");
  });

  it.each([false, true])("pago (comensal y personal=%s): la MISMA propina y el MISMO total", (operatorMode) => {
    const t = payScreen(TIP_BASE, operatorMode);
    expect(t).toContain("Propina 10% $10,000");
    expect(t).toContain("$118,000");
    expect(t).toContain("$108,000 + $10,000 propina");
    expect(t).toContain("Sobre $100,000, el valor antes de impuestos.");
  });

  it("cuenta sin impuesto: 10 % del total en las dos pantallas y sin aclaración", () => {
    const none = { chargeableCents: 10_800_000, preTaxCents: 10_800_000 };
    const a = preview(none);
    const b = payScreen(none);
    expect(a).toContain("Propina 10 % $10,800");
    expect(b).toContain("Propina 10% $10,800");
    expect(a).not.toContain("antes de impuestos");
    expect(b).not.toContain("antes de impuestos");
  });

  it("pago parcial ya hecho: la base es la parte sin impuesto de lo que falta", () => {
    // Ya se pagaron $54.000 de comida: faltan $54.000 → base $50.000 → $5.000.
    const t = preview(TIP_BASE, 5_400_000);
    expect(t).toContain("Propina 10 % $5,000");
    expect(t).toContain("Total con propina $59,000");
  });
});
