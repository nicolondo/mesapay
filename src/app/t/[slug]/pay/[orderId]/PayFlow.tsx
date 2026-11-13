import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { staffForRestaurant } from "@/lib/staffAccess";
import {
  CHECKOUT_STAFF_ROLES,
  staffCheckoutCapabilities,
  staffCheckoutRoutes,
  staffCheckoutView,
} from "@/lib/payments/staffCheckout";
import { PayClient } from "./PayClient";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { isModuleEnabled } from "@/lib/modules";
import type { InvoiceIntent } from "@/components/invoice/types";
import {
  isSimpleInvoiceRequested,
  simpleInvoiceEmailFrom,
} from "@/lib/simpleInvoiceRequest";
import { asSalesTaxKind } from "@/lib/checkoutTax";
import { parseTipPct } from "@/lib/tips";
import { loadCustomerCreditSummary } from "@/lib/customerCredit";
import { normalizeCustomerDocument } from "@/lib/customerDocument";
import type { PayCustomer } from "./PayClient";
import { canCompOrders } from "@/lib/staffPolicies";
import { cancellationRequiresAdmin } from "@/lib/orders/cancellationPolicy";
import { withReplaceable } from "@/lib/payments/pendingRequests";
import { kushkiTerminalAvailability } from "@/lib/payments/terminalAvailability";
import { canResolveTerminalCharge } from "@/lib/payments/terminalResolve";
import { onlinePaymentsReady } from "@/lib/payments/onlinePayments";
import { loadOrderInvoiceView } from "@/lib/orders/invoicedOrder";

/**
 * Cliente de facturación ligado a la cuenta por la solicitud de factura
 * nominativa: el mismo tipo y número de documento (normalizado como lo
 * guarda `billingCustomerSchema`). Sólo en modo staff; null si no hay
 * solicitud o no coincide con ningún cliente del comercio.
 */
async function linkedCustomerFor(
  restaurantId: string,
  request: { docType: "CC" | "CE" | "NIT" | "PA"; docNumber: string } | null,
): Promise<PayCustomer | null> {
  if (!request) return null;
  // Misma normalización que el alta del cliente y la solicitud de factura
  // (una sola fuente de verdad): número sin DV. Una solicitud vieja que
  // todavía traiga "901944469-1" también liga; un DV que no corresponde no.
  const document = normalizeCustomerDocument(request.docType, request.docNumber);
  if (!document.ok) return null;
  const customer = await db.billingCustomer.findFirst({
    where: { restaurantId, docType: request.docType, docNumber: document.docNumber },
    select: {
      id: true,
      customerName: true,
      docType: true,
      docNumber: true,
      verificationDigit: true,
      creditEnabled: true,
      creditLimitCents: true,
      discountEnabled: true,
      discountBps: true,
    },
  });
  if (!customer) return null;
  const credit = customer.creditEnabled
    ? await loadCustomerCreditSummary(restaurantId, customer.id)
    : null;
  return { ...customer, debtCents: credit?.debtCents ?? 0 };
}

/**
 * Núcleo del flujo de cobro, compartido por dos puntos de entrada:
 *
 *   1. /t/[slug]/pay/[orderId]        — el comensal paga desde su QR.
 *   2. /mesero/cobrar/[orderId]       — el mesero cobra desde su PWA,
 *      dentro del scope /mesero/ para no rebotar a Safari (igual que
 *      /mesero/pedir/[tableId] hace con la carta).
 *
 * `op` lo pasa el caller (el comensal nunca; el mesero siempre "1").
 * Sólo se honra si la sesión es staff real — la URL sola no basta.
 *
 * `tip` es el `?tip=<pct>` con el que el estado del pedido manda al comensal
 * a pagar con la propina que previsualizó; se valida acá (entero 0..30) y
 * cualquier otra cosa cae al default.
 */
