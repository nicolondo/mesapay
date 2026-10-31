// Solicitudes de factura (InvoiceRequest) frente a la factura electrónica
// ACEPTADA de su cuenta. Reglas puras, sin DB, para poder probarlas solas:
//
//   · Cuáles quedan CUBIERTAS por la factura y pasan solas a `generated`
//     cuando la DIAN la acepta (los dos rieles de la aceptación: la
//     respuesta síncrona de `emitDianInvoice` y la consulta diferida de
//     `dian/documents/[id]/status`).
//   · Cuáles LLEGARON DESPUÉS: la factura ya había salido a consumidor
//     final y el cliente dejó sus datos más tarde. Esa cuenta no se puede
//     volver a facturar (`SimpleInvoice.orderId @unique`); se anula con nota
//     crédito. Quedan pendientes y la pantalla de Facturas las muestra.
//   · La condición de la limpieza histórica (migración
//     20261031160000_invoice_requests_covered_by_einvoice), en TS, para
//     probarla igual que el SQL que la aplica una sola vez.
//
// El instante que separa "antes" de "después" es el de la EMISIÓN —cuando
// `emitDianInvoice` leyó la solicitud más reciente de la orden para decidir
// el adquiriente—, no el de la respuesta de la DIAN. En producción
// (SendBillSync) son el mismo momento con segundos de diferencia; cuando la
// aceptación llega por la consulta diferida, lo que el cliente dejó entre el
// envío y esa consulta NO entró en la factura, aunque sea "antes de la
// aceptación". Por eso la referencia es la emisión.
import { isModuleEnabled } from "@/lib/modules";

/**
 * NIT del adquiriente "Consumidor final" (anexo técnico 6.2.1). Es el
 * `companyId` de `CONSUMIDOR_FINAL` en `dian/emit.ts`; se repite acá para
 * que este módulo no arrastre la DB (un test verifica que coinciden).
 */
export const CONSUMIDOR_FINAL_ID = "222222222222";

/**
 * Identificación del adquiriente (cac:AccountingCustomerParty → CompanyID)
 * del XML firmado de la factura. Es la fuente de verdad de a quién salió:
 * la tirilla (`SimpleInvoice.snapshot.customer`) se congela al cobrar y la
 * emisión puede haber tomado una solicitud posterior. null ⇒ el XML no
 * trae el bloque (no se afirma nada).
 */
export function invoiceXmlBuyerId(xml: string): string | null {
  const block =
    /<(?:\w+:)?AccountingCustomerParty\b[^>]*>([\s\S]*?)<\/(?:\w+:)?AccountingCustomerParty>/.exec(xml)?.[1];
  if (!block) return null;
  const id = /<(?:\w+:)?CompanyID\b[^>]*>([^<]*)<\/(?:\w+:)?CompanyID>/.exec(block)?.[1]?.trim();
  return id || null;
}

/**
 * ¿Esta solicitud llegó DESPUÉS de que la factura salió a consumidor final?
 * Hacen falta las dos cosas: que el adquiriente del XML sea el consumidor
 * final y que la solicitud sea posterior a la emisión. Sin los datos de la
 * factura (XML ilegible) no se marca nada: un falso "llegó después" manda al
 * operador a anular una factura que estaba bien.
 */
export function isLateInvoiceRequest(args: {
  requestCreatedAt: Date;
  /** IssueDate + IssueTime del XML aceptado. */
  issuedAt: Date | null;
  /** `invoiceXmlBuyerId` del XML aceptado. */
  buyerId: string | null;
}): boolean {
  if (!args.issuedAt || !args.buyerId) return false;
  if (args.buyerId !== CONSUMIDOR_FINAL_ID) return false;
  return args.requestCreatedAt.getTime() > args.issuedAt.getTime();
}

