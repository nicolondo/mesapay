/**
 * Qué textos del catálogo viajan al navegador en cada superficie.
 *
 * Los Server Components leen los mensajes directo del request config
 * (`src/i18n/request.ts`) y no pesan en el HTML. Lo que sí pesa es lo que
 * recibe `NextIntlClientProvider`: se serializa completo en el payload RSC
 * de cada página. Con el catálogo entero eso eran ~480 KB de JSON por página
 * (≈ 145–180 KB con gzip), justo en las pantallas que se abren con datos
 * móviles: la carta del comensal tras escanear el QR y la portada/registro
 * desde un enlace de WhatsApp.
 *
 * Por eso:
 *   - El layout raíz sólo envía `GLOBAL_NAMESPACES` (lo que usan los Client
 *     Components montados en el propio layout raíz).
 *   - Cada superficie pública envuelve su subárbol con
 *     `<SurfaceIntlProvider surface="…">` (src/i18n/IntlProviders.tsx), que
 *     envía `GLOBAL_NAMESPACES` + `CLIENT_NAMESPACES[surface]`.
 *   - Las áreas con sesión del equipo (`FULL_CATALOG_AREAS`) envuelven su
 *     subárbol con `<FullIntlProvider>` y reciben el catálogo completo: son
 *     PWAs que se cargan una vez por turno, en wifi, y usan casi todo.
 *
 * Un provider anidado REEMPLAZA los mensajes del padre (no los mezcla), por
 * eso cada superficie incluye también los globales.
 *
 * Guardarraíl: `src/i18n/clientMessages.test.ts` recorre los imports de cada
 * superficie pública y falla si un Client Component alcanzable usa
 * `useTranslations("x")` con un namespace que no está en su lista (o si la
 * lista tiene namespaces que ya nadie usa). Para añadir uno: agrégalo a la
 * lista de la superficie que indique el test.
 */

/**
 * Namespaces que usan los Client Components del layout raíz
 * (`src/app/layout.tsx`). Hoy el layout raíz sólo monta `Providers`
 * (SessionProvider) y `StaleBuildReload`, que no muestran texto.
 */
export const GLOBAL_NAMESPACES: readonly string[] = [];

/**
 * Carpetas de primer nivel de `src/app` que son áreas con sesión del equipo
 * y reciben el catálogo completo (`<FullIntlProvider>` en su layout.tsx).
 */
export const FULL_CATALOG_AREAS = [
  "admin",
  "bar",
  "cocina",
  "comercial",
  "group",
  "mesero",
  "operator",
  "terminal",
] as const;

/**
 * Superficies públicas → namespaces que usan sus Client Components.
 *
 * La clave es la carpeta de primer nivel de `src/app` (su layout.tsx monta
 * `<SurfaceIntlProvider surface="clave">`), salvo `portada`, que es
 * `src/app/page.tsx` (montaría el provider dentro de la propia página).
 * Una superficie con lista vacía (sólo Server Components, o Client Components
 * sin textos) no necesita provider propio: hereda el del layout raíz.
 * Orden alfabético; el test dice exactamente qué falta o sobra.
 */
export const CLIENT_NAMESPACES = {
  cuenta: [],
  factura: ["emailInvoice", "staffPrint"],
  me: [],
  nicolas: ["card"],
  "nota-credito": [],
  p: ["menu", "pickup"],
  portada: [],
  privacidad: [],
  r: ["payLink", "reservar", "wait"],
  restablecer: ["resetPwd", "restaurantWelcome"],
  signin: [
    "forgotPwd",
    "operator",
    "signin",
    "workspaceUi",
  ],
  signup: [
    "daneCity",
    "legal",
    "location",
    "restaurantWelcome",
  ],
  t: [
    "apiErrors",
    "billingCustomers",
    "browserPrint",
    "common",
    "customerAuth",
    "done",
    "legal",
    "me",
    "menu",
    "order",
    "pay",
    "paymentPending",
    "pendingPayment",
    "preInvoice",
    "serve",
    "staffPrint",
    "terminalAttempt",
    "terminalPicker",
    "terminalResolve",
    "wait",
  ],
  terminos: [],
} as const satisfies Record<string, readonly string[]>;

export type Surface = keyof typeof CLIENT_NAMESPACES;

/**
 * Subconjunto del catálogo con sólo los namespaces pedidos (los que no
 * existan se ignoran). Devuelve las mismas referencias, sin copiar. El tipo
 * es el del catálogo: mismas formas, menos claves.
 */
export function pickMessages<M extends Record<string, unknown>>(
  messages: M,
  namespaces: readonly string[],
): M {
  const picked: Record<string, unknown> = {};
  for (const ns of namespaces) {
    if (Object.prototype.hasOwnProperty.call(messages, ns)) {
      picked[ns] = messages[ns];
    }
  }
  return picked as M;
}

/** Namespaces que recibe una superficie pública (globales + los suyos). */
export function surfaceNamespaces(surface: Surface): readonly string[] {
  return [...new Set([...GLOBAL_NAMESPACES, ...CLIENT_NAMESPACES[surface]])];
}