export async function PayFlow({
  slug,
  orderId,
  op,
  declined,
  declineCode,
  tip,
}: {
  slug: string;
  orderId: string;
  op?: string;
  declined?: string;
  /** Código del motivo del rechazo con tarjeta (viene de la URL; se valida al traducir). */
  declineCode?: string;
  tip?: string;
}) {
  // Operator-mode pay flow: el staff está cobrando la cuenta en
  // nombre de un comensal que no tiene celular o pidió verbalmente.
  // Sólo honramos op === "1" si la sesión es staff real — nunca confiar
  // en la URL sola. Incluimos `mesero` porque desde su PWA tiene
  // un botón "Cobrar la cuenta" que apunta acá; sin este rol caía
  // al flow del cliente con "Partes iguales / Lo mío". Y el datáfono
  // (`terminal`), que cobra desde «Mesas en vivo» (/terminal/cobrar).
  // Qué ve y adónde vuelve cada rol: src/lib/payments/staffCheckout.ts.
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return notFound();
  const session = op === "1"
    ? await staffForRestaurant(tenant.id, [...CHECKOUT_STAFF_ROLES])
    : null;
  const operatorMode = session !== null;
  const staffRole = session?.user?.role;
  const staffView = staffCheckoutView(staffRole);
  const capabilities = staffCheckoutCapabilities(staffRole);

  // Heal stale subtotals before showing payment options — otherwise the
  // diner could end up paying for items that were cancelled in the kitchen.
  await syncOrderSubtotalFromLiveItems(orderId);

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      table: true,
      payments: true,
      // El resumen del cobro (y el OrderItem.guestName aggregator)
      // solo deben ver items vivos — un plato cancelado no aporta a
      // lo que el cliente paga.
      items: {
        where: {
          cancelledAt: null,
          OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
        },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  // Factura pedida en un intento anterior de esta misma cuenta (el comensal
  // recargó, o volvió del banco). Sin esto el checkout le volvería a
  // preguntar por algo que ya contestó.
  const invoiceRequest = await db.invoiceRequest.findFirst({
    where: { orderId: order.id, status: "pending" },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      customerName: true,
      docType: true,
      docNumber: true,
      email: true,
    },
  });
  // La genérica pudo pedirse SIN correo (`simpleInvoiceEmail === ""`): igual
  // cuenta como pedida y se muestra el resumen, no la pregunta.
  const invoiceIntent: InvoiceIntent | null = invoiceRequest
    ? { kind: "formal", summary: invoiceRequest }
    : isSimpleInvoiceRequested(order.simpleInvoiceEmail)
      ? { kind: "simple", email: simpleInvoiceEmailFrom(order.simpleInvoiceEmail) }
      : null;

  const approved = order.payments.filter((p) => p.status === "approved");
  // Pagos pendientes (sólo staff): la solicitud (datáfono del comercio,
  // efectivo, datáfono Kushki sin enviar) sale arriba del cobro con
  // "Confirmar pago recibido" / "Cancelar solicitud"; un pago en línea en
  // curso, sin acción.
  // `replaceable`: el datáfono Kushki pedido que nadie envió al equipo es una
  // solicitud (se cancela o se reemplaza); ya enviado, es un cobro en curso.
  const pendingPayments = operatorMode
    ? (await withReplaceable(db, order.payments.filter((p) => p.status === "pending"))).map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        cashTenderCents: p.cashTenderCents,
        createdAt: p.createdAt.toISOString(),
        replaceable: p.replaceable,
        reconciliationRequired: p.reconciliationRequired,
        pushedAt: p.pushedAt?.toISOString() ?? null,
        terminalAttempt: p.terminalAttempt,
      }))
    : [];
  const paidCents = approved.reduce((s, p) => s + p.amountCents, 0);
  const paidTipCents = approved.reduce((s, p) => s + p.tipCents, 0);
  const kushkiReady = onlinePaymentsReady(tenant);
  // Factura manual pagada por un LINK: nadie escanea una mesa `manual`, así
  // que si quien llega no es staff entró por /r/[slug]/cuenta/[token] (la
  // cookie de invitado es sólo de esta orden). Es un pagador remoto: paga
  // en línea el total, sin dividir la cuenta, sin efectivo ni datáfono, y
  // sin propina sugerida (no hubo servicio en mesa; puede agregarla).
  const manualInvoice = order.table.kind === "manual";
  const payLinkMode = manualInvoice && !operatorMode;
  // El botón del datáfono Kushki sólo sale si el comercio puede empujar el
  // cobro al equipo (mismas reglas que terminal/charge y terminal-request).
  const terminalAvailability = await kushkiTerminalAvailability(tenant);
  const kushkiTerminalAvailable = terminalAvailability.available;
  // Los datáfonos son del comercio, no de un mesero: el staff elige al
  // cobrar a cuál mandar el cobro (con uno solo, va directo a ése). El
  // comensal no elige nada: su solicitud queda en Salón.
  const terminalDevices =
    operatorMode && terminalAvailability.available ? terminalAvailability.devices : [];

  // NO pre-fetcheamos los bancos PSE acá. Esa llamada a Kushki es lenta
  // (varios segundos) y bloqueaba el render de "Pagar" en CADA carga, para
  // todos — aunque casi nadie use PSE. El PseSheet del cliente pide la lista
  // solo cuando el diner abre PSE (GET /pay/pse-banks, ahora con caché),
  // así "Pagar" abre al instante.
  const enabledMethods = resolveEnabledPaymentMethods(
    tenant.enabledPaymentMethods,
  );
  const pseBanks: Array<{ code: string; name: string }> = [];

  // Mesero usa su propia PWA con bottom nav (Salón/Cobros/Mesas) y
  // está bloqueado por el guard de /operator/*; el datáfono vuelve a
  // «Mesas en vivo». Operator y platform_admin vuelven a las pantallas del
  // backoffice. Tras un cobro exitoso, la pantalla de "listo" (con la
  // factura) queda DENTRO del scope del que cobra.
  const {
    homeHref: staffHomeHref,
    serveHref: staffServeHref,
    doneHref,
  } = staffCheckoutRoutes(staffRole, { slug, orderId });

  // Clientes de facturación (sólo staff): el paso "Cliente" existe si el
  // comercio tiene alguno; "Cobrar a crédito", si alguno tiene crédito. El
  // cliente de la factura nominativa (si coincide) llega preseleccionado.
  // El datáfono no asocia clientes ni cobra a crédito: ni se consulta.
  const [customerCount, creditCount, linkedCustomer] = operatorMode && capabilities.customerStep
    ? await Promise.all([
        db.billingCustomer.count({ where: { restaurantId: tenant.id } }),
        db.billingCustomer.count({ where: { restaurantId: tenant.id, creditEnabled: true } }),
        linkedCustomerFor(tenant.id, invoiceRequest),
      ])
    : [0, 0, null];

  const compAdminRequired = operatorMode && tenant.compEnabled &&
    canCompOrders(session?.user?.role, tenant.compAllowedRoles) &&
    order.items.some((item) => cancellationRequiresAdmin(session?.user?.role, item, order.table.kind));

  // Una factura manual no tiene mesa que nombrar en el encabezado del cobro.
  const tMenu = await getTranslations("menu");

  // Factura emitida ANTES de cobrar ("Imprimir factura" desde la mesa): el
  // cobro la muestra en vez de volver a preguntar por la factura, y se
  // cobra con cualquier medio sin emitir otra. Sólo cuenta si la cuenta no
  // está pagada (pagada, la factura es la de siempre).
  const preInvoice =
    order.status === "paid" ? null : await loadOrderInvoiceView(order.id);

  return (
    <PayClient
      operatorMode={operatorMode}
      staffHomeHref={staffHomeHref}
      staffServeHref={staffServeHref}
      doneHref={doneHref}
      // Factura antes de cobrar e impresión: según el rol (el datáfono no
      // emite la factura antes de cobrar; el mesero y el datáfono abren la
      // vista de impresión en la misma pestaña; sólo el panel configura
      // impresoras).
      preInvoiceEnabled={capabilities.preInvoice}
      printSameTab={staffView !== "admin"}
      canConfigurePrinters={capabilities.configurePrinters}
      terminalMode={staffView === "terminal"}
      // Gastos de representación (cortesía $0): solo cuando cobra staff, el
      // comercio lo tiene habilitado y el rol está entre los que pueden NO
      // COBRAR (Restaurant.compAllowedRoles — la misma lista que gobierna el
      // "No cobrar" de un plato). El endpoint lo bloquea igual; acá es para
      // que el mesero no vea un botón que le va a rebotar. Etiqueta
      // configurable (null ⇒ default).
      compEnabled={
        operatorMode &&
        tenant.compEnabled &&
        canCompOrders(session?.user?.role, tenant.compAllowedRoles) &&
        !compAdminRequired
      }
      compAdminRequired={compAdminRequired}
      compLabel={tenant.compLabel}
      tenantSlug={slug}
      tenantName={tenant.name}
      orderId={order.id}
      shortCode={order.shortCode}
      tableId={order.table.id}
      locationLabel={
        order.table.kind === "manual"
          ? tMenu("manualInvoice")
          : tenant.serviceMode === "counter"
            ? "Mostrador"
            : `Mesa ${order.table.number}`
      }
      // Lo cobrable va NETO del descuento del comensal identificado: todo
      // el cálculo de la pantalla (partes iguales, lo mío, saldo) cuelga de
      // este número, y el tope del servidor rechazaría un cobro bruto.
      subtotalCents={Math.max(0, order.subtotalCents + order.taxCents - order.discountCents)}
      grossSubtotalCents={order.subtotalCents}
      discountCents={order.discountCents}
      discountPct={order.discountPct}
      approvedPayments={operatorMode ? approved.map(({ id, method, amountCents, tipCents }) => ({ id, method, amountCents, tipCents })) : []}
      paidCents={paidCents}
      paidTipCents={paidTipCents}
      alreadyPaid={order.status === "paid"}
      items={order.items.map((i) => ({
        id: i.id,
        name: i.nameSnapshot,
        qty: i.qty,
        priceCents: i.priceCentsSnapshot,
        guestName: i.guestName,
      }))}
      serviceMode={tenant.serviceMode}
      kushkiReady={kushkiReady}
      kushkiPublicKey={tenant.kushkiPublicKey}
      kushkiMode={await getRestaurantKushkiMode(tenant)}
      currency={await getCurrencyForCountry(tenant.country)}
      card3ds={tenant.kushkiCard3ds}
      enabledMethods={enabledMethods}
      // Bonos empresariales: el campo "¿Tenés un bono?" sólo existe con el
      // módulo activo (el server además responde module_disabled sin él).
      vouchersEnabled={capabilities.vouchers && isModuleEnabled(tenant.enabledModules, "vouchers")}
      customerStepEnabled={capabilities.customerStep && customerCount > 0}
      creditEnabled={capabilities.credit && creditCount > 0}
      linkedCustomer={linkedCustomer}
      pseBanks={pseBanks}
      terminalDevices={terminalDevices}
      // Banner que se muestra al volver de un cobro rechazado por
      // datáfono o PSE — sirve para que el diner entienda por qué
      // volvió al checkout y elija otro método.
      declinedFlag={declined === "1" || declined === "canceled"}
      // Volvió porque se canceló en el datáfono: no se cobró, aviso propio.
      declinedReason={declined === "canceled" ? "terminal_canceled" : null}
      // Motivo del rechazo con tarjeta (p. ej. al volver del 3DS).
      declineCode={declineCode ?? null}
      // La factura se pide ACÁ, durante el cobro. `invoiceIntent` es lo que
      // ya haya pedido en esta cuenta (para mostrar el resumen en vez del
      // formulario) y `invoicePrefillEmail`, el correo del último cobro con
      // tarjeta para no volver a pedírselo.
      invoiceIntent={invoiceIntent}
      invoicePrefillEmail={order.customerEmail}
      preInvoice={preInvoice}
      // Anular con nota crédito: los administradores, no el mesero ni el
      // datáfono.
      canAnnulInvoice={operatorMode && capabilities.annulInvoice}
      // Impuesto de ventas del comercio, sólo para el renglón informativo
      // "Incluye impoconsumo 8%": los platos ya lo traen dentro del precio,
      // así que no toca ningún monto a cobrar.
      salesTax={{
        kind: asSalesTaxKind(tenant.salesTaxKind),
        pct: tenant.salesTaxPct,
      }}
      initialTipPct={payLinkMode ? 0 : parseTipPct(tip)}
      payLinkMode={payLinkMode}
      pendingPayments={pendingPayments}
      kushkiTerminalAvailable={kushkiTerminalAvailable}
      // "Resolver cobro" de un datáfono Kushki sin respuesta: sólo el
      // administrador, nunca el mesero (el servidor lo exige igual).
      canResolveTerminal={operatorMode && canResolveTerminalCharge(session?.user?.role)}
      tableNumber={order.table.number}
    />
  );
}
