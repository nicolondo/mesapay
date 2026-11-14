import { db } from "@/lib/db";
import { dianEnvironment } from "@/lib/dian/config";
import { dianQrUrl } from "@/lib/dian/crypto";
import { dianInvoiceAttachmentFor } from "@/lib/dian/sendInvoiceEmail";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import type { EmailAttachment } from "@/lib/mailer";
import { isInvoiceAnnulled } from "@/lib/orders/invoicedOrder";
import { invoiceUrlFor } from "@/lib/simpleInvoice";
import type { PayLinkEmailInvoice } from "@/lib/manualInvoicePayLinkEmail";

/**
 * La factura de una cuenta tal como la cuenta el correo del link de pago:
 * emitida (número, representación gráfica y, si es electrónica aceptada,
 * CUFE + XML adjunto) o por emitir al pagar. Una factura anulada con nota
 * crédito no se manda: el correo no la menciona.
 */
export async function payLinkInvoiceFor(args: {
  restaurantId: string;
  orderId: string;
  einvoicing: boolean;
}): Promise<{ invoice: PayLinkEmailInvoice | null; attachments: EmailAttachment[] }> {
  const inv = await db.simpleInvoice.findUnique({
    where: { orderId: args.orderId },
    select: {
      id: true,
      invoiceNumber: true,
      snapshot: true,
      totalCents: true,
      dianDocument: { select: { id: true, state: true, cufe: true } },
    },
  });
  if (!inv) return { invoice: { kind: "on_payment", electronic: args.einvoicing }, attachments: [] };
  if (await isInvoiceAnnulled(db, inv)) return { invoice: null, attachments: [] };

  const number = formatInvoiceNumber(inv.snapshot as unknown as InvoiceSnapshot, inv.invoiceNumber);
  const url = invoiceUrlFor(inv.id);
  const doc = args.einvoicing ? inv.dianDocument : null;
  if (!doc) {
    return { invoice: { kind: "issued", number, url, electronic: null, pendingDian: false }, attachments: [] };
  }
  if (doc.state !== "accepted" || !doc.cufe) {
    return { invoice: { kind: "issued", number, url, electronic: null, pendingDian: true }, attachments: [] };
  }
  const environment = await dianEnvironment(args.restaurantId);
  const attachment = await dianInvoiceAttachmentFor(doc.id);
  return {
    invoice: {
      kind: "issued",
      number,
      url,
      electronic: {
        cufe: doc.cufe,
        verifyUrl: dianQrUrl(doc.cufe, environment === "produccion" ? "1" : "2"),
        attached: attachment !== null,
      },
      pendingDian: false,
    },
    attachments: attachment ? [attachment] : [],
  };
}