/**
 * Hasta qué `createdAt` las solicitudes pendientes de la orden quedaron
 * cubiertas por la factura recién aceptada. null ⇒ no se cierra ninguna.
 *
 *   · `emit` (respuesta síncrona): se sabe EXACTAMENTE qué solicitud usó la
 *     emisión —la más reciente de la orden al leerla—, así que el corte es
 *     su `createdAt`: ella y las anteriores entraron; lo posterior no. Sin
 *     solicitud la factura salió a consumidor final y no se cierra nada:
 *     cualquier pendiente que aparezca después llegó tarde.
 *   · `status` (consulta diferida): no se sabe qué solicitud se leyó; el
 *     corte es el instante de emisión que declara el XML (IssueDate +
 *     IssueTime), que es cuando se leyó.
 */
export function acceptedInvoiceClosureCutoff(
  source:
    | { rail: "emit"; usedRequestCreatedAt: Date | null | undefined }
    | { rail: "status"; issuedAt: Date | null | undefined },
): Date | null {
  return source.rail === "emit"
    ? (source.usedRequestCreatedAt ?? null)
    : (source.issuedAt ?? null);
}

/**
 * Filtro del cierre automático (lo usa el updateMany). Sólo pendientes —una
 * rechazada por el operador o ya generada no se toca— y sólo hasta el corte:
 * lo que llegó después queda pendiente para que se vea.
 */
export function coveredRequestsWhere(orderId: string, cutoff: Date) {
  return {
    orderId,
    status: "pending" as const,
    createdAt: { lte: cutoff },
  };
}

/** La misma condición que `coveredRequestsWhere`, sobre una fila en memoria. */
export function closesOnAcceptance(
  request: { status: string; createdAt: Date },
  cutoff: Date | null,
): boolean {
  return (
    cutoff != null &&
    request.status === "pending" &&
    request.createdAt.getTime() <= cutoff.getTime()
  );
}

// ── Limpieza histórica (migración) ─────────────────────────────────────────

/**
 * La aceptación de las facturas ya emitidas NO quedó guardada: el
 * `DianDocument` no tiene fecha de aceptación, `updatedAt` se mueve con cada
 * envío o reenvío del correo (y una solicitud tardía dispara justamente un
 * envío), `emailedAt` lo pisa cada reenvío y la fecha de emisión vive dentro
 * del XML zipeado, que SQL no puede leer.
 *
 * La mejor aproximación SEGURA es una cota inferior: la emisión no puede ser
 * anterior a que existieran la tirilla y el documento DIAN. En la emisión
 * automática normal (al cobrar) los dos nacen segundos antes de la
 * aceptación. Una solicitud anterior o igual a esa cota seguro estaba al
 * emitir; una posterior puede haber llegado tarde y se deja pendiente, para
 * que no se esconda un caso "llegó después" (la pantalla lo decide leyendo
 * el XML).
 */
export function historicalAcceptanceLowerBound(args: {
  documentCreatedAt: Date;
  invoiceCreatedAt: Date;
}): Date {
  return new Date(
    Math.max(args.documentCreatedAt.getTime(), args.invoiceCreatedAt.getTime()),
  );
}

/**
 * Condición EXACTA del UPDATE de la migración, fila por fila:
 *
 *   1. la solicitud está `pending`;
 *   2. el comercio tiene el módulo `einvoicing` (Restaurant.enabledModules
 *      es un arreglo JSON que contiene "einvoicing");
 *   3. la orden de la solicitud tiene tirilla con documento DIAN de tipo
 *      `invoice` en estado `accepted`;
 *   4. la solicitud es anterior o igual a la cota de aceptación
 *      (`historicalAcceptanceLowerBound`).
 */
export function historicalCleanupCloses(row: {
  requestStatus: string;
  requestCreatedAt: Date;
  enabledModules: unknown;
  document: { kind: string; state: string; createdAt: Date } | null;
  invoiceCreatedAt: Date | null;
}): boolean {
  if (row.requestStatus !== "pending") return false;
  if (!isModuleEnabled(row.enabledModules, "einvoicing")) return false;
  if (!row.document || !row.invoiceCreatedAt) return false;
  if (row.document.kind !== "invoice" || row.document.state !== "accepted") return false;
  const bound = historicalAcceptanceLowerBound({
    documentCreatedAt: row.document.createdAt,
    invoiceCreatedAt: row.invoiceCreatedAt,
  });
  return row.requestCreatedAt.getTime() <= bound.getTime();
}
