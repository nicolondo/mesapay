// Per-restaurant payment method toggles.
//
// Admins decide which payment methods appear on the diner-facing
// checkout for a given restaurant. The Restaurant.enabledPaymentMethods
// column stores an array of slugs; null means "everything we know is
// enabled" so existing tenants don't lose buttons after this rolls out —
// EXCEPT the methods flagged `defaultOff` (Bre-B): those are opt-in per
// restaurant and also need their own credentials.
//
// Demo methods (demo_card, demo_nequi) are NOT user-toggleable from this
// surface — they're for dev / sandbox and gated by `demoPaymentsAllowed`.
// El efectivo sí: el slug "cash" coincide con PaymentMethod.cash (los
// pagos viejos quedaron como demo_cash; ver lib/payments/methods.ts).

import { db } from "@/lib/db";

export type PaymentMethodSlug =
  | "kushki_card_terminal"
  | "kushki_card"
  | "kushki_apple_pay"
  | "kushki_pse"
  | "kushki_bre_b"
  | "external_terminal"
  | "cash";

export type PaymentMethodConfig = {
  slug: PaymentMethodSlug;
  label: string;
  description: string;
  /**
   * APAGADO por defecto: no entra en el "todo habilitado" de
   * `enabledPaymentMethods = null`. Hay que prenderlo a mano en /admin.
   */
  defaultOff?: boolean;
  /**
   * Lo que el comercio tiene que tener cargado para poder prenderlo.
   * `bre_b_credentials` = las llaves del comercio Bre-B de Kushki
   * (`Restaurant.kushkiBreB*`), distintas de las de tarjeta/PSE.
   */
  requires?: "bre_b_credentials";
};

export const PAYMENT_METHOD_CATALOG: PaymentMethodConfig[] = [
  {
    slug: "kushki_card_terminal",
    label: "Tarjeta con datáfono (Kushki)",
    description:
      "Cobro por datáfono Smart POS de Kushki — el mesero acerca el equipo a la mesa.",
  },
  {
    slug: "kushki_card",
    label: "Tarjeta de crédito o débito",
    description:
      "El diner ingresa los datos de su tarjeta en MESAPAY (tokenización en browser vía Kushki — los datos no tocan nuestro server).",
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
    slug: "kushki_pse",
    label: "PSE (transferencia bancaria)",
    description:
      "El diner elige su banco, va a la web del banco a autenticarse y vuelve. Resultado por webhook.",
  },
  {
    slug: "kushki_bre_b",
    // El panel de /admin muestra estos dos textos traducidos
    // (`opAdmin.pm_kushki_bre_b_*`); esto es sólo el respaldo.
    label: "Bre-B (QR de pago inmediato)",
    description:
      "MESAPAY muestra un QR con el monto y el cliente lo escanea desde la app de su banco. Necesita las llaves del comercio Bre-B de Kushki.",
    defaultOff: true,
    requires: "bre_b_credentials",
  },
  {
    slug: "cash",
    label: "Efectivo",
    description: "Diner llama al mesero y paga con billetes (el mesero confirma el monto en /salón).",
  },
];

export const PAYMENT_METHOD_SLUGS = PAYMENT_METHOD_CATALOG.map((m) => m.slug);

/**
 * Lo que significa `enabledPaymentMethods = null` ("todo habilitado"): el
 * catálogo SIN los medios apagados por defecto. Bre-B nace apagado para
 * todos los comercios, también los que ya existían.
 */
export const DEFAULT_ENABLED_PAYMENT_METHOD_SLUGS = PAYMENT_METHOD_CATALOG.filter(
  (m) => !m.defaultOff,
).map((m) => m.slug);

/** Medios que exigen las llaves del comercio Bre-B para poder habilitarse. */
export const BRE_B_CREDENTIAL_METHODS: readonly PaymentMethodSlug[] = PAYMENT_METHOD_CATALOG.filter(
  (m) => m.requires === "bre_b_credentials",
).map((m) => m.slug);

/** ¿El comercio tiene cargadas las DOS llaves del comercio Bre-B? */
export function hasBreBCredentials(
  tenant: { kushkiBreBPublicKey?: string | null; kushkiBreBPrivateKeyEnc?: string | null } | null | undefined,
): boolean {
  return !!tenant?.kushkiBreBPublicKey?.trim() && !!tenant?.kushkiBreBPrivateKeyEnc;
}

/**
 * Los medios habilitados que el comercio de verdad PUEDE ofrecer: quita los
 * que exigen las llaves Bre-B si no están cargadas (p. ej. se borraron
 * después de habilitarlo). Es lo que usan las pantallas de cobro.
 */
export function offerablePaymentMethods(
  stored: unknown,
  tenant: { kushkiBreBPublicKey?: string | null; kushkiBreBPrivateKeyEnc?: string | null } | null | undefined,
): PaymentMethodSlug[] {
  const enabled = resolveEnabledPaymentMethods(stored);
  if (hasBreBCredentials(tenant)) return enabled;
  return enabled.filter((m) => !BRE_B_CREDENTIAL_METHODS.includes(m));
}

/**
 * Métodos que se pueden cobrar de forma REMOTA (el cliente no está en el
 * local). Son los únicos válidos para un depósito de reserva: efectivo y
 * datáfono son presenciales, no sirven para apartar a distancia.
 */
export const DEPOSIT_CAPABLE_SLUGS: PaymentMethodSlug[] = [
  "kushki_card",
  "kushki_pse",
  "kushki_apple_pay",
];

/**
 * Resuelve qué métodos se ofrecen para el DEPÓSITO de reserva.
 * Intersección de: (métodos habilitados del comercio) ∩ (online-capaces)
 * ∩ (selección guardada por el operador). storedDeposit null = todos los
 * habilitados online (default sensato).
 */
export function resolveDepositMethods(
  storedDeposit: unknown,
  enabled: PaymentMethodSlug[],
): PaymentMethodSlug[] {
  const capable = enabled.filter((s) => DEPOSIT_CAPABLE_SLUGS.includes(s));
  if (storedDeposit == null || !Array.isArray(storedDeposit)) {
    return capable;
  }
  const chosen = new Set(
    storedDeposit.filter((x): x is string => typeof x === "string"),
  );
  return capable.filter((s) => chosen.has(s));
}

/**
 * Resolve the JSON blob into a typed slug list. Anything malformed
 * falls back to "all enabled" so the checkout never ends up empty.
 */
export function resolveEnabledPaymentMethods(
  stored: unknown,
): PaymentMethodSlug[] {
  if (stored == null) return DEFAULT_ENABLED_PAYMENT_METHOD_SLUGS.slice();
  if (!Array.isArray(stored)) return DEFAULT_ENABLED_PAYMENT_METHOD_SLUGS.slice();
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
  if (!r) return DEFAULT_ENABLED_PAYMENT_METHOD_SLUGS.slice();
  return resolveEnabledPaymentMethods(r.enabledPaymentMethods);
}
