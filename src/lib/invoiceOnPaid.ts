import { after } from "next/server";
import { db } from "@/lib/db";
import { resolveEmisor } from "@/lib/dian/config";
import { ensureDianDocument, recordNumberingExhausted } from "@/lib/dian/emit";
import { emitDianInvoice, type EmitDianInvoiceResult } from "@/lib/dian/emitInvoice";
import { isModuleEnabled } from "@/lib/modules";
import { issueSimpleInvoice, sendSimpleInvoiceEmail } from "@/lib/simpleInvoice";

/**
 * Facturación al cerrar la cuenta.
 *
 * Esta función es el otro extremo de TODOS los rieles por los que una
 * orden pasa a pagada (efectivo, datáfono, tarjeta, PSE, webhook, cortesía,
 * abono de reserva, conciliación). Lo que hace depende del comercio:
 *
 *   · Con facturación electrónica activa (módulo `einvoicing`): TODA venta
 *     genera su factura — la tirilla (SimpleInvoice, que consume el
 *     consecutivo) y el DianDocument en `to_send`, más un intento de
 *     emisión inmediato en segundo plano. Nominativa si el comensal pidió
 *     factura en el checkout (`InvoiceRequest`), a consumidor final si no
 *     (y entonces sin correo, salvo que haya dejado uno suelto en
 *     `Order.simpleInvoiceEmail`). El barrido `cron/dian-emit` es la red:
 *     retoma lo que el intento inmediato no logró.
 *
 *   · Sin facturación electrónica: exactamente como siempre — la tirilla
 *     sale sólo si alguien la pidió, y a la DIAN no va nada.
 *
 * Contrato:
 *  - NUNCA lanza. Un fallo de correo/emisión no puede tumbar un cobro que ya
 *    quedó registrado — se traga y se loguea.
 *  - Idempotente: si la orden ya tiene `SimpleInvoice` no re-numera ni
 *    re-envía el correo; si ya tiene `DianDocument` no lo re-crea ni lo
 *    re-emite desde acá (eso es del barrido, con su backoff). Dos rieles
 *    simultáneos terminan con una sola factura: `SimpleInvoice.orderId` y
 *    `DianDocument.simpleInvoiceId` son únicos.
 *  - Debe correr FUERA de cualquier transacción: hace sus propios inserts
 *    y dispara correo/emisión.
 */
export type IssueInvoiceOnPaidResult =
  | {
      status: "skipped";
      reason: "not_found" | "not_paid" | "not_billable" | "not_requested";
    }
  /** Rango de la resolución agotado: sin número válido no hay factura. */
  | { status: "blocked"; reason: "numbering_exhausted" }
  | {
      status: "issued";
      invoiceId: string;
      alreadyIssued: boolean;
      /** Resultado del intento inmediato cuando se pidió `emit: "inline"`. */
      emit: EmitDianInvoiceResult | null;
    }
  /** Reventó algo: quedó logueado, la orden sigue pagada. */
  | { status: "failed" };

export type IssueInvoiceOnPaidOptions = {
  tenantId: string;
  orderId: string;
  /**
   * Cuándo intentar la emisión a la DIAN del documento recién creado:
   *   · "after" (default): después de que salga la respuesta HTTP del
   *     cobro (`after()` de Next), sin retrasarla; fuera de un request se
   *     dispara al aire. Tragando errores: es best-effort, el barrido
   *     cubre lo que falle.
   *   · "inline": se espera y se devuelve el resultado — es lo que usa el
   *     barrido, que quiere contar y no quiere paralelismo contra la DIAN.
   *   · "none": sólo se crea el documento (tests, o quien vaya a emitir).
   */
  emit?: "after" | "inline" | "none";
};

/**
 * ¿Queda número en la resolución para facturar la próxima venta?
 * `invoiceNextNumber` es el que va a recibir la próxima tirilla; si ya
 * pasó el tope, no hay factura posible hasta que llegue una resolución
 * nueva. Sin `resolutionTo` cargado no se puede saber y no se frena (el
 * emit lo bloquea después, sin quemar nada).
 */
export function numberingExhausted(
  emisor: { resolutionTo: number | null; invoiceNextNumber: number } | null,
): boolean {
  if (!emisor || emisor.resolutionTo == null) return false;
  return emisor.invoiceNextNumber > emisor.resolutionTo;
}

/**
 * ¿La orden es una VENTA facturable? Una cortesía (comp) cierra la cuenta
 * en $0 con los ítems cancelados: no hay venta, no hay factura. Lo mismo
 * una cuenta que quedó en $0 por cualquier otro camino (no hay líneas con
 * valor que declarar).
 */
export function isBillableOrder(order: {
  compedAt: Date | null;
  subtotalCents: number;
}): boolean {
  return order.compedAt == null && order.subtotalCents > 0;
}

/** Corre la tarea después de la respuesta si hay request; si no, al aire. */
function scheduleAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

