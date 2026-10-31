// Consultas de la pantalla de facturas electrónicas (/operator/facturas con
// el módulo `einvoicing`). Las reglas —filtros, estados, "llegó después"—
// son puras y viven en `invoiceList.ts` / `invoiceRequestCoverage.ts`.
//
// Rendimiento (≈1.000 facturas por mes en Son y Melona):
//   · La lista va por el índice SimpleInvoice[restaurantId, createdAt] y
//     llega al documento DIAN por su @unique simpleInvoiceId. Página de 50.
//   · El `snapshot` JSON de la tirilla NO se trae: de él sólo hacen falta el
//     prefijo y el cliente, y se leen con una consulta de rutas JSON
//     (`->>`) acotada a los ids de la página.
//   · El XML zipeado sólo se lee para el aviso "llegó después", y sólo de
//     las solicitudes pendientes cuya factura ya está aceptada: con el cierre
//     automático y la limpieza histórica, son justamente esos casos.
import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { documentErrors } from "@/lib/dian/config";
import { invoiceIssueInstant } from "@/lib/dian/attachedDocument";
import { resolveDianRecipient } from "@/lib/dian/invoiceEmail";
import { unzipFirstXml } from "@/lib/dian/soap";
import {
  invoiceDianStatus,
  invoiceDisplayNumber,
  invoiceListWhere,
  invoicePageCount,
  invoicePageWindow,
  last30BusinessDays,
  type InvoiceDianStatus,
  type InvoiceListParams,
} from "@/lib/dian/invoiceList";
import { invoiceXmlBuyerId, isLateInvoiceRequest } from "@/lib/dian/invoiceRequestCoverage";

/** Nota crédito (la vigente más reciente) de una factura. */
export type InvoiceCreditNoteInfo = {
  documentNumber: string;
  /** Estado del documento DIAN de la nota; "draft" si todavía no tiene. */
  state: string;
};

export type InvoiceListRow = {
  /** SimpleInvoice.id — la factura. */
  id: string;
  orderId: string;
  number: string;
  shortCode: string;
  createdAt: string;
  /** Adquiriente de la representación gráfica; null = consumidor final. */
  customer: { name: string; docType: string; docNumber: string } | null;
  totalCents: number;
  dian: {
    documentId: string;
    state: string;
    status: InvoiceDianStatus;
    /** Motivo legible del último intento fallido o del bloqueo. */
    reason: string | null;
    errors: string[];
    emailedAt: string | null;
    emailError: string | null;
    /** A qué correo salió / saldría (misma precedencia que el envío). */
    emailTo: string | null;
  };
  creditNote: InvoiceCreditNoteInfo | null;
};

export type InvoiceListPage = {
  rows: InvoiceListRow[];
  total: number;
  page: number;
  pageCount: number;
};

type SnapshotFields = {
  id: string;
  prefix: string | null;
  customerName: string | null;
  customerDocType: string | null;
  customerDocNumber: string | null;
};

/**
 * Prefijo y cliente congelados en la tirilla, sin traer el snapshot entero.
 * Acotado a los ids pedidos y al comercio.
 */
async function snapshotFields(
  restaurantId: string,
  ids: string[],
): Promise<Map<string, SnapshotFields>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<SnapshotFields[]>(Prisma.sql`
    SELECT "id",
           "snapshot"->>'invoicePrefix' AS "prefix",
           "snapshot"->'customer'->>'name' AS "customerName",
           "snapshot"->'customer'->>'docType' AS "customerDocType",
           "snapshot"->'customer'->>'docNumber' AS "customerDocNumber"
      FROM "SimpleInvoice"
     WHERE "restaurantId" = ${restaurantId}
       AND "id" IN (${Prisma.join(ids)})`);
  return new Map(rows.map((r) => [r.id, r]));
}

const CREDIT_NOTE_SELECT = {
  where: { abandonedAt: null },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { documentNumber: true, dianDocument: { select: { state: true } } },
};

function creditNoteInfo(
  notes: { documentNumber: string; dianDocument: { state: string } | null }[],
): InvoiceCreditNoteInfo | null {
  const note = notes[0];
  return note ? { documentNumber: note.documentNumber, state: note.dianDocument?.state ?? "draft" } : null;
}

