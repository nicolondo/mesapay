// Per-restaurant payment method toggles.
//
// Admins decide which payment methods appear on the diner-facing
// checkout for a given restaurant. The Restaurant.enabledPaymentMethods
// column stores an array of slugs; null means "everything we know is
// enabled" so existing tenants don't lose buttons after this rolls out.
//
// Demo methods (demo_card, demo_cash, etc.) are NOT user-toggleable
// from this surface — they're for dev / sandbox and gated by the
// absence of real Kushki credentials.

import { db } from "@/lib/db";

export type PaymentMethodSlug =
  | "kushki_card_terminal"
  | "kushki_apple_pay"
  | "external_terminal"
  | "cash";

export type PaymentMethodConfig = {
  slug: PaymentMethodSlug;
  label: string;
  description: string;
};

export const PAYMENT_METHOD_CATALOG: PaymentMethodConfig[] = [
  {
    slug: "kushki_card_terminal",
    label: "Tarjeta con datáfono (Kushki)",
    description:
      "Cobro por datáfono Smart POS de Kushki — el mesero acerca el equipo a la mesa.",
  },
  {
    slug: "external_terminal",
    label: "Tarjeta con datáfono del comercio",
    description:
      "El comercio cobra con su propio datáfono (Bancolombia, Davivienda, etc.). El mesero confirma el cobro en /salón.",
  },
  {
    slug: "kushki_apple_pay",
    label: "Apple Pay",
    description:
      "El diner paga desde su iPhone con Face ID. Solo cuando Kushki está activo.",
  },
  {
    slug: "cash",
    label: "Efectivo",
    description: "Diner llama al mesero y paga con billetes (el mesero confirma el monto en /salón).",
  },
];

export const PAYMENT_METHOD_SLUGS = PAYMENT_METHOD_CATALOG.map((m) => m.slug);

/**
 * Resolve the JSON blob into a typed slug list. Anything malformed
 * falls back to "all enabled" so the checkout never ends up empty.
 */
export function resolveEnabledPaymentMethods(
  stored: unknown,
): PaymentMethodSlug[] {
  if (stored == null) return PAYMENT_METHOD_SLUGS.slice();
  if (!Array.isArray(stored)) return PAYMENT_METHOD_SLUGS.slice();
  const valid = new Set<PaymentMethodSlug>(PAYMENT_METHOD_SLUGS);
  const out: PaymentMethodSlug[] = [];
  for (const raw of stored) {
    if (typeof raw === "string" && valid.has(raw as PaymentMethodSlug)) {
      const slug = raw as PaymentMethodSlug;
      if (!out.includes(slug)) out.push(slug);
    }
  }
  // We DO allow an explicit empty list — if the admin disables all
  // three the diner just sees no payment options (extreme but valid).
  // Only fall back to defaults when the input wasn't a usable array
  // to begin with.
  return out;
}

export async function getEnabledPaymentMethods(
  restaurantId: string,
): Promise<PaymentMethodSlug[]> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledPaymentMethods: true },
  });
  if (!r) return PAYMENT_METHOD_SLUGS.slice();
  return resolveEnabledPaymentMethods(r.enabledPaymentMethods);
}
