import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { auth } from "@/auth";
import { PayClient } from "./PayClient";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { isModuleEnabled } from "@/lib/modules";
import { getAssignedDevice } from "@/lib/meseroDevice";
import type { InvoiceIntent } from "@/components/invoice/types";
import { asSalesTaxKind } from "@/lib/checkoutTax";
import { parseTipPct } from "@/lib/tips";
import { loadCustomerCreditSummary } from "@/lib/customerCredit";
import { normalizeCustomerDocument } from "@/lib/customerDocument";
import type { PayCustomer } from "./PayClient";
import { canCompOrders } from "@/lib/staffPolicies";

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
  tip,
}: {
  slug: string;
  orderId: string;
  op?: string;
  declined?: string;
  tip?: string;
}) {
  // Operator-mode pay flow: el staff está cobrando la cuenta en
  // nombre de un comensal que no tiene celular o pidió verbalmente.
  // Sólo honramos op === "1" si la sesión es staff real — nunca confiar
  // en la URL sola. Incluimos `mesero` porque desde su PWA tiene
  // un botón "Cobrar la cuenta" que apunta acá; sin este rol caía
  // al flow del cliente con "Partes iguales / Lo mío".
  const session = op === "1" ? await auth() : null;
  const operatorMode =
    !!session?.user &&
    (session.user.role === "operator" ||
      session.user.role === "platform_admin" ||
      session.user.role === "mesero");
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return notFound();

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
      items: { where: { cancelledAt: null }, orderBy: { id: "asc" } },
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
  const invoiceIntent: InvoiceIntent | null = invoiceRequest
    ? { kind: "formal", summary: invoiceRequest }
    : order.simpleInvoiceEmail
      ? { kind: "simple", email: order.simpleInvoiceEmail }
      : null;

  const approved = order.payments.filter((p) => p.status === "approved");
  const paidCents = approved.reduce((s, p) => s + p.amountCents, 0);
  const paidTipCents = approved.reduce((s, p) => s + p.tipCents, 0);
  const kushkiReady =
    !!tenant.kushkiMerchantId && tenant.kushkiOnboardingStatus === "active";

  // In operator mode, look up which Smart POS this user is logged into
  // (set by the operator in /operator/settings/datafonos). When set,
  // PayClient skips the Salón bounce and pushes the datáfono charge
  // straight to the assigned device.
  const assignedDevice =
    operatorMode && session?.user?.id
      ? await getAssignedDevice(session.user.id, tenant.id)
      : null;

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
  // está bloqueado por el guard de /operator/*. Operator y platform_admin
  // vuelven a las pantallas del backoffice.
  const isMeseroSession = session?.user?.role === "mesero";
  const staffHomeHref = isMeseroSession ? "/mesero/mesas" : "/operator/tables";
  const staffServeHref = isMeseroSession ? "/mesero/salon" : "/operator/serve";
  // Tras un cobro exitoso, la pantalla de "listo" (con la factura) debe
  // quedar DENTRO del scope del que cobra: el mesero en su PWA (con bottom
  // nav), el operador/admin en la página done del comensal en modo op.
  const doneHref = isMeseroSession
    ? `/mesero/cobrar/${orderId}/done`
    : `/t/${slug}/pay/${orderId}/done?op=1`;

  // Clientes de facturación (sólo staff): el paso "Cliente" existe si el
  // comercio tiene alguno; "Cobrar a crédito", si alguno tiene crédito. El
  // cliente de la factura nominativa (si coincide) llega preseleccionado.
  const [customerCount, creditCount, linkedCustomer] = operatorMode
    ? await Promise.all([
        db.billingCustomer.count({ where: { restaurantId: tenant.id } }),
        db.billingCustomer.count({ where: { restaurantId: tenant.id, creditEnabled: true } }),
        linkedCustomerFor(tenant.id, invoiceRequest),
      ])
    : [0, 0, null];

  // Una factura manual no tiene mesa que nombrar en el encabezado del cobro.
  const tMenu = await getTranslations("menu");

  return (
    <PayClient
      operatorMode={operatorMode}
      staffHomeHref={staffHomeHref}
      staffServeHref={staffServeHref}
      doneHref={doneHref}
      // Gastos de representación (cortesía $0): solo cuando cobra staff, el
      // comercio lo tiene habilitado y el rol está entre los que pueden NO
      // COBRAR (Restaurant.compAllowedRoles — la misma lista que gobierna el
      // "No cobrar" de un plato). El endpoint lo bloquea igual; acá es para
      // que el mesero no vea un botón que le va a rebotar. Etiqueta
      // configurable (null ⇒ default).
      compEnabled={
        operatorMode &&
        tenant.compEnabled &&
        canCompOrders(session?.user?.role, tenant.compAllowedRoles)
      }
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
      subtotalCents={Math.max(0, order.subtotalCents - order.discountCents)}
      grossSubtotalCents={order.subtotalCents}
      discountCents={order.discountCents}
      discountPct={order.discountPct}
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
      vouchersEnabled={isModuleEnabled(tenant.enabledModules, "vouchers")}
      customerStepEnabled={customerCount > 0}
      creditEnabled={creditCount > 0}
      linkedCustomer={linkedCustomer}
      pseBanks={pseBanks}
      assignedDeviceId={assignedDevice?.kushkiDeviceId ?? null}
      assignedDeviceLabel={assignedDevice?.label ?? null}
      // Banner que se muestra al volver de un cobro rechazado por
      // datáfono o PSE — sirve para que el diner entienda por qué
      // volvió al checkout y elija otro método.
      declinedFlag={declined === "1"}
      // La factura se pide ACÁ, durante el cobro. `invoiceIntent` es lo que
      // ya haya pedido en esta cuenta (para mostrar el resumen en vez del
      // formulario) y `invoicePrefillEmail`, el correo del último cobro con
      // tarjeta para no volver a pedírselo.
      invoiceIntent={invoiceIntent}
      invoicePrefillEmail={order.customerEmail}
      // Impuesto de ventas del comercio, sólo para el renglón informativo
      // "Incluye impoconsumo 8%": los platos ya lo traen dentro del precio,
      // así que no toca ningún monto a cobrar.
      salesTax={{
        kind: asSalesTaxKind(tenant.salesTaxKind),
        pct: tenant.salesTaxPct,
      }}
      initialTipPct={parseTipPct(tip)}
    />
  );
}
