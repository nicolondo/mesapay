/**
 * Carga los pagos APROBADOS de una orden con el detalle que necesita la
 * sección «Pagos» de la factura (`buildPaymentsSection`): el charge
 * aprobado de Kushki (franquicia, últimos 4, código de aprobación), el
 * efectivo recibido para el vuelto, la referencia Bre-B y el cliente del
 * crédito.
 *
 * `approved` nada más y en orden cronológico: los rechazados y devueltos
 * no son pagos de esta cuenta y NUNCA salen en el papel. Es el único
 * lugar que consulta; todos los que muestran la sección (tirilla, página,
 * correo, datáfono) parten de acá para decir lo mismo.
 */

import { db } from "@/lib/db";
import {
  extractKushkiCardInfo,
  extractKushkiReference,
} from "@/lib/payments/kushki/chargeDetails";
import type { InvoicePaymentDetail } from "./invoiceDoc";

export async function loadInvoicePaymentDetails(
  orderId: string,
): Promise<InvoicePaymentDetail[]> {
  const payments = await db.payment.findMany({
    where: { orderId, status: "approved" },
    orderBy: { createdAt: "asc" },
    select: {
      method: true,
      amountCents: true,
      tipCents: true,
      cashTenderCents: true,
      billingCustomer: { select: { customerName: true } },
      // El charge APROBADO más reciente del pago: un pago tiene a lo sumo
      // uno (los declinados previos no pisan sus datos).
      kushkiTransactions: {
        where: { kind: "charge", status: "approved" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          cardBrand: true,
          cardLast4: true,
          approvalCode: true,
          kushkiTxId: true,
          raw: true,
        },
      },
      breBCharge: { select: { transactionReference: true } },
    },
  });
  return payments.map((p) => {
    // `?? []`: los mocks de los tests (y un cliente Prisma recortado)
    // pueden no traer las relaciones; un pago sin ellas imprime igual.
    const tx = (p.kushkiTransactions ?? [])[0] ?? null;
    // Columnas tipadas primero; si están en NULL (los cobros del DATÁFONO
    // guardados antes de extraerlas: `authCode`/`cardData` en el raw), el
    // detalle se saca del raw acá — así las facturas YA emitidas también
    // imprimen franquicia, últimos 4 y aprobación al reimprimir.
    const fromRaw = tx && (!tx.cardBrand || !tx.cardLast4 || !tx.approvalCode)
      ? extractKushkiCardInfo(tx.raw)
      : null;
    return {
      method: p.method,
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      cashTenderCents: p.cashTenderCents,
      billingCustomerName: p.billingCustomer?.customerName ?? null,
      cardBrand: tx?.cardBrand ?? fromRaw?.cardBrand ?? null,
      cardLast4: tx?.cardLast4 ?? fromRaw?.cardLast4 ?? null,
      approvalCode: tx?.approvalCode ?? fromRaw?.approvalCode ?? null,
      // La referencia de Kushki, para cruzar con el extracto: la del raw
      // (el terminal la manda como `transactionReference`) o, si no, el id
      // con el que quedó asentada la transacción.
      kushkiReference: tx ? extractKushkiReference(tx.raw) ?? tx.kushkiTxId ?? null : null,
      breBReference: p.breBCharge?.transactionReference ?? null,
    };
  });
}