export async function issueInvoiceOnPaid(
  opts: IssueInvoiceOnPaidOptions,
): Promise<IssueInvoiceOnPaidResult> {
  const emitMode = opts.emit ?? "after";
  try {
    const order = await db.order.findUnique({
      where: { id: opts.orderId },
      select: {
        id: true,
        restaurantId: true,
        status: true,
        simpleInvoiceEmail: true,
        subtotalCents: true,
        compedAt: true,
        simpleInvoice: { select: { id: true } },
        restaurant: { select: { enabledModules: true } },
      },
    });
    if (!order || order.restaurantId !== opts.tenantId) {
      return { status: "skipped", reason: "not_found" };
    }
    // Todavía no está pagada (cobro parcial, cuenta compartida a medias):
    // la solicitud queda guardada y el próximo riel que la cierre la emite.
    if (order.status !== "paid") return { status: "skipped", reason: "not_paid" };

    // La personalizada manda sobre la genérica: si el comensal cargó sus
    // datos, la factura sale a su nombre aunque antes hubiera dejado un
    // correo suelto.
    const request = await db.invoiceRequest.findFirst({
      where: { orderId: order.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    const email = request?.email ?? order.simpleInvoiceEmail ?? null;
    const requested = !!request || !!email;
    const einvoicing = isModuleEnabled(order.restaurant.enabledModules, "einvoicing");
    // Con facturación electrónica toda VENTA se factura; sin ella, sólo lo
    // que pidieron. Una cortesía o una cuenta en $0 no es una venta: sale
    // sólo si alguien la pidió (comprobante, no factura), y nunca a la DIAN.
    const automatic = einvoicing && isBillableOrder(order);
    if (!automatic && !requested) {
      return {
        status: "skipped",
        reason: isBillableOrder(order) ? "not_requested" : "not_billable",
      };
    }

    if (automatic && !order.simpleInvoice) {
      // Sin número válido no hay tirilla ni DIAN: se deja constancia
      // colgada de la orden y el barrido vuelve cuando haya resolución.
      const emisor = await resolveEmisor(opts.tenantId);
      if (numberingExhausted(emisor)) {
        await recordNumberingExhausted({
          restaurantId: opts.tenantId,
          orderId: order.id,
        });
        console.warn("[invoice-on-paid] rango de numeración agotado; la orden espera", {
          orderId: order.id,
          invoiceNextNumber: emisor?.invoiceNextNumber,
          resolutionTo: emisor?.resolutionTo,
        });
        return { status: "blocked", reason: "numbering_exhausted" };
      }
    }

    const inv = await issueSimpleInvoice({
      tenantId: opts.tenantId,
      orderId: order.id,
      email,
      customer: request
        ? {
            name: request.customerName,
            docType: request.docType,
            docNumber: request.docNumber,
            address: request.address,
            city: request.city,
            department: request.department,
          }
        : null,
    });
    if (!inv.ok) return { status: "skipped", reason: inv.error === "not_found" ? "not_found" : "not_paid" };

    // Correo best-effort, sólo la primera vez: la factura ya existe y su
    // link es válido aunque el envío demore o falle. No lanza.
    if (!inv.alreadyIssued && inv.email) {
      void sendSimpleInvoiceEmail({
        invoiceId: inv.invoiceId,
        snapshot: inv.snapshot,
        invoiceNumber: inv.invoiceNumber,
        invoiceUrl: inv.invoiceUrl,
        email: inv.email,
        locale: inv.locale,
      });
    }

    if (!automatic) {
      return { status: "issued", invoiceId: inv.invoiceId, alreadyIssued: inv.alreadyIssued, emit: null };
    }

    // El documento para la DIAN nace acá, en `to_send`. Si ya existía (otro
    // riel llegó antes, o una emisión anterior falló) no se toca: el
    // barrido decide cuándo reintentar. Sólo lo recién nacido (o el
    // placeholder recién adoptado) se intenta ya.
    const doc = await ensureDianDocument({
      simpleInvoiceId: inv.invoiceId,
      restaurantId: opts.tenantId,
      orderId: order.id,
    });
    let emitResult: EmitDianInvoiceResult | null = null;
    if (doc.state === "to_send") {
      const run = async () => {
        try {
          return await emitDianInvoice({
            simpleInvoiceId: inv.invoiceId,
            restaurantId: opts.tenantId,
          });
        } catch (err) {
          console.error("[invoice-on-paid] intento inmediato de emisión falló", {
            orderId: order.id,
            err,
          });
          return null;
        }
      };
      if (emitMode === "inline") emitResult = await run();
      else if (emitMode === "after") {
        scheduleAfterResponse(async () => {
          await run();
        });
      }
    }
    return {
      status: "issued",
      invoiceId: inv.invoiceId,
      alreadyIssued: inv.alreadyIssued,
      emit: emitResult,
    };
  } catch (err) {
    console.error("[invoice-on-paid] no se pudo emitir la factura", {
      orderId: opts.orderId,
      err,
    });
    return { status: "failed" };
  }
}
