/**
 * Tipos compartidos del pedido de factura del comensal. Los usan el checkout
 * (`/t/[slug]/pay/[orderId]`, donde ahora se pide la factura) y la pantalla
 * de "listo" (`…/done`), que quedó sólo con el estado.
 */

export type DocType = "CC" | "CE" | "NIT" | "PA";

/** Solicitud de factura PERSONALIZADA ya registrada en esta cuenta. */
export type InvoiceRequestSummary = {
  status: "pending" | "generated" | "rejected";
  customerName: string;
  docType: DocType;
  docNumber: string;
  email: string;
  address: string;
  city: string;
  department: string;
};

/**
 * Lo que el comensal ya pidió en esta cuenta, si pidió algo:
 *  - `formal`: cargó sus datos (nombre, documento, dirección) → InvoiceRequest.
 *  - `simple`: sólo dejó el correo para la tirilla a consumidor final.
 */
export type InvoiceIntent =
  | { kind: "formal"; summary: InvoiceRequestSummary }
  | { kind: "simple"; email: string };
