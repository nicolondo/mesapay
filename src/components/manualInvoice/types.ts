/**
 * Lo que las pantallas del staff necesitan para "Emitir y enviar factura"
 * de una FACTURA MANUAL (y para reenviar su link). Lo arma el server
 * (src/lib/manualInvoiceSendInfo.ts) y lo pintan la ficha en Mesas, la ficha
 * de la orden y la lista de Órdenes. Sólo datos serializables.
 */
export type PayLinkMethod = "kushki_card" | "kushki_apple_pay" | "kushki_pse" | "kushki_bre_b";

export type PayLinkStateView = "open" | "paid" | "cancelled" | "expired";

export type PayLinkView = {
  url: string;
  expiresAt: string;
  state: PayLinkStateView;
  /** Destinatarios del último envío por correo. */
  sentTo: string[];
  sentAt: string | null;
  /** Primera vez que el cliente lo abrió. */
  openedAt: string | null;
  /** Pagado EN LÍNEA por el link: con qué (slug del medio) y cuándo. */
  paidMethod: string | null;
  paidAt: string | null;
};

/** La factura emitida por cobrar (la cuenta ya salió de Mesas). */
export type ReceivableView = {
  /** Cargo a crédito (Payment customer_credit) que el link salda. */
  chargeId: string;
  billingCustomerId: string;
  customerName: string | null;
  totalCents: number;
  outstandingCents: number;
  dueDate: string;
  overdue: boolean;
};

export type ManualInvoiceSendUnavailable =
  | "not_manual_invoice"
  | "order_closed"
  | "nothing_to_pay"
  | "online_payments_unavailable";

export type ManualInvoiceSendInfo = {
  orderId: string;
  /** Código visible de la cuenta (#ABC123). */
  orderCode: string;
  tenantName: string;
  currency: string;
  /** Saldo de la cuenta abierta, o del cargo por cobrar. */
  outstandingCents: number;
  /** La cuenta sigue abierta (en Mesas). */
  open: boolean;
  /** Se puede crear / enviar el link (gate del server). */
  canSend: boolean;
  unavailable: ManualInvoiceSendUnavailable | null;
  /** Medios en línea que verá el cliente. */
  methods: PayLinkMethod[];
  /** Número de la factura, si ya existe (emitida antes o al enviar). */
  invoiceNumber: string | null;
  /** Cliente de la factura (la solicitud de la cuenta), si se identificó. */
  customerName: string | null;
  /** Correos sugeridos: el del cliente de la factura y los del último envío. */
  suggestedEmails: string[];
  link: PayLinkView | null;
  receivable: ReceivableView | null;
};
