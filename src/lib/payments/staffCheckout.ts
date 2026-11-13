/**
 * Cobro hecho por el EQUIPO (el checkout en modo staff, `PayFlow op="1"`):
 * quién puede usarlo, a qué pantallas vuelve cada rol y qué le muestra.
 *
 * Lo comparten el checkout (`PayFlow`), la espera del datáfono
 * (`/t/[slug]/pay/[orderId]/terminal`) y la pantalla de "cobro hecho"
 * (`/t/[slug]/pay/[orderId]/done`), para que las tres traten igual a cada
 * rol. Antes cada una repetía su propia lista de roles y de enlaces.
 *
 * El usuario de DATÁFONO (`terminal`) cobra desde «Mesas en vivo»
 * (`/terminal`) con el mismo checkout que el mesero y el administrador,
 * pero SOLO cobra: crea el pago, lo envía al datáfono, confirma el efectivo
 * y cancela o reintenta su propio intento. No da cortesías, no anula
 * facturas, no cobra a crédito ni con bonos, no asocia clientes ni emite la
 * factura antes de cobrar. El servidor lo bloquea igual en cada ruta; esto
 * sólo evita mostrarle botones que le van a rebotar.
 *
 * Archivo puro (sin servidor): se testea sin base de datos.
 */

/** Roles que pueden cobrar una cuenta desde el checkout en modo staff. */
export const CHECKOUT_STAFF_ROLES = [
  "operator",
  "platform_admin",
  "group_admin",
  "mesero",
  "terminal",
] as const;

/** Para qué rol se arma la pantalla. */
export type StaffCheckoutView = "admin" | "mesero" | "terminal";

export function staffCheckoutView(role: string | null | undefined): StaffCheckoutView {
  if (role === "mesero") return "mesero";
  if (role === "terminal") return "terminal";
  return "admin";
}

export type StaffCheckoutRoutes = {
  /** El checkout de la cuenta (para "cobrar más" o reintentar). */
  checkoutHref: string;
  /** "Cobro hecho" (sin `pid`). */
  doneHref: string;
  /** Adónde vuelve al terminar o al tocar "volver". */
  homeHref: string;
  /** Adónde va cuando la solicitud queda pendiente (Salón / Mesas en vivo). */
  serveHref: string;
};

/**
 * Enlaces del cobro según el rol. El mesero se queda dentro de su app
 * (`/mesero/*`, el scope de la PWA); el datáfono vuelve a «Mesas en vivo»;
 * el administrador, a las pantallas del panel.
 */
export function staffCheckoutRoutes(
  role: string | null | undefined,
  { slug, orderId }: { slug: string; orderId: string },
): StaffCheckoutRoutes {
  const view = staffCheckoutView(role);
  const opCheckout = `/t/${slug}/pay/${orderId}?op=1`;
  const opDone = `/t/${slug}/pay/${orderId}/done?op=1`;
  if (view === "mesero") {
    return {
      checkoutHref: `/mesero/cobrar/${orderId}`,
      doneHref: `/mesero/cobrar/${orderId}/done`,
      homeHref: "/mesero/mesas",
      serveHref: "/mesero/salon",
    };
  }
  if (view === "terminal") {
    return {
      checkoutHref: `/terminal/cobrar/${orderId}`,
      doneHref: opDone,
      homeHref: "/terminal",
      serveHref: "/terminal",
    };
  }
  return {
    checkoutHref: opCheckout,
    doneHref: opDone,
    homeHref: "/operator/tables",
    serveHref: "/operator/serve",
  };
}

/**
 * Lo que el checkout le ofrece al rol, ADEMÁS de lo que diga el comercio
 * (módulos, clientes con crédito, cortesías habilitadas…). `false` acá
 * apaga la opción aunque el comercio la tenga.
 */
export type StaffCheckoutCapabilities = {
  /** Anular la factura emitida antes de cobrar (nota crédito). */
  annulInvoice: boolean;
  /** Paso "Cliente" (asociar un cliente de facturación a la cuenta). */
  customerStep: boolean;
  /** Cobrar a crédito a un cliente. */
  credit: boolean;
  /** Pagar con bono empresarial. */
  vouchers: boolean;
  /** Emitir la factura ANTES de cobrar. */
  preInvoice: boolean;
  /** Enlace a configurar impresoras (sólo el panel lo tiene). */
  configurePrinters: boolean;
};

export function staffCheckoutCapabilities(
  role: string | null | undefined,
): StaffCheckoutCapabilities {
  const view = staffCheckoutView(role);
  if (view === "terminal") {
    return {
      annulInvoice: false,
      customerStep: false,
      credit: false,
      vouchers: false,
      preInvoice: false,
      configurePrinters: false,
    };
  }
  return {
    // Anular con nota crédito: los administradores, no el mesero.
    annulInvoice: view === "admin",
    customerStep: true,
    credit: true,
    vouchers: true,
    preInvoice: true,
    configurePrinters: view === "admin",
  };
}

/**
 * A quién se le anota un cobro de datáfono que inicia el EQUIPO
 * (`Payment.collectedByUserId`): al mesero, al administrador y al usuario de
 * datáfono que lo lanzó. El comensal (sin sesión de staff) no queda anotado.
 *
 * Qué mira ese campo (y por qué anotar al datáfono no le quita nada a los
 * meseros, que es lo que importa):
 *   - Propinas y cierre del turno del mesero (vista «Yo», cierre de turno,
 *     reporte del turno personal, devolución de propinas): SÓLO los pagos con
 *     su propio id. El datáfono nunca es "el mesero" de nadie.
 *   - Comisión del mesero (`resolveOrderWaiter`): sólo cuenta a quien cobró
 *     si ES mesero; si no, el mesero que tiene la mesa asignada.
 *   - Caja (`buildCashSnapshot`): el efectivo que no cobró un mesero va a la
 *     caja del local — como el del administrador.
 *   - Reporte del turno del local y desempeño del equipo: el datáfono sale
 *     con su nombre en vez de "cobro directo del cliente" (eso es la
 *     auditoría que se busca).
 *   - "Pagó desde el celular" (`wasPaidFromPhone`): sólo mira pagos en línea
 *     sin cobrador; los del datáfono no son en línea.
 */
const ATTRIBUTED_COLLECTOR_ROLES: readonly string[] = [
  "mesero",
  "operator",
  "platform_admin",
  "terminal",
];

export function collectorUserIdFor(
  user: { id: string; role?: string | null } | null | undefined,
): string | null {
  return user?.role && ATTRIBUTED_COLLECTOR_ROLES.includes(user.role) ? user.id : null;
}