export async function loadInvoiceListPage(
  restaurantId: string,
  params: InvoiceListParams,
  cutoffHour: number,
): Promise<InvoiceListPage> {
  const where = invoiceListWhere(restaurantId, params, cutoffHour);
  const [total, invoices] = await Promise.all([
    db.simpleInvoice.count({ where }),
    db.simpleInvoice.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...invoicePageWindow(params.page),
      select: {
        id: true,
        orderId: true,
        invoiceNumber: true,
        totalCents: true,
        createdAt: true,
        email: true,
        order: {
          select: {
            shortCode: true,
            simpleInvoiceEmail: true,
            // La misma solicitud que mira el envío del correo.
            invoiceRequests: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { email: true },
            },
          },
        },
        dianDocument: {
          select: {
            id: true,
            state: true,
            attempts: true,
            lastError: true,
            errors: true,
            emailedAt: true,
            emailError: true,
          },
        },
        creditNotes: CREDIT_NOTE_SELECT,
      },
    }),
  ]);
  const snaps = await snapshotFields(restaurantId, invoices.map((i) => i.id));

  const rows: InvoiceListRow[] = invoices.flatMap((inv) => {
    const doc = inv.dianDocument;
    if (!doc) return [];
    const snap = snaps.get(inv.id);
    const errors = documentErrors(doc.errors);
    const status = invoiceDianStatus(doc);
    return [
      {
        id: inv.id,
        orderId: inv.orderId,
        number: invoiceDisplayNumber(snap?.prefix, inv.invoiceNumber),
        shortCode: inv.order.shortCode,
        createdAt: inv.createdAt.toISOString(),
        customer:
          snap?.customerName && snap.customerDocNumber
            ? {
                name: snap.customerName,
                docType: snap.customerDocType ?? "",
                docNumber: snap.customerDocNumber,
              }
            : null,
        totalCents: inv.totalCents,
        dian: {
          documentId: doc.id,
          state: doc.state,
          status,
          reason: status === "accepted" || status === "in_process" ? null : (doc.lastError ?? errors[0] ?? null),
          errors,
          emailedAt: doc.emailedAt?.toISOString() ?? null,
          emailError: doc.emailError,
          emailTo: resolveDianRecipient({
            invoiceRequestEmail: inv.order.invoiceRequests[0]?.email,
            simpleInvoiceEmail: inv.email,
            orderSimpleInvoiceEmail: inv.order.simpleInvoiceEmail,
          }),
        },
        creditNote: creditNoteInfo(inv.creditNotes),
      },
    ];
  });

  return { rows, total, page: params.page, pageCount: invoicePageCount(total) };
}

/** "N facturas rechazadas en los últimos 30 días" y el rango de su filtro. */
export async function countRecentRejected(
  restaurantId: string,
  cutoffHour: number,
  now: Date = new Date(),
): Promise<{ count: number; from: string; to: string }> {
  const range = last30BusinessDays(cutoffHour, now);
  const count = await db.simpleInvoice.count({
    where: invoiceListWhere(restaurantId, { state: "rejected", ...range, q: "" }, cutoffHour),
  });
  return { count, ...range };
}

export type LateInvoiceRequest = {
  /** InvoiceRequest.id — lo que marca "resuelta". */
  id: string;
  customerName: string;
  docType: string;
  docNumber: string;
  email: string;
  requestedAt: string;
  /** SimpleInvoice.id — lo que preselecciona Notas crédito. */
  invoiceId: string;
  invoiceNumber: string;
  shortCode: string;
  issuedAt: string;
  creditNote: InvoiceCreditNoteInfo | null;
};

/** Cuántas solicitudes pendientes con factura aceptada se miran, como mucho. */
export const LATE_CANDIDATES_LIMIT = 200;

/**
 * Solicitudes que llegaron DESPUÉS de que la factura de su cuenta salió
 * aceptada a consumidor final. La decisión sale del XML aceptado —el
 * adquiriente y el instante de emisión que declara—, no de la tirilla: la
 * tirilla se congela al cobrar y la emisión puede haber tomado una
 * solicitud posterior.
 */
export async function loadLateInvoiceRequests(
  restaurantId: string,
): Promise<{ items: LateInvoiceRequest[]; truncated: boolean }> {
  const candidates = await db.invoiceRequest.findMany({
    where: {
      restaurantId,
      status: "pending",
      order: {
        simpleInvoice: { is: { dianDocument: { is: { kind: "invoice", state: "accepted" } } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: LATE_CANDIDATES_LIMIT,
    select: {
      id: true,
      customerName: true,
      docType: true,
      docNumber: true,
      email: true,
      createdAt: true,
      order: {
        select: {
          shortCode: true,
          simpleInvoice: {
            select: {
              id: true,
              invoiceNumber: true,
              dianDocument: { select: { xmlZip: true } },
              creditNotes: CREDIT_NOTE_SELECT,
            },
          },
        },
      },
    },
  });

  // Un XML por factura, aunque la cuenta tenga más de una solicitud.
  const facts = new Map<string, { buyerId: string | null; issuedAt: Date | null }>();
  for (const c of candidates) {
    const inv = c.order.simpleInvoice;
    if (!inv || facts.has(inv.id)) continue;
    const zip = inv.dianDocument?.xmlZip;
    const xml = zip ? await unzipFirstXml(zip) : null;
    facts.set(inv.id, {
      buyerId: xml ? invoiceXmlBuyerId(xml) : null,
      issuedAt: xml ? (invoiceIssueInstant(xml)?.at ?? null) : null,
    });
  }

  const late = candidates.filter((c) => {
    const inv = c.order.simpleInvoice;
    const f = inv ? facts.get(inv.id) : undefined;
    return !!f && isLateInvoiceRequest({ requestCreatedAt: c.createdAt, ...f });
  });
  const snaps = await snapshotFields(
    restaurantId,
    [...new Set(late.map((c) => c.order.simpleInvoice!.id))],
  );

  return {
    truncated: candidates.length >= LATE_CANDIDATES_LIMIT,
    items: late.map((c) => {
      const inv = c.order.simpleInvoice!;
      return {
        id: c.id,
        customerName: c.customerName,
        docType: c.docType,
        docNumber: c.docNumber,
        email: c.email,
        requestedAt: c.createdAt.toISOString(),
        invoiceId: inv.id,
        invoiceNumber: invoiceDisplayNumber(snaps.get(inv.id)?.prefix, inv.invoiceNumber),
        shortCode: c.order.shortCode,
        issuedAt: facts.get(inv.id)!.issuedAt!.toISOString(),
        creditNote: creditNoteInfo(inv.creditNotes),
      };
    }),
  };
}
