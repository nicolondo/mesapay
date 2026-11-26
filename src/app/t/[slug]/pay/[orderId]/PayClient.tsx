"use client";

import { displayOrderCode } from "@/lib/orderCode";
import { MoneyInput } from "@/components/MoneyInput";
import { startTransition, useTransition } from "react";
import { MixedPaymentPanel, type ApprovedPaymentView } from "@/components/payments/MixedPaymentPanel";
import { mixedPaymentBudget, allocateMixedPayment } from "@/lib/payments/mixedAmount";
import { useApplePaySupport } from "@/lib/browser/capabilities";
import { onlineMethodsInOrder } from "@/lib/payments/defaultOnlineMethod";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useApiError } from "@/lib/useApiError";
import { useChargeDeclineText } from "@/lib/useChargeDeclineText";
import { TerminalPicker, useTerminalChoice } from "@/components/payments/TerminalPicker";
import type { TerminalDeviceOption } from "@/lib/payments/terminalAvailability";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import Link from "next/link";
import { fmtCOP, formatMoney, formatNumber } from "@/lib/format";
import { isCashMethod } from "@/lib/payments/methods";
import { ApplePayButton } from "./ApplePayButton";
import { BreBSheet, type BreBCloseReason } from "@/components/payments/BreBSheet";
import type { BreBChargeView } from "@/lib/payments/breB/view";
import { InvoiceCheckoutCard } from "@/components/invoice/InvoiceCheckoutCard";
import type { InvoiceIntent } from "@/components/invoice/types";
import {
  InvoicedOrderBanner,
  PreInvoiceAction,
  type InvoicedOrderView,
} from "@/components/invoice/PreInvoicePanel";
import { CustomerPicker } from "@/components/billingCustomers/CustomerPicker";
import { OrderReviewBanner } from "@/components/orderReview/OrderReviewBanner";
import { discountOriginLabel } from "@/components/orderReview/discountOrigin";
import type { DiscountOriginView, OrderReviewView } from "@/lib/orderReview";
import {
  PendingPaymentNotice,
  type PendingPaymentView,
} from "@/components/payments/PendingPaymentNotice";
import {
  billingDocument,
  creditAvailableCents,
  discountBpsToPctText,
  type BillingCustomerRecord,
} from "@/components/billingCustomers/types";
import {
  checkoutTaxLine,
  outstandingSubtotalCents as computeOutstandingSubtotalCents,
  paidFoodCents as computePaidFoodCents,
  payModeSubtotalCents,
  type CheckoutTax,
  type PayMode,
} from "@/lib/checkoutTax";
// Chips, default, base sin impuestos y redondeo de la propina viven en
// lib/tips: el estado del pedido previsualiza el total con la MISMA
// aritmética con la que acá se cobra, así el comensal no ve un número allá
// y otro acá.
import {
  DEFAULT_TIP_PCT,
  TIP_OPTIONS,
  parseTipPct,
  tipBaseCentsOf,
  tipBaseExcludesTax,
  tipCentsFor,
  tipStorageKey,
  type TipBase,
} from "@/lib/tips";
// Cobro EN SERIE de la cuenta dividida (sólo staff): el estado vive en
// useSerialCharge + lib/payments/serialCharge; acá sólo se conecta.
import {
  serialEqualPartCents,
  type SerialMethod,
  type SerialMode,
} from "@/lib/payments/serialCharge";
import { observeTerminalStatus, pendingTerminalIdsToObserve, watchStaffTerminal, type TerminalResult } from "@/lib/payments/staffTerminalWatch";
import { useSerialCharge } from "./useSerialCharge";
import { SerialChargeCard } from "./SerialChargeCard";

type PayItem = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  guestName: string | null;
};

type MethodKind =
  | "kushki_apple_pay"
  | "kushki_card"
  | "kushki_card_terminal"
  | "kushki_pse"
  | "kushki_bre_b"
  | "external_terminal"
  | "cash"
  | "customer_credit"
  | "representacion";

/** Dónde se recuerda (en este aparato) el QR Bre-B abierto de una cuenta. */
const breBStorageKey = (orderId: string) => `mesapay.breb.${orderId}`;

/** Cliente de facturación asociado a la cuenta en el cobro (staff). */
export type PayCustomer = Pick<
  BillingCustomerRecord,
  | "id"
  | "customerName"
  | "docType"
  | "docNumber"
  | "verificationDigit"
  | "creditEnabled"
  | "creditLimitCents"
  | "discountEnabled"
  | "discountBps"
  | "debtCents"
>;

type DiscountOutcome = {
  applied: boolean;
  changed?: boolean;
  reason?: string;
  discountPct: number | null;
  discountCents: number;
  subtotalCents: number;
};

export function PayClient({
  tenantSlug,
  tenantName,
  orderId,
  shortCode,
  tableId,
  locationLabel,
  subtotalCents,
  grossSubtotalCents,
  discountCents = 0,
  discountPct = null,
  discountOrigin = null,
  review = null,
  revertedCustomerName = null,
  paidCents,
  paidTipCents,
  alreadyPaid,
  items,
  serviceMode,
  kushkiReady,
  kushkiPublicKey,
  kushkiMode,
  currency,
  card3ds,
  enabledMethods,
  pseBanks,
  terminalDevices = [],
  declinedFlag = false,
  declinedReason = null,
  declineCode = null,
  operatorMode = false,
  staffHomeHref = "/operator/tables",
  staffServeHref = "/operator/serve",
  preInvoiceEnabled = true,
  printSameTab = false,
  canConfigurePrinters = true,
  terminalMode = false,
  doneHref = "",
  compEnabled = false,
  compAdminRequired = false,
  compLabel = null,
  invoiceIntent = null,
  invoicePrefillEmail = null,
  preInvoice = null,
  canAnnulInvoice = false,
  salesTax = null,
  vouchersEnabled = false,
  initialTipPct = null,
  tipBase = null,
  customerStepEnabled = false,
  creditEnabled = false,
  linkedCustomer = null,
  pendingPayments = [],
  kushkiTerminalAvailable = false,
  canResolveTerminal = false,
  approvedPayments = [],
  tableNumber = 0,
  payLinkMode = false,
  manualInvoice = false,
}: {
  tenantSlug: string;
  tenantName: string;
  orderId: string;
  /**
   * Propina con la que arranca la pantalla, ya validada (entero 0..30) —
   * viene del `?tip=` con el que el estado del pedido manda al comensal a
   * pagar. null ⇒ el 10 % de siempre. Si el comensal ya eligió una para
   * esta cuenta (sessionStorage), esa pisa a ambas al montar.
   */
  initialTipPct?: number | null;
  /**
   * La cuenta partida en lo cobrable y su parte sin impuesto (`tipBase.ts`,
   * mismo reparto que la factura). El % de propina va sobre la parte sin
   * impuesto de lo que se paga en cada modo. null = sin impuesto.
   */
  tipBase?: TipBase | null;
  shortCode: string;
  tableId: string;
  locationLabel: string;
  /**
   * Lo COBRABLE: el subtotal ya con el descuento del comensal restado.
   * Toda la aritmética de la pantalla (partes iguales, lo mío, saldo)
   * cuelga de acá, así que tiene que llegar neto — si llegara bruto, el
   * servidor rechazaría el cobro por "excede lo pendiente".
   */
  subtotalCents: number;
  /** El subtotal ANTES del descuento — solo para mostrar el desglose. */
  grossSubtotalCents: number;
  discountCents?: number;
  discountPct?: number | null;
  /** Sólo staff: de dónde viene el descuento («Descuento del cliente X»). */
  discountOrigin?: DiscountOriginView;
  /** Sólo staff: aviso «Revisar» de la cuenta (src/lib/orderReviewFlags.ts). */
  review?: OrderReviewView | null;
  /**
   * Sólo staff, al volver de un cobro rechazado: el cliente cuyo descuento
   * se deshizo porque ese cobro no se completó (se avisa para escogerlo de
   * nuevo si sigue siendo él).
   */
  revertedCustomerName?: string | null;
  paidCents: number;
  paidTipCents: number;
  alreadyPaid: boolean;
  items: PayItem[];
  serviceMode: "table" | "counter";
  kushkiReady: boolean;
  kushkiPublicKey: string | null;
  // Modo Kushki resuelto server-side desde /admin/configuracion.
  // Cada componente que habla con Kushki (CardSheet, PseSheet,
  // ApplePayButton) lo usa para switchear inTestEnvironment + URL
  // base — sin esto teníamos sandbox hardcodeado en el browser y
  // cambiar el modo desde admin no surtía efecto del lado cliente.
  kushkiMode: "mock" | "sandbox" | "production";
  // Moneda de cobro del comercio (resuelta server-side del país). La
  // tokenización de tarjeta DEBE ir ligada a esta moneda o Kushki rechaza
  // el cobro con K055.
  currency: "COP" | "MXN";
  // 3DS en pagos con tarjeta: si true, la tokenización pide
  // authValidation:"url" y el diner pasa por el OTP del banco cuando la
  // tarjeta lo requiere. Configurable por comercio desde
  // /admin/restaurants/[id]/pagos.
  card3ds: boolean;
  // Per-restaurant payment method toggles. Slugs of methods the admin
  // enabled in /admin/restaurants/[id]. Buttons are filtered against
  // this list so disabled methods never render.
  enabledMethods: (
    | "kushki_card_terminal"
    | "kushki_card"
    | "kushki_apple_pay"
    | "kushki_pse"
    // Bre-B sólo llega acá si además el comercio tiene cargadas las llaves
    // de su comercio Bre-B (lo filtra PayFlow con `offerablePaymentMethods`).
    | "kushki_bre_b"
    | "external_terminal"
    | "cash"
  )[];
  // Lista de bancos PSE pre-fetcheada server-side desde Kushki (cache
  // 1h en el backend). Si el SSR pudo, llega populada y el PseSheet
  // la usa directo sin hacer ningún fetch al abrirse → dropdown
  // instantáneo. Si vino vacía (kushki_pse no habilitado, error, etc.)
  // el PseSheet hace fallback al endpoint /pse-banks como antes.
  pseBanks: Array<{ code: string; name: string }>;
  // Datáfonos Kushki del comercio a los que se puede mandar el cobro (sólo
  // staff). Son del comercio, no de un mesero: con uno solo el cobro va
  // directo a ése; con varios, "¿A qué datáfono?" (recuerda el último
  // elegido en este aparato). Ver lib/payments/terminalChoice.ts.
  terminalDevices?: TerminalDeviceOption[];
  /** Si true, mostramos banner "Pago rechazado, elegí otro método". */
  declinedFlag?: boolean;
  /**
   * Por qué volvió: "terminal_canceled" = se canceló en el datáfono (no se
   * cobró nada). El banner lo dice así en vez de "no fue aprobado".
   */
  declinedReason?: "terminal_canceled" | null;
  /**
   * Motivo (código) del rechazo con tarjeta con el que volvió, p. ej. del
   * 3DS. Se traduce con `useChargeDeclineText`; desconocido → texto genérico.
   */
  declineCode?: string | null;
  // The waiter is initiating payment for a diner who didn't tap "Pedir
  // cuenta" themselves. Hides Apple Pay (needs diner's phone), shows
  // a banner, and bounces back to staffHomeHref/staffServeHref once
  // the bill is either approved or queued (instead of the diner-side
  // /done view).
  operatorMode?: boolean;
  // Post-settle destinations resueltos por el server según el rol:
  // operator/platform_admin → /operator/tables + /operator/serve.
  // mesero → /mesero/mesas + /mesero/salon (el operator layout está
  // gated y un mesero quedaría con 403).
  staffHomeHref?: string;
  staffServeHref?: string;
  /** Staff: ofrecer "Factura antes de cobrar" (el datáfono no la emite). */
  preInvoiceEnabled?: boolean;
  /** Staff: la vista de impresión se abre en la misma pestaña (mesero, datáfono). */
  printSameTab?: boolean;
  /** Staff: enlace a configurar impresoras (sólo el panel). */
  canConfigurePrinters?: boolean;
  /** Staff: cobra el usuario de datáfono (el banner dice "Modo datáfono"). */
  terminalMode?: boolean;
  // Pantalla de "listo" tras cobrar (con la factura) DENTRO del scope del
  // que cobra: mesero → /mesero/…/done (mantiene el bottom nav); operador
  // → /t/[slug]/…/done?op=1. Vacío = fallback al done del comensal en op.
  doneHref?: string;
  // Gastos de representación (cortesía $0): solo en operatorMode y si el
  // comercio lo habilitó. compLabel = nombre configurable (null ⇒ default i18n).
  compEnabled?: boolean;
  compAdminRequired?: boolean;
  compLabel?: string | null;
  // Factura que el comensal ya pidió en esta cuenta (si pidió). Se muestra
  // como resumen corto en vez de volver a abrirle el formulario.
  invoiceIntent?: InvoiceIntent | null;
  // Correo del último cobro con tarjeta, para prellenar los sheets.
  invoicePrefillEmail?: string | null;
  // Factura emitida ANTES de cobrar: se muestra (y se reimprime) en vez de
  // preguntar por la factura; el cobro no emite otra. null = no hay.
  preInvoice?: InvoicedOrderView | null;
  // Quien cobra puede anular con nota crédito (administrador, no mesero).
  canAnnulInvoice?: boolean;
  // Impuesto de ventas del comercio. Los platos ya lo traen DENTRO del
  // precio, así que sólo alimenta el renglón informativo "Incluye
  // impoconsumo 8%" — no toca ningún monto a cobrar. null/none ⇒ nada.
  salesTax?: CheckoutTax | null;
  // Módulo `vouchers` activo: se ofrece aplicar un bono empresarial a la
  // cuenta antes de elegir cómo pagar el resto.
  vouchersEnabled?: boolean;
  // Paso opcional "Cliente" (sólo staff): el comercio tiene clientes de
  // facturación. Asociar la cuenta aplica el descuento del cliente y deja
  // preseleccionado el cobro a crédito.
  customerStepEnabled?: boolean;
  // Hay clientes con crédito habilitado: se ofrece "Cobrar a crédito".
  creditEnabled?: boolean;
  // Cliente ya ligado a la cuenta por la solicitud de factura nominativa.
  linkedCustomer?: PayCustomer | null;
  // Pagos `pending` de la cuenta (sólo staff): la solicitud ("pidió pagar
  // con datáfono/efectivo por $X", o el datáfono Kushki sin enviar) va
  // arriba con "Confirmar pago recibido" / "Cancelar solicitud"; un pago en
  // línea en curso, sin acción.
  pendingPayments?: PendingPaymentView[];
  // El comercio puede empujar un cobro al datáfono Kushki (método
  // habilitado, Business-Code y un equipo activo): sin esto no se ofrece,
  // para no crear una solicitud que nadie va a poder enviar.
  kushkiTerminalAvailable?: boolean;
  // Quien cobra es administrador (nunca el mesero): puede "Resolver cobro"
  // de un datáfono Kushki enviado que no devolvió resultado.
  canResolveTerminal?: boolean;
  approvedPayments?: ApprovedPaymentView[];
  // Número de la mesa, para el título del cobro en efectivo del aviso.
  tableNumber?: number;
  // Pagador REMOTO de una factura manual, que entró por el link de pago
  // (/r/[slug]/cuenta/[token]). Paga el total en línea: sin dividir la
  // cuenta, sin efectivo ni datáfono (nadie va a venir a cobrarle), sin
  // "volver al pedido" (no hay mesa). Apple Pay queda preseleccionado
  // cuando el aparato lo admite; si no, tarjeta y después PSE
  // (lib/payments/defaultOnlineMethod.ts).
  payLinkMode?: boolean;
  /** Cuenta de una factura manual (mesa `kind = manual`). */
  manualInvoice?: boolean;
}) {
  // Diner counter orders require prepayment; staff may combine methods.
  // The server activates preparation only after the whole balance is paid.
  const isCounter = serviceMode === "counter";
  // Derivado del modo Kushki. isMockMode es el toggle de mayor uso
  // (caemos a fake tokens / hardcoded bank list en mock), mientras
  // los componentes que hablan con Kushki necesitan el modo completo
  // para switchear inTestEnvironment / base URL.
  const isMockMode = kushkiMode === "mock";
  const router = useRouter();
  const t = useTranslations("pay");
  const tPre = useTranslations("preInvoice");
  const tCommon = useTranslations("common");
  // Lo pedido de factura en esta cuenta: lo comparten la tarjeta de la
  // factura y "Imprimir factura" (antes de cobrar), que muestra a quién va.
  const [checkoutIntent, setCheckoutIntent] = useState<InvoiceIntent | null>(invoiceIntent);
  const invoiceIntentKey =
    checkoutIntent?.kind === "formal"
      ? `f:${checkoutIntent.summary.docType}:${checkoutIntent.summary.docNumber}`
      : checkoutIntent?.kind === "simple"
        ? `s:${checkoutIntent.email ?? ""}`
        : "none";
  const apiError = useApiError();
  // Motivo del rechazo con tarjeta / Apple Pay (código del servidor → texto).
  const declineText = useChargeDeclineText();
  // A qué datáfono va el cobro del staff (ver lib/payments/terminalChoice.ts).
  const terminalChoice = useTerminalChoice(terminalDevices, tenantSlug);
  const [tipPct, setTipPct] = useState<number>(initialTipPct ?? DEFAULT_TIP_PCT);
  const [busy, setBusy] = useState<MethodKind | null>(null);
  const terminalWatch = useRef<ReturnType<typeof watchStaffTerminal> | null>(null);
  const [lastTerminalRequest, setLastTerminalRequest] = useState<{ id: string; method: MethodKind; amount: number; tip: number; deviceId: string | null } | null>(null);
  const [watchedPaymentId, setWatchedPaymentId] = useState<string | null>(null);
  const settledTerminalIds = useRef(new Set<string>());
  const [manualCancel, setManualCancel] = useState(false);
  const tAttempt = useTranslations("terminalAttempt");
  const [consultingTerminal, setConsultingTerminal] = useState(false);
  const [terminalUnknown, setTerminalUnknown] = useState(false);
  useEffect(() => () => { terminalWatch.current?.stop(); terminalWatch.current = null; }, [orderId]);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<PayMode | "mixed">("full");
  const [refreshing, refreshTransition] = useTransition();
  const [mixedInput, setMixedInput] = useState<{ balance: string; value: string } | null>(null);
  const [useRemainder, setUseRemainder] = useState(paidCents > 0);
  const [paymentNotice, setPaymentNotice] = useState(false);
  const [cashUncertain, setCashUncertain] = useState(false);
  const [focusPayment, setFocusPayment] = useState<"pending" | "summary" | null>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refreshing || !focusPayment) return;
    const target = focusPayment === "pending" ? pendingRef.current : summaryRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: "instant" });
    startTransition(() => setFocusPayment(null));
  }, [refreshing, focusPayment, pendingPayments.length]);
  const [splitCount, setSplitCount] = useState<number>(2);
  const hasApplePay = useApplePaySupport();
  // Link de pago: el botón de Apple Pay del SDK avisa cuando quedó visible
  // (dominio validado en Kushki). Hasta entonces, o si no, el default es
  // tarjeta. En mock no hay SDK: basta con que el navegador lo admita.
  const [applePayReady, setApplePayReady] = useState(false);
  const linkMethods = payLinkMode
    ? onlineMethodsInOrder({
        applePayAvailable: hasApplePay && (isMockMode || !kushkiPublicKey || applePayReady),
        enabledMethods,
        kushkiReady,
      })
    : [];
  const linkPrimary = linkMethods[0] ?? null;
  // Énfasis de cada botón en el link: el preseleccionado va lleno; el resto,
  // como alternativas. Fuera del link no cambia nada (undefined = el de siempre).
  const linkEmphasis = (method: (typeof linkMethods)[number]) =>
    payLinkMode ? (linkPrimary === method ? "primary" : "secondary") : undefined;
  const [cashTenderOpen, setCashTenderOpen] = useState(false);
  // QR Bre-B abierto: el pago y, si se acaba de crear, el cobro con su QR.
  const [breB, setBreB] = useState<{ paymentId: string; initial: BreBChargeView | null } | null>(null);
  // Por qué se cerró el último QR (cancelado / rechazado / vencido), para el aviso.
  const [breBNotice, setBreBNotice] = useState<"canceled" | "declined" | "expired" | "uncertain" | null>(null);
  const tBreB = useTranslations("breB");
  const [pseSheetOpen, setPseSheetOpen] = useState(false);
  const [cardSheetOpen, setCardSheetOpen] = useState(false);
  const [representacionOpen, setRepresentacionOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  // Cliente asociado a la cuenta (paso "Cliente" o factura nominativa) y el
  // aviso del descuento que dejó la última asociación.
  const [customer, setCustomer] = useState<PayCustomer | null>(linkedCustomer);
  const tOrigin = useTranslations("discountOrigin");
  const [customerNotice, setCustomerNotice] = useState<string | null>(
    revertedCustomerName ? tOrigin("reverted", { name: revertedCustomerName }) : null,
  );
  // Etiqueta del descuento: al personal le dice de dónde viene; al
  // comensal, el texto de siempre.
  const discountLabel =
    (operatorMode ? discountOriginLabel(discountOrigin, discountPct, tOrigin) : null) ??
    (discountPct ? t("discountRowPct", { pct: discountPct }) : t("discountRow"));

  // El descuento que pone el paso «Cliente» pertenece a ESTE cobro: si el
  // personal sale de la pantalla sin completarlo, se deshace (best effort;
  // el servidor sólo lo hace sin pagos aprobados/pendientes ni factura, así
  // que salir HACIA el datáfono, el efectivo o «listo» no lo toca). Un
  // rechazo del pago lo deshace el servidor por su cuenta. No en la
  // recarga: ahí no hay desmontaje y la cuenta conserva el cliente.
  const customerDiscountAppliedHere = useRef(false);
  useEffect(() => {
    if (!operatorMode) return;
    return () => {
      if (!customerDiscountAppliedHere.current) return;
      try {
        void fetch(`/api/operator/orders/${orderId}/customer`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Best effort: la ficha de la mesa avisa «Revisar» si quedó puesto.
      }
    };
  }, [operatorMode, orderId]);

  // Remember the explicit account-wide tip when returning from a terminal
  // or reloading between payments. Never store credentials or payment data.
  useEffect(() => {
    if (!operatorMode) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(`mesapay.mixed.${orderId}`) || "null");
      const pct = parseTipPct(saved?.tipPct == null ? null : String(saved.tipPct));
      if (saved?.enabled === true && pct !== null) startTransition(() => { setMode("mixed"); setTipPct(pct); });
    } catch { /* Storage is optional. */ }
  }, [operatorMode, orderId]);

  function selectMode(next: PayMode | "mixed") {
    if (busy || refreshing || cashUncertain) return;
    setMode(next);
    setErr(null);
    if (operatorMode) try {
      sessionStorage.setItem(`mesapay.mixed.${orderId}`, JSON.stringify({ enabled: next === "mixed", tipPct }));
    } catch { /* Storage is optional. */ }
  }

  function refreshBalance() {
    refreshTransition(() => router.refresh());
  }

  function paymentConfirmed(paid: boolean) {
    if (paid) {
      // Cuenta en cero: recién ahora se va a "listo" (y el plan del cobro
      // en serie ya no sirve).
      serial.clear();
      router.push(doneHref || `/t/${tenantSlug}/pay/${orderId}/done?op=1`);
      return;
    }
    // Con la cuenta dividida en serie, el avance lo cuenta su tarjeta
    // («Pago k de n aprobado»); el aviso genérico es para los demás modos.
    if (!serialMode) setPaymentNotice(true);
    setFocusPayment("summary");
    setMixedInput(null);
    setUseRemainder(true);
    refreshBalance();
  }

  // Wallet-availability sniffing happens client-side. ApplePaySession is
  // only present on Safari/iOS.


  // Pre-cargar el SDK de Kushki en background. Pesa ~500KB y se usa
  // cuando el diner abre el sheet de PSE o tarjeta, o cuando arranca
  // el flow de Apple Pay. Si lo dejamos para ese momento, suma 1-3s
  // de espera adicional. Acá la importación arranca apenas se monta
  // la página de pago — para cuando el diner llena el form y le da
  // a "Ir al banco" / "Pagar", el bundle ya está en cache del module
  // loader (`await import()` resuelve sincrónico). Sólo cargamos en
  // sandbox/prod — en mock mode no se usa el SDK.
  useEffect(() => {
    if (kushkiMode === "mock") return;
    import("@kushki/js").catch((e) =>
      console.warn("[kushki] precarga del SDK falló", e),
    );
  }, [kushkiMode]);

  const guestTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) {
      const key = i.guestName?.trim() || "";
      if (!key) continue;
      m.set(key, (m.get(key) ?? 0) + i.priceCents * i.qty);
    }
    return Array.from(m.entries()).map(([name, cents]) => ({ name, cents }));
  }, [items]);

  const [myGuest, setMyGuest] = useState<string>(guestTotals[0]?.name ?? "");

  // "Lo mío": preseleccionar a la persona de ESTE dispositivo. El menú
  // guarda el nombre del comensal en localStorage (misma clave que
  // MenuClient: mesapay.guestName.<tableId>); si coincide con uno de
  // los invitados de la orden, arrancamos con él en vez del primero.
  // Solo flujo de cliente: en operatorMode el mesero cobra por otros.
  useEffect(() => {
    if (operatorMode) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`mesapay.guestName.${tableId}`);
    } catch {
      return;
    }
    const name = saved?.trim();
    if (!name) return;
    const match =
      guestTotals.find((g) => g.name === name) ??
      guestTotals.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (match) startTransition(() => setMyGuest(match.name));
    // Solo al montar: si el usuario cambia la selección a mano, no se la pisamos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cobro EN SERIE (sólo staff) ─────────────────────────────────────────
  // Cuando la cuenta se divide (partes iguales / individual), cada pago
  // aprobado NO reinicia el flujo: se queda acá, avanza a la parte siguiente
  // y ofrece repetir el mismo método con un toque. El plan (partes, cuál va,
  // comensales pagados, último método) vive en useSerialCharge; la verdad del
  // saldo y de cada pago es siempre del servidor (approvedPayments /
  // pendingPayments re-renderizados en cada refresh).
  const serialMode: SerialMode | null =
    operatorMode && !payLinkMode && mode !== "mixed"
      ? mode === "equal" ? "equal" : mode === "mine" ? "mine" : null
      : null;
  const serial = useSerialCharge({
    orderId,
    enabled: operatorMode && !payLinkMode,
    alreadyPaid,
    approvedPayments,
    pendingPaymentIds: pendingPayments.map((p) => p.id),
    onRestored: (plan) => {
      // La pestaña se cerró a mitad del cobro dividido: se retoma el modo y
      // las partes tal como quedaron (el saldo llega del servidor). El modo
      // mixto guardado tiene prioridad (su propio restore ya corre).
      try {
        const saved = JSON.parse(sessionStorage.getItem(`mesapay.mixed.${orderId}`) || "null");
        if (saved?.enabled === true) return;
      } catch { /* Storage es opcional. */ }
      startTransition(() => {
        setMode(plan.mode);
        if (plan.mode === "equal") setSplitCount(plan.splitCount);
      });
    },
    onPartApproved: () => {
      // Propina POR PAGO: la parte siguiente re-ofrece el selector para su
      // pagador, con el mismo cálculo centavo a centavo de siempre.
      startTransition(() => setTipPct(initialTipPct ?? DEFAULT_TIP_PCT));
    },
  });
  // Comensales ya cobrados del modo individual: chip marcado y, cuando el
  // elegido quedó pagado, se pasa solo al siguiente pendiente.
  const serialGuestsPaid = serial.plan?.mode === "mine" ? serial.plan.guestsPaid : [];
  const serialGuestsPaidKey = serialGuestsPaid.join(" ");
  useEffect(() => {
    if (!operatorMode || mode !== "mine" || !serialGuestsPaid.includes(myGuest)) return;
    const nextGuest = guestTotals.find((g) => !serialGuestsPaid.includes(g.name));
    if (nextGuest) startTransition(() => setMyGuest(nextGuest.name));
    // serialGuestsPaidKey representa la lista; el resto no debe re-disparar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialGuestsPaidKey, mode, operatorMode]);
  // Partes ya cobradas del plan de partes iguales (0 sin plan).
  const serialPartsDone = serial.plan?.mode === "equal" ? serial.plan.partsDone : 0;
  // No se puede dejar el plan con menos partes que las ya cobradas.
  const minSplitCount = Math.max(2, serialPartsDone + 1);
  useEffect(() => {
    if (serial.plan?.mode === "equal" && serial.plan.splitCount !== splitCount && splitCount >= minSplitCount) {
      serial.setSplitCount(splitCount);
    }
    // Sincroniza el plan cuando el staff cambia "entre cuántos".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitCount]);

  // Propina elegida antes, para ESTA cuenta, en el estado del pedido (o acá
  // mismo antes de recargar): se retoma al montar. Pisa al `?tip=` de la
  // URL y al default. Solo flujo de cliente: el staff cobra por otros.
  useEffect(() => {
    if (operatorMode) return;
    let saved: number | null = null;
    try {
      saved = parseTipPct(sessionStorage.getItem(tipStorageKey(orderId)));
    } catch {
      return;
    }
    if (saved !== null) startTransition(() => setTipPct(saved));
    // Solo al montar: si el usuario cambia la selección a mano, no se la pisamos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cambiar la propina la deja recordada para la cuenta: si el comensal
  // vuelve al estado del pedido, la previsualización arranca con su elección.
  function chooseTip(pct: number) {
    setTipPct(pct);
    if (operatorMode) {
      try { sessionStorage.setItem(`mesapay.mixed.${orderId}`, JSON.stringify({ enabled: mode === "mixed", tipPct: pct })); } catch { /* Optional. */ }
      return;
    }
    try {
      sessionStorage.setItem(tipStorageKey(orderId), String(pct));
    } catch {
      // Sin persistencia — la elección vive igual en el estado.
    }
  }

  // Lo pendiente de comida se calcula con el mismo helper que usa el estado
  // del pedido para previsualizar el total con propina.
  const paidFoodCents = computePaidFoodCents(paidCents, paidTipCents);
  const outstandingSubtotalCents = computeOutstandingSubtotalCents(
    subtotalCents,
    paidCents,
    paidTipCents,
  );

  // Lo que se paga de comida en cada modo (Todo / Partes iguales / Lo mío)
  // vive en checkoutTax.ts: siempre sobre lo PENDIENTE, nunca más que eso.
  // Acá sólo se le pasa lo que falta y lo de la persona elegida en "Lo mío".
  const mixed = operatorMode && mode === "mixed";
  const mixedBudget = mixedPaymentBudget({ netSubtotalCents: subtotalCents, paidCents, paidTipCents, tipPct, tipBase });
  const balanceKey = `${subtotalCents}:${paidCents}:${paidTipCents}:${tipPct}`;
  const mixedValue = mixedInput?.balance === balanceKey ? mixedInput.value
    : useRemainder && mixedBudget.ok ? String(mixedBudget.outstandingGrossCents / 100) : "";
  const mixedAllocation = allocateMixedPayment(mixedBudget, mixedValue === "" ? null : Math.round(Number(mixedValue) * 100));
  const amountSubtotal = mixed
    ? mixedAllocation.ok ? mixedAllocation.foodCents : 0
    : operatorMode && mode === "equal"
      // Partes iguales del STAFF en serie: la parte que sigue es el saldo
      // REAL entre las partes que faltan — y la última cobra EXACTO el
      // saldo (nada de dejar $1 por redondeo). El comensal conserva su
      // aritmética de siempre (payModeSubtotalCents).
      ? serialEqualPartCents(outstandingSubtotalCents, splitCount, serialPartsDone)
      : payModeSubtotalCents(mode === "mixed" ? "full" : mode, outstandingSubtotalCents, {
        splitCount, mineCents: guestTotals.find((g) => g.name === myGuest)?.cents ?? 0,
      });
  // El % va sobre el valor ANTES de impuestos de lo que se paga (la parte
  // proporcional sin impuesto de la cuenta), al peso — la misma función de
  // la previsualización, la precuenta y la factura.
  const amountTip = mixed ? mixedAllocation.ok ? mixedAllocation.tipCents : 0 : tipCentsFor(amountSubtotal, tipPct, tipBase);
  // «Sobre $X, el valor antes de impuestos»: la base de la propina de lo
  // que se cobra ahora (en mixto, la de toda la cuenta).
  const tipBaseAmount = mixed ? subtotalCents : amountSubtotal;
  const tipBaseNote = tipPct > 0 && tipBaseExcludesTax(tipBaseAmount, tipBase)
    ? tipBaseCentsOf(tipBaseAmount, tipBase)
    : null;
  const amountCents = amountSubtotal + amountTip;
  // A mounted checkout may already have requests (reload, other staff, or a
  // local external POS awaiting manual settlement). Poll those rows as well.
  const pendingTerminalIds = operatorMode ? pendingTerminalIdsToObserve(pendingPayments, watchedPaymentId).join(",") : "";
  const waitHref = (id: string) => `/t/${tenantSlug}/pay/${orderId}/terminal?pid=${encodeURIComponent(id)}&op=1`;
  function terminalOutcomeNotice(result: TerminalResult) {
    if (result.status === "refunded") return t("terminalRefunded");
    if (result.declineReason === "terminal_canceled") return t("terminalCanceledTitle");
    return t("terminalNotApproved");
  }
  const pendingTerminalResolved = useEffectEvent((result: TerminalResult, id: string) => {
    if (settledTerminalIds.current.has(id)) return;
    settledTerminalIds.current.add(id);
    if (!terminalWatch.current && result.terminalAmount && result.status === "approved") {
      router.push(waitHref(id));
      return;
    }
    if (result.status !== "approved" && !terminalWatch.current && !serialMode) setErr(terminalOutcomeNotice(result));
    router.refresh();
  });
  useEffect(() => {
    if (!pendingTerminalIds) return;
    const observers = pendingTerminalIds.split(",").filter(id => !settledTerminalIds.current.has(id))
      .map(id => observeTerminalStatus(tenantSlug, async () => id, pendingTerminalResolved));
    return () => observers.forEach(observer => observer.stop());
  }, [tenantSlug, pendingTerminalIds]);

  const pendingBlocksMixed = pendingPayments.some(payment => !isCashMethod(payment.method));
  const interactionLocked = busy !== null || refreshing || cashUncertain;
  // Factura anulada con nota crédito: la cuenta ya no tiene factura válida y
  // cobrarla dejaría una venta sin factura. Se cierra sin cobro (cortesía).
  const chargeDisabled =
    interactionLocked || amountCents <= 0 || (mixed && pendingBlocksMixed) || !!preInvoice?.annulled;
  function terminalDisabled(method: MethodKind) {
    // A mixed payment reserves the balance. Its own uncertain request can
    // still be checked/retried under the original server key.
    const prior = lastTerminalRequest;
    return terminalUnknown && prior?.method === method && prior.amount === amountCents && prior.tip === amountTip
      ? interactionLocked || !!preInvoice?.annulled || amountCents <= 0 : chargeDisabled;
  }
  const locale = useLocale() as Locale;
  const exactMoney = (cents: number) => formatMoney(cents, { currency, locale, fractionDigits: cents % 100 ? 2 : 0 });
  // Renglón informativo "Incluye impoconsumo 8% · $X" sobre lo que se está
  // pagando de comida en este modo. La propina no lleva impuesto.
  const taxLine = checkoutTaxLine(amountSubtotal, salesTax);

  // «Cobrar siguiente» repite el MISMO método del pago anterior — sólo si
  // ese método sigue disponible ahora mismo (y no hay otro cobro en curso,
  // que ya sale arriba con sus propias acciones).
  const serialRepeatMethod: SerialMethod | null = (() => {
    if (!serialMode || pendingPayments.length > 0) return null;
    const m = serial.plan?.lastMethod ?? null;
    if (!m || !enabledMethods.includes(m)) return null;
    if (m === "kushki_card_terminal") {
      return (kushkiReady || isMockMode) && kushkiTerminalAvailable &&
        (!terminalChoice.needsPicker || terminalChoice.selected)
        ? m
        : null;
    }
    if (m === "kushki_bre_b") return currency === "COP" ? m : null;
    return m;
  })();

  // Un toque: la parte siguiente ya trae su monto; acá sólo se repite el
  // método (el efectivo abre su hoja de siempre — el recibido/vuelto no se
  // inventa).
  function serialChargeNext(method: SerialMethod) {
    if (chargeDisabled) return;
    setErr(null);
    if (method === "cash") { setCashTenderOpen(true); return; }
    if (method === "external_terminal") { void payWithExternalTerminal(); return; }
    if (method === "kushki_card_terminal") { void payWithTerminal(); return; }
    void payWithBreB();
  }

  /**
   * Apple Pay — el token real viene del SDK de Kushki vía
   * <ApplePayButton/> (que muestra el sheet nativo de Apple). Acá
   * sólo recibimos el token ya válido y lo cobramos. En mock mode
   * (sin SDK) generamos un token fake.
   */
  async function payWithApplePayToken(token: string) {
    if (amountCents <= 0) return;
    setBusy("kushki_apple_pay");
    setErr(null);
    try {
      await sendKushkiTokenCharge("kushki_apple_pay", token);
    } finally {
      setBusy(null);
    }
  }

  // Mock fallback: cuando KUSHKI_MODE=mock no hay SDK que tokenice.
  // Generamos un token fake que el mock provider acepta para que el
  // wizard de dev se pueda probar end-to-end.
  async function payWithApplePayMock() {
    const token = `mock-applepay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await payWithApplePayToken(token);
  }

  /**
   * Tarjeta de crédito/débito tipeada en MESAPAY. El CardSheet ya
   * tokenizó vía Kushki.js — acá solo mandamos el token al backend
   * para que haga el charge con la private key. Datos de la tarjeta
   * (PAN/CVV) NUNCA pasan por nuestro server, mantienen SAQ-A.
   */
  async function payWithCardToken(
    token: string,
    contact?: { name?: string; email?: string },
  ) {
    if (amountCents <= 0) return;
    setBusy("kushki_card");
    setErr(null);
    try {
      await sendKushkiTokenCharge("kushki_card", token, contact);
    } finally {
      setBusy(null);
    }
  }

  // Shared backend roundtrip para los dos métodos token-based
  // (Apple Pay + tarjeta directa). El backend route /pay/kushki-charge
  // ya está parametrizado por method. `contact` (nombre/correo del titular)
  // va al contactDetails de Kushki cuando lo tenemos.
  async function sendKushkiTokenCharge(
    method: "kushki_apple_pay" | "kushki_card",
    token: string,
    contact?: { name?: string; email?: string },
  ) {
    const res = await fetch(`/api/tenant/${tenantSlug}/pay/kushki-charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId,
        method,
        token,
        amountCents,
        tipCents: amountTip,
        ...(contact?.name ? { contactName: contact.name } : {}),
        ...(contact?.email ? { contactEmail: contact.email } : {}),
      }),
    });
    const j = await res.json().catch(() => ({}));
    // Log completo (incluye detail crudo de Kushki) sólo en console
    // para debug. En la UI mostramos solo el mensaje amigable.
    if (j.pending && j.paymentId) {
      router.push(`/t/${tenantSlug}/pay/${orderId}/pending?pid=${encodeURIComponent(j.paymentId)}`);
      return;
    }
    if (!res.ok) {
      setErr(apiError(j, t("errPayFailed")));
      return;
    }
    if (j.approved && j.paymentId) {
      router.push(
        operatorMode
          ? doneHref || `/t/${tenantSlug}/pay/${orderId}/done?op=1`
          : `/t/${tenantSlug}/pay/${orderId}/done?pid=${j.paymentId}`,
      );
    } else {
      // Rechazado: se queda en esta pantalla, con el motivo (si Kushki lo
      // dijo) y todos los medios de pago a la mano para reintentar.
      setErr(declineText(j.reason) ?? apiError(j, t("errDeclined")));
    }
  }

  async function requestTerminal(method: "kushki_card_terminal" | "external_terminal") {
    const prior = terminalUnknown ? lastTerminalRequest : null;
    let retryingSameRequest = prior?.method === method && prior.amount === amountCents && prior.tip === amountTip;
    if (terminalDisabled(method)) return;
    const smart = method === "kushki_card_terminal";
    const target = smart && operatorMode ? terminalChoice.selected : null;
    if (smart && operatorMode && terminalDevices.length && !target) {
      setErr(t("terminalPickFirst"));
      return;
    }
    if (terminalUnknown && !window.confirm(t("terminalRetryConfirm"))) return;
    if (retryingSameRequest && terminalWatch.current) {
      const previous = terminalWatch.current;
      setBusy(method);
      const result = await previous.check();
      if (result?.status === "declined" && !result.nextPaymentId) retryingSameRequest = false;
      else if (result || terminalWatch.current !== previous) return;
    }
    const attemptId = operatorMode ? (retryingSameRequest && prior ? prior.id : crypto.randomUUID()) : null;
    if (attemptId) setLastTerminalRequest({ id: attemptId, method, amount: amountCents, tip: amountTip, deviceId: target?.id ?? null });
    setManualCancel(false);
    setBusy(method);
    setErr(null);
    setTerminalUnknown(false);
    terminalWatch.current?.stop();
    const recordLaunch = (paymentId: string) => serial.chargeLaunched({
      mode: serialMode, splitCount, method, paymentId, guest: mode === "mine" ? myGuest || null : null,
    });
    setWatchedPaymentId(null);
    const watch = attemptId ? watchStaffTerminal({
      tenantSlug, orderId, attemptId, method,
      onRegistered: id => {
        setWatchedPaymentId(id);
        // Record the launch while its controls are locked. After recovery the
        // user may already have changed the split, guest or payment method.
        if (!watch?.signal.aborted) recordLaunch(id);
      },
      onManualAvailable: () => setManualCancel(true),
      onResult: (result, id) => {
        const postWasReleased = watch?.signal.aborted;
        settledTerminalIds.current.add(id);
        watch?.stop();
        setWatchedPaymentId(null);
        terminalWatch.current = null;
        setManualCancel(false);
        setBusy(current => current === method ? null : current);
        setTerminalUnknown(false);
        if (result.nextPaymentId) {
          if (!postWasReleased) recordLaunch(result.nextPaymentId);
          router.push(waitHref(result.nextPaymentId));
        } else if (result.status === "approved") {
          // #620: the waiting page shows the actual amount for six seconds,
          // then returns a partial approval to this checkout with its balance.
          if (result.terminalAmount) router.push(waitHref(id));
          else if (postWasReleased && result.orderStatus !== "paid") router.refresh();
          else paymentConfirmed(result.orderStatus === "paid");
        } else {
          if (!serial.chargeDeclined(id)) {
            setErr(terminalOutcomeNotice(result));
          }
          router.refresh();
        }
      },
      onRecovery: outcome => {
        setManualCancel(false);
        setBusy(null);
        setTerminalUnknown(outcome !== "absent");
        if (outcome === "absent") {
          watch?.stop();
          terminalWatch.current = null;
          setWatchedPaymentId(null);
          setLastTerminalRequest(null);
          setErr(t("terminalNotCharged"));
        }
        setFocusPayment("pending");
        router.refresh();
      },
    }) : null;
    terminalWatch.current = watch;
    let awaitingStatus = false;
    try {
      const endpoint = smart ? "terminal-request" : "external-terminal-request";
      const res = await fetch(`/api/tenant/${tenantSlug}/pay/${endpoint}`, {
        method: "POST",
        signal: watch?.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, amountCents, tipCents: amountTip, ...(attemptId && { attemptId }) }),
      });
      const j = await res.json().catch(() => ({}));
      if (watch?.signal.aborted) return;
      if (!res.ok || !j.paymentId) {
        if (watch && (res.status >= 500 || res.ok)) { awaitingStatus = true; return; }
        setErr(apiError(j, j.message ?? j.error ?? t("errNotifyWaiter")));
        if (operatorMode) refreshBalance();
        return;
      }
      if (!operatorMode) {
        router.push(`/t/${tenantSlug}/pay/${orderId}/terminal?pid=${j.paymentId}${smart ? "" : "&external=1"}`);
        return;
      }
      watch?.registered(j.paymentId);
      if (j.pending === false) {
        awaitingStatus = true;
        return;
      }
      if (!smart) {
        if (mixed) { setMixedInput(null); setUseRemainder(true); }
        setFocusPayment("pending");
        refreshBalance();
        return;
      }
      if (!target) { router.push(staffServeHref); return; }
      const pushRes = await fetch(`/api/tenant/${tenantSlug}/terminal/charge`, {
        method: "POST", signal: watch?.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentId: j.paymentId, deviceId: target.id }),
      });
      if (!pushRes.ok) {
        const pj = await pushRes.json().catch(() => ({}));
        if (watch?.signal.aborted) return;
        if (pushRes.status >= 500) { awaitingStatus = true; return; }
        if (pj.status === "declined" && serialMode) serial.chargeDeclined(j.paymentId);
        else setErr(pj.status === "declined" ? t("terminalNotApproved") : apiError(pj, pj.message ?? pj.error ?? t("errPushTerminal")));
        refreshBalance();
        return;
      }
      if (!watch?.signal.aborted) {
        awaitingStatus = true;
        router.push(waitHref(j.paymentId));
      }
    } catch {
      if (watch) awaitingStatus = true;
      else { setErr(t("mixed.checkStatus")); if (!smart) refreshBalance(); }
    } finally {
      if (!watch?.signal.aborted && !awaitingStatus) {
        watch?.stop();
        setWatchedPaymentId(null);
        terminalWatch.current = null;
        setManualCancel(false);
        setBusy(null);
      }
    }
  }

  async function cancelStaffTerminal() {
    const watch = terminalWatch.current;
    if (!watch || watch.signal.aborted) return;
    setManualCancel(false);
    const declined = await watch.cancel(() => window.confirm(tAttempt("confirmCancel")));
    if (terminalWatch.current !== watch) return;
    setBusy(null);
    setTerminalUnknown(!declined);
    if (declined) setErr(t("terminalCanceledTitle"));
    void watch.check();
    router.refresh();
  }

  async function consultTerminal() {
    const watch = terminalWatch.current;
    if (!watch || consultingTerminal) return;
    setConsultingTerminal(true);
    try { await watch.consult(); }
    finally {
      setConsultingTerminal(false);
      router.refresh();
    }
  }

  const cancelTerminalButton = manualCancel && (
    <button type="button" className="min-h-11 w-full underline text-sm" onClick={cancelStaffTerminal}>
      {t("terminalCancelRetry")}
    </button>
  );

  const payWithTerminal = () => requestTerminal("kushki_card_terminal");
  const payWithExternalTerminal = () => requestTerminal("external_terminal");

  /**
   * PSE — el diner elige su banco + ingresa email/doc en el sheet.
   * Pasamos el bankCode a Kushki para que abra directamente la
   * página del banco sin paso extra. Resultado final por webhook.
   */
  async function payWithPse(args: {
    bankCode: string;
    email: string;
    docType: "CC" | "CE" | "NIT" | "PA" | "TI";
    docNumber: string;
    personType: "natural" | "juridica";
    // Token y redirectUrl vienen llenos cuando el sheet ya tokenizó
    // contra Kushki.js (sandbox/prod). En mock mode el backend tokeniza.
    token?: string;
    redirectUrl?: string;
  }) {
    if (amountCents <= 0) return;
    setBusy("kushki_pse");
    setErr(null);
    const t0 = performance.now();
    try {
      const res = await fetch(
        `/api/tenant/${tenantSlug}/pay/kushki-pse-init`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orderId,
            // amountCents = TOTAL (food + tip). Ver comentario en
            // payWithTerminal sobre por qué no mandamos food acá.
            amountCents,
            tipCents: amountTip,
            bankCode: args.bankCode,
            buyer: {
              email: args.email,
              docType: args.docType,
              docNumber: args.docNumber,
              personType: args.personType,
            },
            // Forward del token/redirect si Kushki.js ya tokenizó.
            ...(args.token ? { token: args.token } : {}),
            ...(args.redirectUrl ? { redirectUrl: args.redirectUrl } : {}),
          }),
        },
      );
      console.log(
        `[pse-timing] backend /kushki-pse-init: ${Math.round(performance.now() - t0)}ms`,
      );
      const j = await res.json().catch(() => ({}));
      if (j.pending && j.paymentId) { router.push(`/t/${tenantSlug}/pay/${orderId}/pending?pid=${encodeURIComponent(j.paymentId)}`); return; }
      if (!res.ok || !j.redirectUrl) {
        // Si Kushki devolvió detalle del error, lo concatenamos al
        // mensaje principal — sirve para debug rápido sin pedirle al
        // diner que copie de DevTools.
        const detail = typeof j.detail === "string" ? ` (${j.detail})` : "";
        // Códigos conocidos (p. ej. payment_declined: Kushki rechazó el
        // inicio de la transferencia) se traducen; nunca se muestra el
        // código crudo.
        setErr(apiError(j, j.message ?? t("errPseInit")) + detail);
        return;
      }
      // Redirigimos a Kushki PSE hosted. El cliente vuelve a
      // /pse-return cuando termina.
      window.location.href = j.redirectUrl;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Bre-B — reserva el pago y abre el QR a pantalla completa. El comensal lo
   * paga desde la app de su banco; el staff lo muestra en su dispositivo para
   * que el cliente lo escanee. El resultado llega solo (aviso de Kushki +
   * consulta de estado): la pantalla del QR lo sigue en vivo.
   *
   * La llave de idempotencia vive mientras dure el intento: un doble toque o
   * un reintento por mala red devuelven el MISMO cobro, no otro QR.
   */
  const breBAttempt = useRef<string | null>(null);
  async function payWithBreB() {
    if (chargeDisabled) return;
    setBusy("kushki_bre_b");
    setErr(null);
    setBreBNotice(null);
    if (!breBAttempt.current) breBAttempt.current = crypto.randomUUID();
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/pay/bre-b`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": breBAttempt.current },
        // amountCents = TOTAL (comida + propina), como el resto de los rieles.
        body: JSON.stringify({ orderId, amountCents, tipCents: amountTip }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.paymentId || !j.charge) {
        // Kushki respondió (o el servidor rechazó): este intento terminó.
        if (res.status < 500 || j.error) breBAttempt.current = null;
        const key = typeof j.error === "string" ? `err_${j.error}` : "";
        setErr(key && tBreB.has(key) ? tBreB(key) : apiError(j, tBreB("errStart")));
        if (operatorMode) refreshBalance();
        return;
      }
      breBAttempt.current = null;
      try { sessionStorage.setItem(breBStorageKey(orderId), j.paymentId); } catch { /* Storage is optional. */ }
      // Cuenta dividida en serie: el QR lanzado queda anotado; al aprobarse
      // avanza la parte, y si se cancela o vence queda para reintentarla.
      if (operatorMode) {
        serial.chargeLaunched({
          mode: serialMode,
          splitCount,
          method: "kushki_bre_b",
          paymentId: j.paymentId,
          guest: mode === "mine" ? myGuest || null : null,
        });
      }
      setBreB({ paymentId: j.paymentId, initial: j.charge as BreBChargeView });
    } catch {
      // Sin respuesta: se conserva la llave para que reintentar no cree otro cobro.
      setErr(tBreB("errNetwork"));
      if (operatorMode) refreshBalance();
    } finally {
      setBusy(null);
    }
  }

  function forgetBreB() {
    try { sessionStorage.removeItem(breBStorageKey(orderId)); } catch { /* Storage is optional. */ }
    setBreB(null);
  }

  // Se cerró el QR sin pago: vuelve a los medios con su aviso.
  function breBClosed(reason: BreBCloseReason) {
    forgetBreB();
    // `hidden`: el staff ocultó el código y el cobro sigue activo; lo muestra
    // el aviso de pagos pendientes, no un mensaje acá.
    setBreBNotice(reason === "hidden" ? null : reason === "dismissed" ? "uncertain" : reason);
    if (operatorMode) refreshBalance();
  }

  function breBApproved(view: BreBChargeView) {
    const paymentId = breB?.paymentId ?? view.paymentId ?? "";
    forgetBreB();
    // El staff sigue el camino de siempre (cuenta pagada → recibo; pago
    // parcial o mixto → aviso y saldo actualizado). Con la cuenta dividida
    // en serie, el aprobado avanza la parte en el acto.
    if (operatorMode) {
      serial.chargeApproved({
        mode: serialMode,
        splitCount,
        method: "kushki_bre_b",
        paymentId,
        amountCents: 0,
        paid: view.orderPaid,
        guest: mode === "mine" ? myGuest || null : null,
      });
      paymentConfirmed(view.orderPaid);
      return;
    }
    router.push(`/t/${tenantSlug}/pay/${orderId}/done?pid=${encodeURIComponent(paymentId)}`);
  }

  // Si este aparato tenía un QR abierto (recargó la página, volvió de la app
  // del banco con la pestaña descartada), se retoma en vez de dejarlo vivo
  // sin que nadie lo vea.
  useEffect(() => {
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(breBStorageKey(orderId)); } catch { return; }
    if (saved) startTransition(() => setBreB({ paymentId: saved, initial: null }));
  }, [orderId]);

  const cashAttempt = useRef<{ key: string; body: {
    orderId: string; method: "cash"; amountCents: number; tipCents: number;
    cashTenderCents?: number; changeGivenCents?: number; settleNow?: boolean;
  } } | null>(null);
  async function payWithCash(
    cashTenderCents: number | null,
    changeGivenCents: number | null = null,
    retry = false,
  ) {
    if (busy || refreshing || (!retry && chargeDisabled) || (retry && !cashAttempt.current)) return;
    setBusy("cash");
    setErr(null);
    // An uncertain response can only retry the ORIGINAL payload and key.
    // A concurrent payment must never turn that retry into a second charge.
    if (!retry) cashAttempt.current = {
      key: crypto.randomUUID(), body: {
        orderId, method: "cash", amountCents, tipCents: amountTip,
        cashTenderCents: cashTenderCents ?? undefined,
        changeGivenCents: changeGivenCents ?? undefined,
        settleNow: operatorMode || undefined,
      },
    };
    const attempt = cashAttempt.current!;
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": attempt.key },
        body: JSON.stringify(attempt.body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.paymentId) {
        const uncertain = res.status >= 500 || j.error === "operation_conflict" || j.error === "idempotency_conflict" || res.ok;
        setCashUncertain(uncertain);
        if (!uncertain) cashAttempt.current = null;
        setErr(apiError(j, t("mixed.checkStatus")));
        if (operatorMode) refreshBalance();
        return;
      }
      cashAttempt.current = null;
      setCashUncertain(false);
      if (operatorMode) {
        if (mixed) { paymentConfirmed(j.paid === true); return; }
        // El efectivo del staff queda aprobado en el acto: se anota en el
        // plan del cobro en serie y, si la cuenta NO quedó en cero, el flujo
        // se queda acá listo para la parte siguiente (paymentConfirmed sólo
        // navega a "listo" con la cuenta saldada).
        serial.chargeApproved({
          mode: serialMode,
          splitCount,
          method: "cash",
          paymentId: j.paymentId,
          amountCents: attempt.body.amountCents,
          paid: j.paid === true,
          guest: mode === "mine" ? myGuest || null : null,
        });
        paymentConfirmed(j.paid === true);
        return;
      }
      if (j.pending) router.push(`/t/${tenantSlug}/pay/${orderId}/cash?pid=${j.paymentId}`);
    } catch {
      setCashUncertain(true);
      setErr(t("mixed.checkStatus"));
      if (operatorMode) refreshBalance();
    } finally {
      setBusy(null);
    }
  }

  /**
   * Paso "Cliente": asocia la cuenta a un cliente de facturación. El server
   * aplica su descuento comercial (si lo tiene) con el mecanismo del
   * descuento por comensal y devuelve la deuda de crédito. Si cambió lo
   * cobrable, se relee la pantalla (los totales vienen del server).
   */
  async function linkCustomer(picked: BillingCustomerRecord) {
    setErr(null);
    setCustomerNotice(null);
    try {
      const res = await fetch(`/api/operator/orders/${orderId}/customer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ billingCustomerId: picked.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.customer) {
        setErr(apiError(j, t("customerErr_generic")));
        return;
      }
      const linked = j.customer as PayCustomer;
      const d = j.discount as DiscountOutcome | undefined;
      setCustomer(linked);
      if (d?.applied && d.changed) customerDiscountAppliedHere.current = true;
      if (d?.applied) {
        setCustomerNotice(
          t("customerDiscountApplied", {
            pct: discountBpsToPctText(linked.discountBps),
            amount: fmtCOP(d.discountCents),
            total: fmtCOP(Math.max(0, d.subtotalCents - d.discountCents)),
          }),
        );
        if (d.changed) router.refresh();
      } else if (d?.reason === "existing_greater") {
        setCustomerNotice(t("customerDiscountKept", { pct: d.discountPct ?? 0 }));
      } else if (d?.reason === "not_applicable" && linked.discountEnabled) {
        setCustomerNotice(t("customerDiscountNotApplicable"));
      }
    } catch {
      setErr(t("customerErr_generic"));
    }
  }

  /**
   * Cobro A CRÉDITO: la cuenta queda pagada para la mesa sin que entre
   * plata; lo pendiente (más la propina) pasa a ser deuda del cliente. Los
   * errores llegan como códigos (credit_disabled, credit_limit_exceeded…)
   * y se traducen acá.
   */
  async function payWithCredit(billingCustomerId: string) {
    setBusy("customer_credit");
    setErr(null);
    try {
      const res = await fetch(`/api/operator/orders/${orderId}/settle-credit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ billingCustomerId, tipCents: amountTip }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const key = typeof j.error === "string" ? `creditErr_${j.error}` : "";
        setErr(
          key && t.has(key)
            ? t(key, { available: fmtCOP(j.availableCents ?? 0) })
            : apiError(j, t("creditErr_generic")),
        );
        return;
      }
      setCreditOpen(false);
      router.push(doneHref || `/t/${tenantSlug}/pay/${orderId}/done?op=1`);
    } catch {
      setErr(t("creditErr_generic"));
    } finally {
      setBusy(null);
    }
  }

  // Gastos de representación: cerrar la cuenta como cortesía ($0) sin cobrar,
  // con nota de a quién se le dio. La mesa queda cerrada → vuelve a mesas.
  async function payWithRepresentacion(note: string) {
    setBusy("representacion");
    setErr(null);
    try {
      const res = await fetch(
        `/api/tenant/${tenantSlug}/orders/${orderId}/comp`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Códigos conocidos (p. ej. comp_not_allowed: el rol no puede no
        // cobrar) se traducen; el resto conserva el mensaje del servidor.
        setErr(apiError(j, j.message ?? j.error ?? t("errNotifyWaiter")));
        return;
      }
      setRepresentacionOpen(false);
      router.push(staffHomeHref);
    } finally {
      setBusy(null);
    }
  }

  // The "Demo pedir datáfono" button reuses payWithTerminal so the demo
  // path exercises the exact same code as production. No separate demo
  // function needed.

  if (alreadyPaid) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto flex items-center justify-center font-display text-3xl">
            {"✓"}
          </div>
          <h1 className="font-display text-3xl mt-4">{t("paidTitle")}</h1>
          <p className="text-muted mt-2">
            {t("paidBody", { name: tenantName })}
          </p>
          <Link className="mt-5 inline-flex min-h-11 items-center rounded-full bg-ink text-bone px-5 text-sm"
            href={operatorMode ? doneHref || `/t/${tenantSlug}/pay/${orderId}/done?op=1` : `/t/${tenantSlug}/pay/${orderId}/done`}>
            {t("mixed.viewReceipt")}
          </Link>
        </div>
      </main>
    );
  }

  const hasGuests = guestTotals.length > 0;
  // Nunca en el link de pago de una factura manual: el datáfono es presencial.
  const showDemoFallback = isMockMode && !kushkiReady && !payLinkMode;
  // El sello "procesado por Kushki" sólo tiene sentido si hay algún método
  // Kushki habilitado. En un checkout de sólo-efectivo mostrarlo sería
  // engañoso, así que lo escondemos.
  const hasKushki = enabledMethods.some((m) => m.startsWith("kushki"));

  return (
    <main className="flex flex-1 flex-col max-w-lg mx-auto w-full px-5 py-8">
      {operatorMode && (
        <div className="-mx-5 -mt-8 mb-5 bg-ink text-bone px-5 py-2 text-xs flex items-center justify-between gap-3">
          <span>
            <span className="font-mono tracking-wider uppercase opacity-70 mr-2">
              {t(terminalMode ? "terminalMode" : "waiterMode")}
            </span>
            {t.rich("chargingAt", {
              location: locationLabel,
              b: (chunks) => <strong>{chunks}</strong>,
            })}
          </span>
          <Link
            href={staffHomeHref}
            className="font-mono text-[10px] tracking-wider uppercase underline opacity-80"
          >
            {t("backToTables")}
          </Link>
        </div>
      )}
      {/* En modo mesero el banner negro ya tiene "Volver a mesas".
          El cliente que paga desde su QR sí necesita un link de
          volver al pedido — lo mostramos solo para ese caso. */}
      {!operatorMode && !payLinkMode && (
        <Link
          href={`/t/${tenantSlug}/order/${orderId}`}
          className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink mb-5 -ml-1"
        >
          <span aria-hidden>←</span>
          <span>{t("backToOrder")}</span>
        </Link>
      )}
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted" title={shortCode}>
        {locationLabel} · {tenantName} · {displayOrderCode(shortCode)}
      </div>
      <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">
        {operatorMode ? t("charge") : t("pay")}
      </h1>
      {/* «Revisar»: la cuenta puede ser de otro grupo (descuento de un
          cliente puesto antes, cobro rechazado, rondas tras horas). Antes de
          cobrar. El datáfono sólo lo ve: decide el mesero o la caja. */}
      {operatorMode && review && (
        <OrderReviewBanner
          className="mt-4"
          orderId={orderId}
          review={review}
          canAct={!terminalMode}
          onChanged={() => router.refresh()}
        />
      )}

      {/* Lo que el comensal ya pidió para pagar, antes que cualquier método:
          confirmarlo cierra el cobro; cobrar de otra forma lo reemplaza. */}
      {operatorMode && pendingPayments.length > 0 && (
        <div className="mt-5 focus:outline-none" ref={pendingRef} tabIndex={-1}>
          <PendingPaymentNotice
            currency={currency}
            pendings={pendingPayments}
            order={{ shortCode, tableNumber }}
            orderId={orderId}
            serviceMode={serviceMode}
            onConfirmed={({ paid }) => paymentConfirmed(paid)}
            onRefresh={refreshBalance}
            // También en el cobro en serie: «No se recibió este pago» declina
            // la solicitud y la reconciliación ofrece reintentar ESA parte.
            onDeclined={mixed || serialMode ? () => { setFocusPayment("summary"); refreshBalance(); } : undefined}
            onCancelled={refreshBalance}
            canResolveTerminal={canResolveTerminal}
            disabled={interactionLocked}
            tenantSlug={tenantSlug}
            terminalDeviceId={terminalChoice.selected?.id ?? null}
          />
        </div>
      )}

      {/* Avance del cobro EN SERIE (cuenta dividida del staff): «Pago k de n
          aprobado · Pagado $X · Faltan $Y», con «Cobrar siguiente» que repite
          el método anterior con el monto de la parte que sigue. */}
      {operatorMode && !payLinkMode && !mixed && (
        <SerialChargeCard
          plan={serial.plan}
          event={serial.event}
          paidFoodCents={paidFoodCents}
          outstandingFoodCents={outstandingSubtotalCents}
          nextAmountCents={amountCents}
          currency={currency}
          repeatMethod={serialRepeatMethod}
          chargeBusy={interactionLocked}
          onChargeNext={serialChargeNext}
          onDismiss={serial.dismissEvent}
        />
      )}

      {/* Resumen del pedido — solo en modo mesero. El mesero le pasa
          el celular al cliente para que confirme que todo lo que
          ordenó está bien antes de seleccionar método de pago. Si
          algo no cuadra el cliente lo dice y el mesero vuelve a
          /mesero/salon a cancelar/ajustar. */}
      {operatorMode && items.length > 0 && (
        <section className="mt-5 rounded-2xl border border-hairline bg-paper overflow-hidden">
          <div className="bg-ivory px-4 py-2.5 border-b border-hairline">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {t("confirmOrder")}
            </div>
          </div>
          <ul className="divide-y divide-hairline/60">
            {items.map((i) => (
              <li
                key={i.id}
                className="flex items-baseline gap-3 px-4 py-2.5 text-sm"
              >
                <span className="font-mono tabular text-muted shrink-0 w-7">
                  {i.qty}×
                </span>
                <span className="flex-1 min-w-0">{i.name}</span>
                <span className="font-mono tabular shrink-0">
                  {fmtCOP(i.priceCents * i.qty)}
                </span>
              </li>
            ))}
          </ul>
          <div className="px-4 py-2.5 bg-ivory border-t border-hairline">
            {discountCents > 0 && (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                    {t("subtotal")}
                  </span>
                  <span className="font-mono text-sm tabular text-muted">
                    {fmtCOP(grossSubtotalCents)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-terracotta">
                    {discountLabel}
                  </span>
                  <span className="font-mono text-sm tabular text-terracotta">
                    {"− " + fmtCOP(discountCents)}
                  </span>
                </div>
              </>
            )}
            <div className="flex items-baseline justify-between mt-1">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                {discountCents > 0 ? t("discountedTotal") : t("subtotal")}
              </span>
              <span className="font-display text-lg tabular">
                {fmtCOP(subtotalCents)}
              </span>
            </div>
          </div>
          {/* No mostramos "Ya pagado" aquí — esta sección es para que
              el cliente confirme que el menú coincide con lo que pidió.
              El estado de pagos vive abajo en el breakdown del cobro,
              con la convención correcta (solo comida, sin propinas). */}
        </section>
      )}

      {/* Selector de modo de pago (Todo / Partes iguales / Lo mío) — la
          MISMA grilla de 3 modos para el comensal y para el mesero
          (operatorMode). El default es Todo; el mesero puede partir la
          cuenta igual que el comensal. */}
      {/* Banner de error cuando el diner viene de un cobro rechazado.
          Se descarta automáticamente cuando intenta otro método (los
          handlers limpian err en el setBusy) o cuando toca el botón
          de cerrar. Sale de la URL en la primera interacción. */}
      {declinedFlag && !err && (
        <div className="mt-4 rounded-2xl border border-danger/30 bg-danger/5 p-4 flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-danger/15 text-danger flex items-center justify-center shrink-0 font-display">
            {"✕"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display text-base text-danger">
              {declinedReason === "terminal_canceled" ? t("terminalCanceledTitle") : t("declinedTitle")}
            </div>
            <p className="text-xs text-muted mt-1">
              {declinedReason === "terminal_canceled"
                ? t("terminalCanceledBody")
                : (declineText(declineCode) ?? t("declinedBody"))}
            </p>
          </div>
        </div>
      )}

      {paymentNotice && <p role="status" className="mt-4 rounded-xl bg-ok/10 p-3 text-sm text-ok">{t("mixed.receivedNotice")}</p>}
      {/* Volvió del QR Bre-B sin pago: por qué, y que no se cobró nada. */}
      {breBNotice && !err && (
        <div
          role="status"
          className={
            "mt-4 rounded-2xl border p-4 text-sm " +
            (breBNotice === "uncertain"
              ? "border-terracotta/40 bg-terracotta/10"
              : "border-hairline bg-paper text-muted")
          }
        >
          {tBreB(operatorMode && breBNotice === "uncertain" ? "notice.uncertainOp" : `notice.${breBNotice}`)}
        </div>
      )}
      {(!isCounter || operatorMode) && !payLinkMode && (
        <div className="mt-6">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {operatorMode ? t("howToCharge") : t("howToPay")}
          </div>
          <div className={operatorMode ? "grid gap-2 grid-cols-2" : "grid gap-2 grid-cols-3"}>
            <ModeButton
              active={mode === "full"}
              label={t("modeFull")}
              hint={t("modeFullHint")}
              onClick={() => selectMode("full")}
              disabled={interactionLocked || (mixed && pendingBlocksMixed)}
            />
            {!isCounter && <ModeButton
              active={mode === "equal"}
              label={t("modeEqual")}
              hint={t("modeEqualHint")}
              onClick={() => selectMode("equal")}
              disabled={interactionLocked || (mixed && pendingBlocksMixed)}
            />}
            {!isCounter && <ModeButton
              active={mode === "mine"}
              label={t(operatorMode ? "modeMineOp" : "modeMine")}
              hint={t(operatorMode ? "modeMineHintOp" : "modeMineHint")}
              onClick={() => hasGuests && selectMode("mine")}
              disabled={!hasGuests || interactionLocked || (mixed && pendingBlocksMixed)}
            />}
            {operatorMode && <ModeButton active={mixed} label={t("mixed.title")} hint={t("mixed.hint")}
              onClick={() => selectMode("mixed")} disabled={interactionLocked} />}
          </div>
          {mode === "mine" && !hasGuests && (
            <div className="mt-2 text-xs text-muted-2">{t("noGuestsHint")}</div>
          )}
        </div>
      )}

      {mixed && <div ref={summaryRef} tabIndex={-1} className="focus:outline-none"><MixedPaymentPanel budget={mixedBudget} allocation={mixedAllocation} value={mixedValue}
        onChange={value => { setMixedInput({ balance: balanceKey, value }); setErr(null); }}
        onRemaining={() => { setMixedInput(null); setUseRemainder(true); }}
        payments={approvedPayments} disabled={interactionLocked} pending={pendingBlocksMixed} inFlight={pendingPayments.some(p => !p.replaceable)} currency={currency} /></div>}

      {mode === "equal" && (
        <div className="mt-4 bg-paper border border-hairline rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="text-sm">{t("splitBetween")}</div>
            <div className="flex items-center gap-2">
              <button
                // Con partes ya cobradas, no se puede bajar de lo cobrado + 1.
                onClick={() => setSplitCount((n) => Math.max(minSplitCount, n - 1))}
                className="w-8 h-8 rounded-full border border-hairline"
              >
                −
              </button>
              <div className="font-mono w-6 text-center tabular">{splitCount}</div>
              <button
                onClick={() => setSplitCount((n) => Math.min(20, n + 1))}
                className="w-8 h-8 rounded-full border border-hairline"
              >
                +
              </button>
              <span className="text-sm text-muted ml-1">{t("people")}</span>
            </div>
          </div>
          {operatorMode && serialPartsDone > 0 && (
            <p className="mt-1.5 text-xs text-muted" data-testid="serial-part-progress">
              {t("serial.partProgress", {
                k: Math.min(serialPartsDone + 1, splitCount),
                n: splitCount,
              })}
            </p>
          )}
        </div>
      )}

      {mode === "mine" && hasGuests && (
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {t("whoAreYou")}
          </div>
          <div className="flex gap-2 flex-wrap">
            {guestTotals.map((g) => {
              const active = g.name === myGuest;
              // Cobro en serie del staff: el comensal ya cobrado queda
              // marcado y no se vuelve a elegir (no se le cobra dos veces).
              const paid = serialGuestsPaid.includes(g.name);
              return (
                <button
                  key={g.name}
                  onClick={() => !paid && setMyGuest(g.name)}
                  disabled={paid}
                  className={
                    "h-10 px-4 rounded-full text-sm border inline-flex items-center gap-2 " +
                    (paid
                      ? "bg-ivory text-muted border-hairline line-through"
                      : active
                        ? "bg-ink text-bone border-ink"
                        : "bg-paper text-ink border-hairline")
                  }
                >
                  <span>{g.name}</span>
                  <span
                    className={
                      "font-mono tabular text-xs " +
                      (active && !paid ? "opacity-70" : "text-muted")
                    }
                  >
                    {paid ? t("serial.guestPaid") : fmtCOP(g.cents)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-6 bg-paper rounded-2xl border border-hairline p-5">
        {discountCents > 0 && (
          <Row
            label={discountLabel}
            value={"− " + fmtCOP(discountCents)}
            muted
          />
        )}
        <Row
          label={t(operatorMode ? "rowYourBillOp" : "rowYourBill")}
          value={fmtCOP(subtotalCents)}
        />
        {paidFoodCents > 0 && (
          <>
            <Row
              label={t("rowPaidFood")}
              value={"− " + (mixed ? exactMoney(paidFoodCents) : fmtCOP(paidFoodCents))}
              muted
            />
            <Row
              label={t("rowOwedFood")}
              value={mixed ? exactMoney(outstandingSubtotalCents) : fmtCOP(outstandingSubtotalCents)}
              accent
            />
          </>
        )}
        {/* La fila "A cobrar / Tu parte" solo aporta info cuando el
            monto difiere del "Falta de comida" (i.e. modo Partes
            iguales o Lo mío). Si es modo Todo y coincide, esconderla
            evita el "$30.550 / $30.550" duplicado que confundía. */}
        {amountSubtotal !== outstandingSubtotalCents && (
          <Row
            label={
              mixed ? t("mixed.foodPart") : operatorMode
                ? t("rowToChargeN", { k: Math.min(serialPartsDone + 1, splitCount), n: splitCount })
                : mode === "equal"
                  ? t("rowYourPartN", { n: splitCount })
                  : t("rowOf", { name: myGuest || t("you") })
            }
            value={mixed ? exactMoney(amountSubtotal) : fmtCOP(amountSubtotal)}
            accent
          />
        )}
        {/* Impuesto que ya viene DENTRO de lo que se está pagando. Es
            informativo: el precio de la carta lo incluye y el total no
            cambia — por eso va en chico y apagado, no como fila de la
            cuenta. Con el comercio sin impuesto no se pinta nada. */}
        {taxLine && (
          <div className="mt-1 flex items-center justify-between text-xs text-muted-2">
            <span>
              {taxLine.kind === "inc"
                ? tCommon("taxIncludedInc", { pct: taxLine.pct })
                : tCommon("taxIncludedIva", { pct: taxLine.pct })}
            </span>
            <span className="font-mono tabular">{fmtCOP(taxLine.taxCents)}</span>
          </div>
        )}
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {mixed ? t("mixed.accountTip") : operatorMode ? t("tipOp") : t("tipDiner")}
          </div>
          <div className="flex gap-2 flex-wrap">
            {TIP_OPTIONS.map((p) => (
              <button
                key={p}
                onClick={() => chooseTip(p)}
                disabled={interactionLocked || (mixed && pendingBlocksMixed)}
                className={
                  "h-9 px-3 rounded-full text-sm border " +
                  (tipPct === p
                    ? "bg-ink text-bone border-ink"
                    : "bg-ivory border-hairline text-ink")
                }
              >
                {p === 0 ? t("noTip") : `${p}%`}
              </button>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-sm text-muted">
            <span>{t("tipLine", { pct: tipPct })}</span>
            <span className="font-mono tabular">{mixed ? exactMoney(amountTip) : fmtCOP(amountTip)}</span>
          </div>
          {tipBaseNote !== null && (
            <p className="mt-1 text-xs text-muted-2" data-testid="tip-base-note">
              {t("tipBaseNote", { base: mixed ? exactMoney(tipBaseNote) : fmtCOP(tipBaseNote) })}
            </p>
          )}
        </div>
        <div className="mt-4 pt-4 border-t border-hairline">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {operatorMode ? t("totalToChargeNow") : t("totalToPay")}
            </span>
            <span className="font-display text-3xl">{mixed ? exactMoney(amountCents) : fmtCOP(amountCents)}</span>
          </div>
          <div className="mt-1 text-xs text-muted-2">
            {t("totalBreakdown", {
              subtotal: mixed ? exactMoney(amountSubtotal) : fmtCOP(amountSubtotal),
              tip: mixed ? exactMoney(amountTip) : fmtCOP(amountTip),
            })}
          </div>
        </div>
      </div>

      {err && <div className="mt-4 text-danger text-sm" role="alert">{err}</div>}
      {operatorMode && terminalUnknown && <div role="status" className="mt-4 space-y-2 text-sm">
        <p>{t("terminalUnknown")}</p>
        <button type="button" className="min-h-11 underline" disabled={consultingTerminal} onClick={consultTerminal}>{tBreB(consultingTerminal ? "checking" : "checkStatus")}</button>
      </div>}
      {cashUncertain && <div className="mt-3 rounded-xl border border-hairline p-4 space-y-3">
        <p className="text-sm text-muted">{t("mixed.retryHint")}</p>
        <button type="button" onClick={() => payWithCash(null, null, true)} disabled={busy !== null || refreshing}
          className="min-h-11 px-4 rounded-full bg-ink text-bone text-sm disabled:opacity-50">{t("mixed.retry")}</button>
      </div>}

      {/* Cliente (staff): asociar la cuenta a un cliente registrado aplica su
          descuento y deja listo el cobro a crédito. Opcional. */}
      {operatorMode && customerStepEnabled && !alreadyPaid && (
        <CustomerCard
          customer={customer}
          notice={customerNotice}
          disabled={interactionLocked || (mixed && pendingBlocksMixed)}
          currency={currency}
          onPick={linkCustomer}
        />
      )}

      {/* Bono empresarial: se aplica ANTES de elegir el medio para el resto.
          El bono paga comida (nunca propina): cubre lo pendiente hasta su
          saldo; lo que falte se paga con cualquier otro medio y el saldo
          que sobre queda para otra visita. */}
      {vouchersEnabled && !alreadyPaid && outstandingSubtotalCents > 0 && (
        <VoucherCard
          tenantSlug={tenantSlug}
          orderId={orderId}
          operatorMode={operatorMode}
          disabled={interactionLocked || (mixed && pendingBlocksMixed)}
          onApplied={(fullyPaid) => {
            if (fullyPaid) {
              router.push(
                operatorMode
                  ? doneHref || `/t/${tenantSlug}/pay/${orderId}/done?op=1`
                  : `/t/${tenantSlug}/pay/${orderId}/done`,
              );
            } else {
              router.refresh();
            }
          }}
        />
      )}

      {/* La factura se pide ACÁ, antes de confirmar el pago: es el momento en
          que el comensal todavía tiene el celular en la mano. Los datos se
          guardan al instante; la factura se emite cuando el cobro se confirma
          (puede ser minutos después si paga en efectivo). */}
      {preInvoice ? (
        // La factura YA está emitida (antes de cobrar): no se vuelve a
        // preguntar. El staff la ve con su estado y la reimprime; el
        // comensal sólo sabe que existe.
        operatorMode ? (
          <div className="mt-6">
            <InvoicedOrderBanner
              orderId={orderId}
              invoice={preInvoice}
              chargingDevices={[
                ...((busy === "kushki_card_terminal" || terminalUnknown) && lastTerminalRequest?.deviceId ? [lastTerminalRequest.deviceId] : []),
                ...pendingPayments.flatMap(p => p.terminalAttempt?.deviceId ? [p.terminalAttempt.deviceId] : []),
              ]}
              compact
              sameTab={printSameTab}
              canConfigurePrinters={canConfigurePrinters}
              canAnnul={canAnnulInvoice}
            />
          </div>
        ) : (
          <p className="mt-6 rounded-2xl border border-hairline bg-paper p-4 text-sm">
            {tPre("dinerInvoiced", { number: preInvoice.documentNumber })}
          </p>
        )
      ) : (
        <>
          <InvoiceCheckoutCard
            tenantSlug={tenantSlug}
            orderId={orderId}
            initialIntent={checkoutIntent}
            prefillEmail={invoicePrefillEmail}
            operatorMode={operatorMode}
            onIntentChange={setCheckoutIntent}
          />
          {/* Factura ANTES de cobrar: el cliente la pide y todavía no dijo
              cómo va a pagar. Se emite ya, sin método de pago; después se
              cobra con lo que sea. */}
          {operatorMode && preInvoiceEnabled && !alreadyPaid && !payLinkMode && outstandingSubtotalCents > 0 && (
            <div className="mt-3">
              <PreInvoiceAction
                key={invoiceIntentKey}
                orderId={orderId}
                tenantSlug={tenantSlug}
                totalLabel={formatMoney(outstandingSubtotalCents, { currency, locale })}
                initialIntent={checkoutIntent}
                prefillEmail={invoicePrefillEmail}
                sameTab={printSameTab}
                canConfigurePrinters={canConfigurePrinters}
                onIssued={() => router.refresh()}
                // La propina elegida arriba: con «Sin propina» la factura
                // no sugiere ninguna en ninguna de sus representaciones.
                suggestedTipPct={tipPct}
                manualInvoice={manualInvoice}
                className="w-full h-11 rounded-full border border-hairline bg-paper text-ink text-sm font-medium"
              />
            </div>
          )}
        </>
      )}

      <div className="mt-6 space-y-2">
        {/* Link de pago: un solo rótulo arriba; el preseleccionado va primero
            y lleno, y debajo de él "Otras formas de pago" separa el resto. */}
        {payLinkMode && linkMethods.length > 0 && (
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {t("linkPayWith")}
          </div>
        )}
        {/* Apple Pay requires the diner's own iPhone — the waiter can't
            tap their own watch / Touch ID for someone else's card. So
            in waiter mode we hide it entirely; the operator collects
            via datáfono o efectivo. En live mode usamos el componente
            ApplePayButton que renderiza el botón nativo de Apple vía
            el SDK de Kushki. En mock mode caemos al PayButton custom
            con token fake para que el wizard se pueda probar sin
            credenciales reales. */}
        {kushkiReady &&
          !operatorMode &&
          enabledMethods.includes("kushki_apple_pay") && (
            <>
              {!isMockMode && kushkiPublicKey && (
                <ApplePayButton
                  publicKey={kushkiPublicKey}
                  kushkiMode={kushkiMode}
                  currency={currency}
                  amountCents={amountCents}
                  displayName={tenantName}
                  busy={busy === "kushki_apple_pay"}
                  onTokenized={payWithApplePayToken}
                  onReadyChange={payLinkMode ? setApplePayReady : undefined}
                />
              )}
              {(isMockMode || !kushkiPublicKey) && hasApplePay && (
                <PayButton currency={currency}
                  kind="apple"
                  disabled={chargeDisabled}
                  busy={busy === "kushki_apple_pay"}
                  onClick={payWithApplePayMock}
                  amountCents={amountCents}
                  operatorMode={operatorMode}
                  emphasis={linkEmphasis("kushki_apple_pay")}
                />
              )}
              {payLinkMode && linkPrimary === "kushki_apple_pay" && linkMethods.length > 1 && (
                <AltMethodsLabel />
              )}
            </>
          )}
        {kushkiReady && !payLinkMode && enabledMethods.includes("kushki_card_terminal") && kushkiTerminalAvailable && (
          <div className="space-y-2">
            <PayButton currency={currency}
              kind="terminal"
              disabled={terminalDisabled("kushki_card_terminal") || (operatorMode && terminalChoice.needsPicker && !terminalChoice.selected)}
              busy={busy === "kushki_card_terminal"}
              onClick={payWithTerminal}
              amountCents={amountCents}
              operatorMode={operatorMode}
            />
            {operatorMode && busy === "kushki_card_terminal" && (
              <p role="status" className="text-sm text-muted">{t("terminalAwaitCard")}</p>
            )}
            {busy === "kushki_card_terminal" && cancelTerminalButton}
            {operatorMode && (
              <TerminalPicker
                variant="pay"
                devices={terminalDevices}
                selectedId={terminalChoice.selected?.id ?? null}
                onChoose={terminalChoice.choose}
                disabled={busy !== null}
              />
            )}
          </div>
        )}
        {kushkiReady &&
          enabledMethods.includes("kushki_card") &&
          !operatorMode && (
            <>
              <PayButton currency={currency}
                kind="card"
                disabled={chargeDisabled}
                busy={busy === "kushki_card"}
                onClick={() => setCardSheetOpen(true)}
                amountCents={amountCents}
                operatorMode={operatorMode}
                emphasis={linkEmphasis("kushki_card")}
              />
              {payLinkMode && linkPrimary === "kushki_card" && linkMethods.length > 1 && (
                <AltMethodsLabel />
              )}
            </>
          )}
        {enabledMethods.includes("external_terminal") && !payLinkMode && (
          <>
            <PayButton currency={currency}
              kind="external_terminal"
              disabled={terminalDisabled("external_terminal")}
              busy={busy === "external_terminal"}
              onClick={payWithExternalTerminal}
              amountCents={amountCents}
              operatorMode={operatorMode}
            />
            {busy === "external_terminal" && cancelTerminalButton}
          </>
        )}
        {kushkiReady &&
          enabledMethods.includes("kushki_pse") &&
          !operatorMode && (
            <PayButton currency={currency}
              kind="pse"
              disabled={chargeDisabled}
              busy={busy === "kushki_pse"}
              onClick={() => setPseSheetOpen(true)}
              amountCents={amountCents}
              operatorMode={operatorMode}
              emphasis={linkEmphasis("kushki_pse")}
            />
          )}
        {/* Bre-B cobra con las llaves de SU comercio de Kushki: no depende de
            que tarjeta/PSE estén activos (`kushkiReady`). Sólo pesos. */}
        {enabledMethods.includes("kushki_bre_b") && currency === "COP" && (
          <PayButton currency={currency}
            kind="bre_b"
            disabled={chargeDisabled}
            busy={busy === "kushki_bre_b"}
            onClick={payWithBreB}
            amountCents={amountCents}
            operatorMode={operatorMode}
            emphasis={linkEmphasis("kushki_bre_b")}
          />
        )}
        {enabledMethods.includes("cash") && !payLinkMode && (
          <PayButton currency={currency}
            kind="cash"
            disabled={chargeDisabled}
            busy={busy === "cash"}
            // Both diner + operator open a sheet first. Diner sheet:
            // "¿con cuánto vas a pagar?" so the mesero brings the
            // right change. Operator sheet: tender + vuelto + keep-
            // the-change tip captured in one go so we settle in a
            // single click.
            onClick={() => setCashTenderOpen(true)}
            amountCents={amountCents}
            operatorMode={operatorMode}
          />
        )}
        {operatorMode && !mixed && creditEnabled && (
          <div>
            <PayButton currency={currency}
              kind="credit"
              disabled={busy !== null || outstandingSubtotalCents <= 0}
              busy={busy === "customer_credit"}
              onClick={() => {
                setErr(null);
                setCreditOpen(true);
              }}
              amountCents={outstandingSubtotalCents + amountTip}
              operatorMode={operatorMode}
            />
            <p className="text-[11px] text-muted-2 text-center pt-1">{t("creditNote")}</p>
          </div>
        )}
        {operatorMode && compAdminRequired && (
          <p className="text-xs leading-relaxed text-muted text-center">
            {t("preparedCancellationAdminOnly")}
          </p>
        )}
        {/* Cuenta facturada (factura antes de cobrar): no se regala una venta
            facturada; sólo con la factura anulada por nota crédito (el
            cliente se fue sin pagar). El servidor lo exige igual. */}
        {operatorMode && !mixed && compEnabled && (!preInvoice || preInvoice.annulled) && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setRepresentacionOpen(true)}
            className="w-full min-h-[52px] rounded-2xl border border-dashed border-hairline bg-paper text-sm font-medium text-muted hover:text-ink disabled:opacity-40 transition-colors"
          >
            {compLabel?.trim() || t("representacion")}
          </button>
        )}
        {showDemoFallback && enabledMethods.includes("kushki_card_terminal") && kushkiTerminalAvailable && (
          <>
            {/* Same flow as the real "Tarjeta con datáfono" button — useful
                for previewing the customer's "esperando datáfono" screen
                without having to activate pagos para el restaurante. */}
            <PayButton currency={currency}
              kind="demo_terminal"
              disabled={terminalDisabled("kushki_card_terminal") || (operatorMode && terminalChoice.needsPicker && !terminalChoice.selected)}
              busy={busy === "kushki_card_terminal"}
              onClick={payWithTerminal}
              operatorMode={operatorMode}
              amountCents={amountCents}
            />
            {operatorMode && busy === "kushki_card_terminal" && (
              <p role="status" className="text-sm text-muted">{t("terminalAwaitCard")}</p>
            )}
            {busy === "kushki_card_terminal" && cancelTerminalButton}
            {operatorMode && (
              <TerminalPicker
                variant="pay"
                devices={terminalDevices}
                selectedId={terminalChoice.selected?.id ?? null}
                onChoose={terminalChoice.choose}
                disabled={busy !== null}
              />
            )}
            <p className="text-[11px] text-muted-2 text-center pt-1">
              {operatorMode ? t("demoHintOp") : t("demoHintDiner")}
            </p>
          </>
        )}
      </div>

      {hasKushki && <KushkiBadge />}

      {cashTenderOpen && !operatorMode && (
        <CashTenderSheet
          amountCents={amountCents}
          busy={busy === "cash"}
          onClose={() => setCashTenderOpen(false)}
          onPay={(tender) => {
            setCashTenderOpen(false);
            payWithCash(tender);
          }}
        />
      )}
      {cashTenderOpen && operatorMode && (
        <OperatorCashSheet
          amountCents={amountCents}
          busy={busy === "cash"}
          onClose={() => setCashTenderOpen(false)}
          onConfirm={({ tenderCents, changeGivenCents }) => {
            setCashTenderOpen(false);
            payWithCash(tenderCents, changeGivenCents);
          }}
        />
      )}
      {creditOpen && (
        <CreditSheet
          initialCustomer={customer}
          subtotalCents={outstandingSubtotalCents}
          tipCents={amountTip}
          busy={busy === "customer_credit"}
          error={err}
          currency={currency}
          onClose={() => {
            setCreditOpen(false);
            setErr(null);
          }}
          onPick={linkCustomer}
          onConfirm={payWithCredit}
        />
      )}
      {representacionOpen && (
        <RepresentacionSheet
          title={compLabel?.trim() || t("representacion")}
          amountCents={amountCents}
          busy={busy === "representacion"}
          onClose={() => setRepresentacionOpen(false)}
          onConfirm={(note) => payWithRepresentacion(note)}
        />
      )}
      {breB && (
        <BreBSheet
          // Un código nuevo es otro pago: pantalla nueva, estado nuevo.
          key={breB.paymentId}
          source={{ kind: "payment", tenantSlug, paymentId: breB.paymentId }}
          initial={breB.initial}
          operatorMode={operatorMode}
          onApproved={breBApproved}
          onClosed={breBClosed}
          onRetry={() => {
            forgetBreB();
            void payWithBreB();
          }}
        />
      )}
      {pseSheetOpen && (
        <PseSheet
          tenantSlug={tenantSlug}
          amountCents={amountCents}
          busy={busy === "kushki_pse"}
          kushkiPublicKey={kushkiPublicKey}
          kushkiMode={kushkiMode}
          initialBanks={pseBanks}
          onClose={() => setPseSheetOpen(false)}
          onPay={(args) => {
            setPseSheetOpen(false);
            payWithPse(args);
          }}
        />
      )}
      {cardSheetOpen && (
        <CardSheet
          amountCents={amountCents}
          tipCents={amountTip}
          tenantSlug={tenantSlug}
          orderId={orderId}
          busy={busy === "kushki_card"}
          kushkiPublicKey={kushkiPublicKey}
          kushkiMode={kushkiMode}
          currency={currency}
          card3ds={card3ds}
          onClose={() => setCardSheetOpen(false)}
          onTokenized={(token) => {
            setCardSheetOpen(false);
            payWithCardToken(token);
          }}
        />
      )}
    </main>
  );
}

/**
 * Sello "procesado por Kushki" al pie del checkout. El comercio nos entregó
 * el logo en versión blanca; como la página de cobro es clara, montamos el
 * wordmark sobre una pastilla en el azul de marca de Kushki (#023365) para
 * que quede visible y se lea como un sello de pago seguro intencional.
 * El SVG va inline con fill="currentColor" (en vez de un <img>) para que la
 * pastilla controle el color y no gatillar la regla @next/next/no-img-element.
 */
function KushkiBadge() {
  return (
    <div className="mt-8 flex justify-center">
      <span
        className="inline-flex items-center rounded-full bg-[#023365] px-3.5 py-1.5"
        aria-label="Kushki"
      >
        <svg
          viewBox="0 0 1273.1 304"
          role="img"
          aria-hidden
          fill="currentColor"
          className="h-3.5 w-auto text-white"
        >
          <path d="M685.7,95.3v73.4c0,18.9-6.5,34.9-19.3,47.2-12.4,12-26.9,18.2-44,18.2s-34.5-6.2-47.2-18.9c-12.7-12.4-18.9-27.6-18.9-45.8v-78.2c0-6.5,1.8-11.3,5.5-14.9,3.4-3.5,8.2-5.5,13.1-5.5,4.8,0,9.4,1.7,12.7,5.1,3.6,4,5.4,9.1,5.5,15.3v78.5c0,8.4,2.5,15.3,8,20.7,5.5,5.5,13,8.5,20.7,8.4,6.9,0,13.5-2.6,18.5-7.3,5.8-5.8,8.7-13.1,8.7-22.5v-77.8c0-6.5,1.8-11.3,5.1-14.9,3.4-3.5,8.2-5.5,13.1-5.5,7.3,0,12.7,2.9,16,9.1,1.8,2.9,2.6,8,2.6,15.3Z" />
          <path d="M788.2,69.9c14.5,0,26.5,3.3,36.7,9.5,9.1,6.2,13.8,12.7,13.8,20s-1.5,10.5-4.7,13.8c-3,3.2-7.3,4.9-11.6,4.7-3.1-.2-6-1.3-8.4-3.3-2.9-2.2-5.8-4.4-8.4-6.5-6.5-5.1-12.7-7.6-18.2-7.6s-9.8,1.5-13.1,4.4c-3.3,2.4-5.2,6.2-5.1,10.2,0,7.3,6.5,12.4,19.6,15.6,20.4,5.1,34.5,10.9,42.9,17.8,10.2,8,15.3,19.6,15.3,34.5s-5.5,27.3-16,37.1-24.4,14.5-40.7,14.5-32-4-44-12.4c-10.9-7.6-16.7-16.4-16.7-26.2s1.5-9.1,5.1-12.4c3-3.5,7.4-5.5,12-5.5,5.8,0,12,3.3,19.3,9.5,9.1,8,17.4,12.4,24.7,12.4,5.2.2,10.3-1.7,14.2-5.1,3.6-3.3,5.5-7.6,5.5-13.1,0-5.8-3.3-10.2-9.8-13.1-2.2-1.1-10.2-4-24.7-8-14.5-4.4-24.7-9.1-30.9-14.5-7.6-6.5-11.3-16-11.3-28s5.1-25.8,15.3-34.5c9.8-9.4,22.9-13.8,39.3-13.8Z" />
          <path d="M925.3,91.3v42.5h59.2v-42.5c0-6.5,1.8-11.3,5.4-14.9,3.5-3.6,8.4-5.6,13.4-5.5,5.4,0,9.8,1.8,13.1,5.5,3.6,3.6,5.1,8.7,5.1,14.9v121.8c0,6.5-1.8,11.3-5.4,14.9-7.2,7.2-18.8,7.3-26,.1,0,0,0,0-.1-.1-3.6-3.6-5.5-8.7-5.4-15.3v-45.4h-59.2v45.4c0,6.5-1.8,11.3-5.4,15.3-7.2,7.2-18.8,7.3-26,.1,0,0,0,0-.1-.1-3.6-3.6-5.5-8.7-5.5-14.9v-121.8c0-6.5,1.8-11.3,5.5-14.9,3.4-3.5,8.2-5.5,13.1-5.5,4.8,0,9.3,1.7,12.7,5.1,4,3.7,5.8,8.8,5.8,15.3Z" />
          <path d="M1185.9,105.1l-45.8,44.7,52.3,48.3c6.9,6.5,10.2,12.4,10.2,17.5.1,4.8-1.9,9.5-5.4,12.7-3.6,3.3-8.2,5.1-13.1,5.1-5.1,0-10.5-2.9-16.7-8.7l-61.1-57.4v45.8c0,6.5-1.8,11.3-5.4,15.3-7.2,7.2-18.8,7.3-26.1.1,0,0,0,0-.1-.1-3.6-3.6-5.4-8.7-5.4-15.3v-122.1c0-6.5,1.8-11.6,5.4-15.3,3.4-3.6,8.2-5.5,13.1-5.5,4.8,0,9.3,1.7,12.7,5.1,3.6,4,5.4,9.1,5.4,15.6v42.2l53.4-53.8c6.2-6.2,12-9.5,17.1-9.5,4.8,0,9.4,1.7,12.7,5.1,3.4,3.3,5.3,7.9,5.1,12.7,1.1,5.4-2.2,11.3-8.4,17.4Z" />
          <path d="M1236.4,213.1v-121.8c0-6.5,1.8-11.3,5.4-14.9,3.4-3.5,8.2-5.5,13.1-5.5,4.8,0,9.3,1.7,12.7,5.1,3.6,4,5.4,9.1,5.4,15.3v121.8c0,6.5-1.8,11.3-5.4,14.9-7.2,7.2-18.8,7.3-26,.1,0,0,0,0-.1-.1-3.3-3.6-5.1-8.7-5.1-14.9Z" />
          <path d="M377.5,232c-10.2,0-18.5-8.3-18.5-18.5v-122.5c-.2-10.2,7.9-18.7,18.1-19,10.2-.2,18.7,7.9,19,18.1,0,.3,0,.6,0,.9v122.9c0,10.1-8.3,18.2-18.4,18.2,0,0,0,0-.1,0Z" />
          <path d="M547.2,290.9c-4.7,0-9.3-1.9-12.7-5.1l-126.9-122.5c-7.3-6.9-7.6-18.5-.7-25.8l62.5-65.4c6.9-7.5,18.6-8,26.2-1.1s8,18.6,1.1,26.2c-.1.1-.2.2-.3.3l-49.8,52,113.8,109.8c7.3,7.1,7.5,18.7.5,26.1,0,0,0,0,0,0-3.6,3.5-8.4,5.5-13.4,5.4Z" />
          <path d="M272.8,59.7l-115.6,120c-6.2,6.5-16.7,6.5-23.3.4l-59.2-56.3c-6.7-6.3-7.1-16.9-.8-23.7s16.9-7.1,23.7-.8h0l47.3,45.1,105-108.7C185.6-18.3,89.7-10.1,35.7,54.1-18.3,118.4-10.1,214.3,54.1,268.3c64.2,54,160.1,45.8,214.2-18.4,45.9-54.5,47.7-133.6,4.5-190.2h0ZM203,223.3h-111.2c-9.2,0-16.7-7.5-16.7-16.7s7.5-16.7,16.7-16.7h111.2c9.2.1,16.6,7.5,16.7,16.7.2,9.1-7.1,16.6-16.2,16.7-.2,0-.4,0-.5,0Z" />
        </svg>
      </span>
    </div>
  );
}

/**
 * Optional pre-flight before the cash request. Asks the diner "¿con cuánto
 * vas a pagar?" so the waiter brings the right change on the first trip.
 * Always lets them skip with "le digo al mesero" so it never blocks the
 * actual flow.
 */
/**
 * Sheet de gastos de representación: cerrar la cuenta como cortesía ($0). El
 * mesero anota a quién se le dio (obligatorio) y confirma. No cobra nada.
 */
function RepresentacionSheet({
  title,
  amountCents,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  amountCents: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const t = useTranslations("pay");
  const [note, setNote] = useState("");
  const canConfirm = note.trim().length > 0 && !busy;

  return (
    <div
      // Hoja del STAFF (cortesía con motivo): sin cierre al tocar afuera, un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
              {t("representacionKicker", { amount: fmtCOP(amountCents) })}
            </div>
            <h2 className="font-display text-2xl mt-1">{title}</h2>
            <p className="text-xs text-muted mt-1">{t("representacionHint")}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        </div>

        <div>
          <label
            htmlFor="representacion-note"
            className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2 block"
          >
            {t("representacionNoteLabel")}
          </label>
          <textarea
            id="representacion-note"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 300))}
            disabled={busy}
            rows={2}
            placeholder={t("representacionNotePlaceholder")}
            className="w-full rounded-2xl border border-hairline bg-paper px-3 py-2 text-sm resize-none focus:outline-none focus:border-ink"
          />
        </div>

        <button
          type="button"
          onClick={() => onConfirm(note.trim())}
          disabled={!canConfirm}
          className="w-full min-h-[52px] rounded-2xl bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? t("representacionConfirming") : t("representacionConfirm")}
        </button>
      </div>
    </div>
  );
}

function CashTenderSheet({
  amountCents,
  busy,
  onClose,
  onPay,
}: {
  amountCents: number;
  busy: boolean;
  onClose: () => void;
  onPay: (tenderCents: number | null) => void;
}) {
  // Smart presets. Rules:
  //  - Always offer the next multiple of 10k that strictly covers the bill
  //    (so we never suggest the exact amount as a "with change" option).
  //  - Offer real Colombian bills ($10k, $20k, $50k, $100k — there is no
  //    $200k bill) that cover the bill AND whose change is no bigger than
  //    the bill itself. Suggesting $100k for a $25k bill is fine; for
  //    a $96k bill it's silly.
  //  - Cap to 3 presets so the sheet stays scannable on a phone.
  const t = useTranslations("pay");
  const dueCop = Math.ceil(amountCents / 100);
  const REAL_BILLS_COP = [10000, 20000, 50000, 100000];
  const maxReasonableCop = dueCop * 2;
  const candidates = new Set<number>();
  const nextRoundCop = Math.ceil(dueCop / 10000) * 10000;
  if (nextRoundCop > dueCop && nextRoundCop <= maxReasonableCop) {
    candidates.add(nextRoundCop);
  }
  for (const bill of REAL_BILLS_COP) {
    if (bill > dueCop && bill <= maxReasonableCop) {
      candidates.add(bill);
    }
  }
  const presetsCop = Array.from(candidates)
    .sort((a, b) => a - b)
    .slice(0, 3);

  const [customCop, setCustomCop] = useState<string>("");
  const customCents = Math.round(Number(customCop || 0) * 100);
  const customValid = customCents >= amountCents;

  function tenderChange(tenderCents: number): number {
    return Math.max(0, tenderCents - amountCents);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
              {t("cashTitle", { amount: fmtCOP(amountCents) })}
            </div>
            <h2 className="font-display text-2xl mt-1">
              {t("cashQuestion")}
            </h2>
            <p className="text-xs text-muted mt-1">{t("cashSubtitle")}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        </div>

        <div className="space-y-2">
          <PresetBill
            label={t("exactBill")}
            tenderCents={amountCents}
            changeCents={0}
            disabled={busy}
            onClick={() => onPay(amountCents)}
            primary
          />
          {presetsCop.map((cop) => {
            const tenderCents = cop * 100;
            return (
              <PresetBill
                key={cop}
                label={t("withAmount", {
                  amount: "$" + formatNumber(cop),
                })}
                tenderCents={tenderCents}
                changeCents={tenderChange(tenderCents)}
                disabled={busy}
                onClick={() => onPay(tenderCents)}
              />
            );
          })}

          <div className="rounded-xl border border-hairline bg-paper p-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-1">
              {t("otherAmount")}
            </div>
            <div className="flex items-stretch gap-2">
              <span className="self-center text-muted">$</span>
              <MoneyInput
                value={customCop}
                onChange={(raw) => setCustomCop(raw)}
                placeholder="80000"
                className="flex-1 h-11 px-3 rounded-lg border border-hairline bg-ivory font-mono tabular text-base focus:outline-none focus:border-terracotta"
              />
              <button
                type="button"
                disabled={busy || !customValid}
                onClick={() => onPay(customCents)}
                className="h-11 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
              >
                {t("use")}
              </button>
            </div>
            {customCop && !customValid && (
              <div className="text-[11px] text-danger mt-1">
                {t("lessThanBill", { amount: fmtCOP(amountCents) })}
              </div>
            )}
            {customValid && customCents > amountCents && (
              <div className="text-[11px] text-muted mt-1">
                {t("changeBack", { amount: fmtCOP(customCents - amountCents) })}
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onPay(null)}
          disabled={busy}
          className="w-full h-11 rounded-full border border-hairline text-sm text-ink-3 hover:text-ink disabled:opacity-50"
        >
          {busy ? t("notifying") : t("preferTellWaiter")}
        </button>

        <p className="text-[11px] text-muted-2 text-center">
          {t("cashFootnote")}
        </p>
      </div>
    </div>
  );
}

/**
 * Operator-side cash collection sheet. Different shape than the diner
 * one: the mesero already has the cash in hand and is closing the
 * round right now, so we collect tender + change + keep-the-change
 * tip in a single confirmation. The diner-facing sheet stays focused
 * on "tell the waiter how much you'll pay so they bring the right
 * change."
 */
/**
 * Sheet del flow PSE. En sandbox/producción usa Kushki.js para
 * tokenizar en el browser — el SDK maneja Sift Science (anti-fraud)
 * y devuelve `security.acsURL` que es la URL real del banco. En mock
 * mode usa nuestro endpoint backend que simula el flow.
 *
 * Estructura del flow:
 *   1. requestBankList(callback) → lista de bancos via Kushki API
 *   2. user selecciona banco + ingresa email + doc
 *   3. requestTransferToken(body, callback) → token + acsURL
 *   4. POST a /kushki-pse-init para registrar el Payment
 *   5. window.location = redirectUrl (página del banco real)
 */
function PseSheet({
  tenantSlug,
  amountCents,
  busy,
  kushkiPublicKey,
  kushkiMode,
  initialBanks,
  onClose,
  onPay,
}: {
  tenantSlug: string;
  amountCents: number;
  busy: boolean;
  kushkiPublicKey: string | null;
  kushkiMode: "mock" | "sandbox" | "production";
  initialBanks: Array<{ code: string; name: string }>;
  onClose: () => void;
  // En mock mode el sheet llama a onPay con buyer data → backend tokeniza.
  // En live mode el sheet tokeniza solo y llama a onPay con el token ya
  // listo + el redirectUrl para que el caller cree el Payment.
  onPay: (args: {
    bankCode: string;
    email: string;
    docType: "CC" | "CE" | "NIT" | "PA" | "TI";
    docNumber: string;
    personType: "natural" | "juridica";
    token?: string;
    redirectUrl?: string;
  }) => void;
}) {
  // Si las props traen bancos pre-fetcheados (SSR), arrancamos con la
  // lista poblada y skipeamos el loading — el dropdown se ve
  // instantáneo. Si vinieron vacíos (kushki_pse desactivado o el
  // SSR falló), caemos al fetch del browser como antes.
  const t = useTranslations("pay");
  const [banks, setBanks] = useState<{ code: string; name: string }[]>(
    initialBanks ?? [],
  );
  const [banksLoading, setBanksLoading] = useState(
    (initialBanks ?? []).length === 0,
  );
  const [bankCode, setBankCode] = useState("");
  const [email, setEmail] = useState("");
  const [docType, setDocType] = useState<"CC" | "CE" | "NIT" | "PA" | "TI">(
    "CC",
  );
  const [docNumber, setDocNumber] = useState("");
  const [personType, setPersonType] = useState<"natural" | "juridica">(
    "natural",
  );
  const [err, setErr] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);
  // ref al Kushki SDK instanciado — se carga lazy al abrir el sheet.
  const kushkiRef = useRef<unknown>(null);
  const isMockMode = kushkiMode === "mock";

  // Fallback fetch: solo si las props no traían bancos. Mismo path
  // que antes — el backend tiene cache in-memory de 1h. El SDK pesado
  // se carga LAZY en submit() cuando el user le da a "Ir al banco".
  useEffect(() => {
    if (banks.length > 0) return; // ya vienen del SSR
    let alive = true;
    (async () => {
      setBanksLoading(true);
      try {
        const res = await fetch(`/api/tenant/${tenantSlug}/pay/pse-banks`);
        const j = await res.json();
        if (alive && res.ok && Array.isArray(j.banks)) {
          setBanks(j.banks);
        } else if (alive) {
          setErr(j.message ?? t("errBankList"));
        }
      } catch (e) {
        console.error("[pse] bank list error", e);
        if (alive) setErr(t("errBankList"));
      } finally {
        if (alive) setBanksLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tenantSlug, isMockMode, kushkiPublicKey]);

  async function submit() {
    if (!bankCode) {
      setErr(t("errChooseBank"));
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr(t("errEmail"));
      return;
    }
    if (!docNumber.trim()) {
      setErr(t("errDocRequired"));
      return;
    }
    setErr(null);

    // Mock path: delegamos al backend (no necesita SDK).
    if (isMockMode || !kushkiPublicKey) {
      onPay({
        bankCode,
        email: email.trim().toLowerCase(),
        docType,
        docNumber: docNumber.trim(),
        personType,
      });
      return;
    }

    // Live path: tokenizamos en el browser. Cargamos el SDK LAZY acá
    // (sólo al hacer click en Pay) — antes lo cargábamos al abrir el
    // sheet y el bundle pesado generaba un "Cargando bancos..." de
    // 3-5 seg innecesario.
    setTokenizing(true);
    try {
      if (!kushkiRef.current) {
        const mod = await import("@kushki/js");

        const KushkiCtor =
          mod.Kushki ?? (mod as { default?: unknown }).default;
        if (typeof KushkiCtor !== "function") {
          throw new Error("@kushki/js no expone Kushki constructor");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const KCtor = KushkiCtor as new (opts: {
          merchantId: string;
          inTestEnvironment: boolean;
        }) => unknown;
        kushkiRef.current = new KCtor({
          merchantId: kushkiPublicKey,
          // Kushki SDK convention: true = UAT sandbox, false = prod.
          // El modo lo controla el admin desde /admin/configuracion.
          inTestEnvironment: kushkiMode !== "production",
        });

      } else {

      }
      // El callbackUrl debe ser ABSOLUTO y apuntar a nuestro /pse-return.
      // El SDK no la usa internamente pero Kushki la requiere para que
      // el banco sepa adónde regresar al diner.
      const callbackUrl = `${window.location.origin}/t/${tenantSlug}/pay/${getOrderIdFromPath()}/pse-return`;

      // Mapeo de doc → schema de Kushki Colombia.
      const docTypeForKushki: "CC" | "CE" | "NIT" | "TI" | "PP" =
        docType === "PA" ? "PP" : docType;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = {
        amount: {
          subtotalIva: 0,
          subtotalIva0: amountCents / 100,
          iva: 0,
        },
        callbackUrl,
        userType: personType === "juridica" ? "1" : "0",
        documentNumber: docNumber.trim(),
        documentType: docTypeForKushki,
        email: email.trim().toLowerCase(),
        // PSE es un riel exclusivo de Colombia → siempre COP.
        currency: "COP",
        bankId: bankCode,
      };

      const response = await new Promise<{
        token?: string;
        security?: { acsURL?: string };
        code?: string;
        message?: string;
        error?: string;
      }>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (kushkiRef.current as any).requestTransferToken(
          body,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (resp: any) => resolve(resp),
        );
      });


      console.log("[pse] kushki tokens response", response);

      if (response.code) {
        setErr(
          `${response.message ?? response.error ?? t("errPayFailed")} (${response.code})`,
        );
        return;
      }
      const token = response.token;
      if (!token) {
        setErr(t("errNoTokenPse"));
        return;
      }

      // El SDK Kushki para PSE Colombia v1.0 NO devuelve `acsURL` en la
      // respuesta de tokenización — solo el token. El segundo POST a
      // /transfer/v1/init (server-side, con la private key) es el que
      // devuelve la URL del banco. Le pasamos el token al backend.
      onPay({
        bankCode,
        email: email.trim().toLowerCase(),
        docType,
        docNumber: docNumber.trim(),
        personType,
        token,
      });
    } catch (e) {
      console.error("[pse] tokenize error", e);
      setErr(t("errTokenizePse"));
    } finally {
      setTokenizing(false);
    }
  }

  // Helper: extraer orderId de la URL actual. PseSheet no recibe el
  // orderId como prop pero está en el path /t/[slug]/pay/[orderId].
  function getOrderIdFromPath(): string {
    const parts = window.location.pathname.split("/");
    const i = parts.indexOf("pay");
    return i >= 0 ? parts[i + 1] : "";
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center">
      <div className="bg-paper w-full md:max-w-md md:rounded-2xl rounded-t-2xl p-5 max-h-[90vh] overflow-auto">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("pseLabel")}
            </div>
            <div className="font-display text-xl">
              {t("pay")}{" "}
              <span className="tabular">
                ${formatNumber(amountCents / 100)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm"
          >
            {t("close")}
          </button>
        </div>

        <p className="text-xs text-op-muted mb-4">{t("pseIntro")}</p>

        <label className="block mb-3">
          <div className="text-[11px] text-op-muted mb-1">{t("bank")}</div>
          {banksLoading ? (
            // Skeleton shimmer mientras carga la lista. Da feedback
            // visual claro de que algo está pasando sin mostrar texto
            // explícito ("Cargando..." cansa cuando se repite).
            <div
              className="w-full h-11 rounded-lg bg-hairline animate-pulse"
              aria-label={t("loadingBanks")}
            />
          ) : (
            <select
              value={bankCode}
              onChange={(e) => setBankCode(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
            >
              <option value="">{t("chooseBank")}</option>
              {banks.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="block mb-3">
          <div className="text-[11px] text-op-muted mb-1">{t("email")}</div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("emailPlaceholder")}
            className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
          />
        </label>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <label className="block col-span-1">
            <div className="text-[11px] text-op-muted mb-1">{t("docTypeLabel")}</div>
            <select
              value={docType}
              onChange={(e) =>
                setDocType(e.target.value as typeof docType)
              }
              className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
            >
              <option value="CC">CC</option>
              <option value="CE">CE</option>
              <option value="NIT">NIT</option>
              <option value="PA">PA</option>
              <option value="TI">TI</option>
            </select>
          </label>
          <label className="block col-span-2">
            <div className="text-[11px] text-op-muted mb-1">{t("docNumberLabel")}</div>
            <input
              inputMode="numeric"
              value={docNumber}
              onChange={(e) => setDocNumber(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
            />
          </label>
        </div>

        <label className="block mb-4">
          <div className="text-[11px] text-op-muted mb-1">{t("personTypeLabel")}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPersonType("natural")}
              className={
                "flex-1 h-10 rounded-lg border text-sm " +
                (personType === "natural"
                  ? "border-ink bg-ink text-bone"
                  : "border-hairline bg-paper text-ink")
              }
            >
              {t("natural")}
            </button>
            <button
              type="button"
              onClick={() => setPersonType("juridica")}
              className={
                "flex-1 h-10 rounded-lg border text-sm " +
                (personType === "juridica"
                  ? "border-ink bg-ink text-bone"
                  : "border-hairline bg-paper text-ink")
              }
            >
              {t("juridica")}
            </button>
          </div>
        </label>

        {err && (
          <div className="text-xs text-danger mb-3">{err}</div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || tokenizing || banksLoading || !bankCode}
          className="w-full h-12 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
        >
          {tokenizing
            ? t("tokenizing")
            : busy
              ? t("connectingBank")
              : t("goToBank", {
                  amount: "$" + formatNumber(amountCents / 100),
                })}
        </button>
        <p className="text-[11px] text-op-muted text-center mt-2">
          {t("pseFootnote")}
        </p>
      </div>
    </div>
  );
}

function OperatorCashSheet({
  amountCents,
  busy,
  onClose,
  onConfirm,
}: {
  amountCents: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: (v: { tenderCents: number; changeGivenCents: number }) => void;
}) {
  const t = useTranslations("pay");
  const locale = useLocale() as Locale;
  const dueCop = Math.ceil(amountCents / 100);
  // Colombia no usa centavos físicos: si una cuenta dividida cae en
  // fracción ($33.605 ÷ 2 = $16.802,50), la matemática del vuelto
  // termina en $X.XX,5 que al redondear deja al cliente debiendo
  // 50¢. Forzamos pesos enteros adentro del sheet (techo, como el
  // display) para que el preset siempre dé un vuelto físicamente
  // correcto. El servidor recibe ese mismo cuadre — la fracción <1
  // peso se informa como propina adicional antes de confirmar. El
  // servidor registra exactamente ese importe.
  const dueCents = dueCop * 100;

  // Smart presets para los billetes que se usan en Colombia. Lógica:
  //
  //   1) Round-up al próximo múltiplo de $1k, $5k, $10k, $20k, $50k
  //      y $100k. Cubre los casos "le agrego mil para no buscar
  //      monedas" y "redondeo al billete más cercano".
  //   2) Billetes reales del país ($50k y $100k — NO existe billete
  //      de $200k en Colombia). Solo si no son absurdamente más
  //      grandes que la cuenta: cap = max(amount × 5, $100k). El
  //      max contra $100k es para que cuentas chicas ($5k) sigan
  //      ofreciendo el $100k como opción (el cliente sí puede
  //      llegar con un billete grande).
  //   3) Dedupe entre las dos fuentes, ordena ascendente, toma hasta
  //      6 chips para mantener la fila scannable.
  //
  // Ejemplo $23.320 → 24, 25, 30, 40, 50, 100 (sin $200k). ✓
  const ROUND_STEPS = [1_000, 5_000, 10_000, 20_000, 50_000, 100_000];
  const REAL_BILLS_COP = [50_000, 100_000];
  const reasonableCap = Math.max(dueCop * 5, 100_000);
  const candidates = new Set<number>();
  for (const step of ROUND_STEPS) {
    const next = Math.ceil(dueCop / step) * step;
    if (next > dueCop) candidates.add(next);
  }
  for (const bill of REAL_BILLS_COP) {
    if (bill > dueCop && bill <= reasonableCap) candidates.add(bill);
  }
  const presetsCop = Array.from(candidates)
    .sort((a, b) => a - b)
    .slice(0, 6);

  const [tenderCop, setTenderCop] = useState<string>(String(dueCop));
  const [changeCop, setChangeCop] = useState<string>("0");

  const tender = Math.round(Number(tenderCop || 0) * 100);
  const change = Math.round(Number(changeCop || 0) * 100);
  const netReceived = tender - change;
  // Todo se compara contra dueCents (pesos enteros redondeados al
  // alza) en vez de amountCents (que puede tener centavos por splits)
  // — así el preset siempre da un vuelto físico y el confirm no se
  // bloquea por diferencias invisibles al usuario.
  const extraTip = netReceived - amountCents;
  const validTender = tender >= dueCents;
  const validChange = change >= 0 && change <= tender;
  const valid = validTender && validChange && netReceived >= dueCents;

  function pickPreset(bill: number) {
    setTenderCop(String(bill));
    // Sensible default: give back exact change (no extra tip). The
    // mesero can lower the change if the diner says "keep $X" — the
    // extraTip readout below updates live.
    const exactChange = bill * 100 - dueCents;
    setChangeCop(String(Math.max(0, Math.round(exactChange / 100))));
  }

  // Estado del vuelto: tres posibles configuraciones para no ambiguar.
  //   - isRefunding  : devuelta = vuelto completo (cliente recibe todo)
  //   - isKeepingAll : devuelta = 0 (todo va a propina)
  //   - partial      : ninguna de las anteriores (cliente dijo "dame
  //                    $1000 y deja el resto") — los dos shortcuts
  //                    quedan inactivos y el mesero ajusta a mano.
  const expectedChange = Math.max(0, tender - dueCents);
  const expectedChangeCop = Math.max(0, Math.round(expectedChange / 100));
  const isRefunding =
    validTender && expectedChange > 0 && change === expectedChange;
  const isKeepingAll = validTender && expectedChange > 0 && change === 0;
  function keepAllAsTip() {
    setChangeCop("0");
  }
  function refundExactChange() {
    setChangeCop(String(expectedChangeCop));
  }

  return (
    <div
      // Hoja del STAFF (cobro en efectivo): sin cierre al tocar afuera, un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
              {t("cashChargeTitle", { amount: fmtCOP(dueCents) })}
            </div>
            <h2 className="font-display text-2xl mt-1">{t("confirmCharge")}</h2>
            <p className="text-xs text-muted mt-1">{t("opCashSubtitle")}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        </div>

        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {t("paidWithWhat")}
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => {
                setTenderCop(String(dueCop));
                setChangeCop("0");
              }}
              disabled={busy}
              className={
                "h-9 px-3 rounded-full text-xs font-medium border transition-colors " +
                (tender === dueCents
                  ? "bg-ink text-bone border-ink"
                  : "bg-paper border-hairline")
              }
            >
              {t("exactBill")}
            </button>
            {presetsCop.map((bill) => {
              const billCents = bill * 100;
              const active = tender === billCents;
              return (
                <button
                  key={bill}
                  type="button"
                  onClick={() => pickPreset(bill)}
                  disabled={busy}
                  className={
                    "h-9 px-3 rounded-full text-xs font-medium border tabular transition-colors " +
                    (active
                      ? "bg-ink text-bone border-ink"
                      : "bg-paper border-hairline")
                  }
                >
                  {fmtCOP(billCents)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {t("receivedFromClient")}
            </span>
            <MoneyInput
              value={tenderCop}
              onChange={(raw) => {
                const clean = raw.replace(/[^0-9]/g, "");
                setTenderCop(clean);
              }}
              className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-xl font-display tabular"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {t("changeGivenLabel")}
            </span>
            <MoneyInput
              value={changeCop}
              onChange={(raw) => {
                const clean = raw.replace(/[^0-9]/g, "");
                setChangeCop(clean);
              }}
              className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-xl font-display tabular"
            />
          </label>
        </div>

        {/* Decisión clara sobre los $X de vuelto. Tres estados:
            - isRefunding  → activo el botón "Le devuelvo"
            - isKeepingAll → activo el botón "Lo deja de propina"
            - partial      → ningún botón activo (el mesero ajustó
                             la devuelta a mano via los inputs)
            Ambos botones quedan siempre clickeables salvo el que ya
            refleja el estado actual — antes había un check al revés
            que dejaba "Devolver" atascado al pasar a "Dejar". */}
        {expectedChange > 0 && (
          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
              {t("changeQuestion", { amount: fmtCOP(expectedChange) })}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={refundExactChange}
                disabled={busy || isRefunding}
                aria-pressed={isRefunding}
                className={
                  "h-12 rounded-2xl text-sm font-medium border px-3 transition-colors " +
                  (isRefunding
                    ? "bg-ink text-bone border-ink"
                    : "bg-paper border-hairline text-ink hover:border-ink")
                }
              >
                <div className="leading-tight">{t("iReturn")}</div>
                <div className="font-mono text-[10px] opacity-80 mt-0.5">
                  {t("theChange")}
                </div>
              </button>
              <button
                type="button"
                onClick={keepAllAsTip}
                disabled={busy || isKeepingAll}
                aria-pressed={isKeepingAll}
                className={
                  "h-12 rounded-2xl text-sm font-medium border px-3 transition-colors " +
                  (isKeepingAll
                    ? "bg-ink text-bone border-ink"
                    : "bg-paper border-hairline text-ink hover:border-ink")
                }
              >
                <div className="leading-tight">{t("keeps")}</div>
                <div className="font-mono text-[10px] opacity-80 mt-0.5">
                  {t("asTip")}
                </div>
              </button>
            </div>
          </div>
        )}

        <div
          className={
            "rounded-xl px-3 py-3 text-sm border " +
            (valid
              ? extraTip > 0
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : "bg-paper border-hairline text-ink"
              : "bg-red-50 border-red-200 text-red-900")
          }
        >
          {!validTender ? (
            <span>{t("mustPayAtLeast", { amount: fmtCOP(dueCents) })}</span>
          ) : !validChange ? (
            <span>{t("changeTooHigh")}</span>
          ) : extraTip < 0 ? (
            // La devuelta es más alta que el vuelto real → mesero pondría
            // plata de su bolsillo. Mostramos el faltante y un atajo para
            // ajustar al vuelto exacto.
            <div className="space-y-2">
              <div>
                {t.rich("changeExceeds", {
                  amount: fmtCOP(-extraTip),
                  b: (chunks) => (
                    <strong className="font-mono tabular">{chunks}</strong>
                  ),
                })}
              </div>
              <button
                type="button"
                onClick={refundExactChange}
                className="font-mono text-[10px] tracking-wider uppercase underline"
              >
                {t("correctToExact", { amount: fmtCOP(expectedChange) })}
              </button>
            </div>
          ) : extraTip > 0 ? (
            <span>
              {t.rich("tipFromChange", {
                amount: formatMoney(extraTip, { locale, fractionDigits: extraTip % 100 ? 2 : 0 }),
                b: (chunks) => (
                  <strong className="font-mono tabular">{chunks}</strong>
                ),
              })}
            </span>
          ) : (
            <span>{t("noTipFromChange")}</span>
          )}
        </div>

        <button
          type="button"
          onClick={() =>
            onConfirm({ tenderCents: tender, changeGivenCents: change })
          }
          disabled={busy || !valid}
          className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy
            ? t("registering")
            : t("confirmChargeBtn", {
                amount: fmtCOP(netReceived),
              })}
        </button>
      </div>
    </div>
  );
}

function PresetBill({
  label,
  tenderCents,
  changeCents,
  disabled,
  primary,
  onClick,
}: {
  label: string;
  tenderCents: number;
  changeCents: number;
  disabled: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  const t = useTranslations("pay");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "w-full rounded-xl border-2 px-4 py-3 flex items-center justify-between text-left disabled:opacity-50 " +
        (primary
          ? "border-ink bg-ink text-bone"
          : "border-hairline bg-paper text-ink hover:border-ink")
      }
    >
      <div>
        <div className="font-medium text-sm">{label}</div>
        <div
          className={
            "text-[11px] mt-0.5 " + (primary ? "opacity-70" : "text-muted")
          }
        >
          {changeCents > 0
            ? t("changeBackShort", { amount: fmtCOP(changeCents) })
            : t("noChange")}
        </div>
      </div>
      <div className="font-mono tabular text-base">{fmtCOP(tenderCents)}</div>
    </button>
  );
}

/**
 * Card sheet — diner ingresa datos de tarjeta y los tokenizamos en el
 * browser con Kushki.js. El PAN/CVV NUNCA pasan por nuestro server
 * (PCI SAQ-A). Devolvemos solo el token al caller via onTokenized.
 *
 * Mock mode: si KUSHKI_MODE=mock o el tenant no tiene public key,
 * generamos un token fake para que el mock provider lo acepte (mismo
 * patrón que PseSheet).
 *
 * 3DS NOT supported aún — si el banco lo requiere, Kushki devuelve
 * security.acsURL y acá lo expondríamos como redirect. Para MVP
 * dejamos las tarjetas no-3DS y el banco rechaza el resto.
 */
function CardSheet({
  amountCents,
  tipCents,
  tenantSlug,
  orderId,
  busy,
  kushkiPublicKey,
  kushkiMode,
  currency,
  card3ds,
  onClose,
  onTokenized,
}: {
  amountCents: number;
  tipCents: number;
  tenantSlug: string;
  orderId: string;
  busy: boolean;
  kushkiPublicKey: string | null;
  kushkiMode: "mock" | "sandbox" | "production";
  currency: "COP" | "MXN";
  card3ds: boolean;
  onClose: () => void;
  onTokenized: (
    token: string,
    contact?: { name: string; email: string },
  ) => void;
}) {
  const t = useTranslations("pay");
  const [number, setNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [expiry, setExpiry] = useState(""); // formato MM/YY
  const [cvv, setCvv] = useState("");
  // Kushki Colombia incluye Sift Science en el SDK y el body que arma
  // el SDK tira K001 con nuestro setup. Llamamos al endpoint directo
  // — sigue siendo SAQ-A porque el PAN solo va a kushkipagos.com.
  // Email se incluye en el body para el recibo electrónico.
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);
  const isMockMode = kushkiMode === "mock";

  function formatCardNumber(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 19);
    return digits.replace(/(.{4})/g, "$1 ").trim();
  }
  function formatExpiry(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    if (digits.length < 3) return digits;
    return digits.slice(0, 2) + "/" + digits.slice(2);
  }

  async function submit() {
    setErr(null);
    const digits = number.replace(/\s/g, "");
    if (digits.length < 13 || digits.length > 19) {
      setErr(t("errCardNumber"));
      return;
    }
    if (!holderName.trim() || holderName.trim().length < 3) {
      setErr(t("errCardName"));
      return;
    }
    const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!expiryMatch) {
      setErr(t("errExpiry"));
      return;
    }
    const expMonth = expiryMatch[1];
    const expYear = expiryMatch[2];
    if (Number(expMonth) < 1 || Number(expMonth) > 12) {
      setErr(t("errExpiryMonth"));
      return;
    }
    if (!cvv.match(/^\d{3,4}$/)) {
      setErr(t("errCvv"));
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr(t("errCardEmail"));
      return;
    }

    const contact = {
      name: holderName.trim(),
      email: email.trim().toLowerCase(),
    };

    // Mock path: no SDK call — el mock provider acepta cualquier token.
    if (isMockMode || !kushkiPublicKey) {
      onTokenized(
        `mock-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        contact,
      );
      return;
    }

    setTokenizing(true);
    try {
      // Bypass del SDK @kushki/js: el SDK arma un body con campos de
      // Sift Science que Kushki rechaza con K001 en este setup. El
      // endpoint directo acepta el body sin los extras y devuelve el
      // token al toque. PCI SAQ-A se mantiene porque el PAN sólo viaja
      // a kushkipagos.com (browser → Kushki), no a MESAPAY.
      const baseUrl =
        kushkiMode === "production"
          ? "https://api.kushkipagos.com"
          : "https://api-uat.kushkipagos.com";

      // 3DS (si el comercio lo tiene activo): pedimos `authValidation: "url"`
      // para que Kushki devuelva la URL del banco cuando la tarjeta lo
      // requiera. callbackUrl tiene que ser absoluta — el banco redirige al
      // diner ahí con ?success=...&token=... después del OTP. Con card3ds
      // apagado, omitimos ambos campos y el cobro va directo sin OTP.
      const callbackUrl = `${window.location.origin}/t/${tenantSlug}/pay/${orderId}/3ds-return`;
      const body = {
        card: {
          number: digits,
          name: holderName.trim(),
          expiryMonth: expMonth,
          expiryYear: expYear,
          cvv,
        },
        totalAmount: amountCents / 100,
        currency,
        isDeferred: false,
        email: email.trim().toLowerCase(),
        ...(card3ds ? { authValidation: "url", callbackUrl } : {}),
      };
      console.log("[card] tokenize body shape", {
        cardLast4: digits.slice(-4),
        totalAmount: body.totalAmount,
        currency: body.currency,
        card3ds,
        callbackUrl: card3ds ? callbackUrl : "(3ds off)",
      });
      const res = await fetch(`${baseUrl}/card/v1/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Public-Merchant-Id": kushkiPublicKey,
        },
        body: JSON.stringify(body),
      });
      const json: {
        token?: string;
        url?: string; // 3DS challenge URL del banco
        secureService?: string;
        secureId?: string;
        code?: string;
        message?: string;
      } = await res.json().catch(() => ({}));
      console.log("[card] kushki tokens response", {
        status: res.status,
        hasToken: !!json.token,
        code: json.code,
        has3DS: !!json.url,
      });
      if (!res.ok || json.code) {
        setErr(
          `${json.message ?? t("errPayFailed")}${json.code ? ` (${json.code})` : ` (HTTP ${res.status})`}`,
        );
        return;
      }
      if (!json.token) {
        setErr(t("errNoTokenCard"));
        return;
      }

      // 3DS required → stash amount+tip en localStorage y redirect
      // al banco. La página /3ds-return lo recupera para hacer el
      // charge una vez que el banco valide el OTP.
      if (json.url) {
        try {
          localStorage.setItem(
            `mesapay:3ds:${orderId}`,
            JSON.stringify({ amountCents, tipCents, ...contact }),
          );
        } catch (e) {
          console.error("[card] localStorage stash failed", e);
        }
        // Hard navigation al banco — el sheet ya no va a estar visible
        // cuando el diner vuelva, así que no nos importa cleanup state.
        window.location.href = json.url;
        return;
      }

      // No 3DS → token listo para charge inmediato.
      onTokenized(json.token, contact);
    } catch (e) {
      console.error("[card] tokenize error", e);
      setErr(t("errTokenizeCard"));
    } finally {
      setTokenizing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-paper rounded-t-3xl sm:rounded-3xl p-6 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
            {t("cardLabel")}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted hover:text-ink"
          >
            {t("close")}
          </button>
        </div>
        <div className="mt-1">
          <div className="font-display text-2xl">
            {t("payAmount", { amount: fmtCOP(amountCents) })}
          </div>
        </div>

        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {t("cardNumber")}
            </span>
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder={t("cardNumberPlaceholder")}
              value={number}
              onChange={(e) => setNumber(formatCardNumber(e.target.value))}
              className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 font-mono tabular text-sm focus:outline-none focus:border-ink"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {t("cardName")}
            </span>
            <input
              type="text"
              autoComplete="cc-name"
              placeholder={t("cardNamePlaceholder")}
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 text-sm focus:outline-none focus:border-ink"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {t("email")}
            </span>
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 text-sm focus:outline-none focus:border-ink"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                {t("expiry")}
              </span>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="cc-exp"
                placeholder={t("expiryPlaceholder")}
                value={expiry}
                onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 font-mono tabular text-sm focus:outline-none focus:border-ink"
              />
            </label>
            <label className="block">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                {t("cvv")}
              </span>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="cc-csc"
                placeholder={t("cvvPlaceholder")}
                value={cvv}
                onChange={(e) =>
                  setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))
                }
                className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 font-mono tabular text-sm focus:outline-none focus:border-ink"
              />
            </label>
          </div>
        </div>

        {err && (
          <div className="mt-4 text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
            {err}
          </div>
        )}

        <button
          type="button"
          disabled={busy || tokenizing}
          onClick={submit}
          className="mt-5 w-full h-12 rounded-full bg-ink text-bone font-medium text-sm disabled:opacity-60"
        >
          {tokenizing
            ? t("validatingCard")
            : busy
              ? t("processingPayment")
              : t("payAmount", { amount: fmtCOP(amountCents) })}
        </button>
      </div>
    </div>
  );
}

/** Rótulo que separa el medio preseleccionado de las alternativas (link de pago). */
function AltMethodsLabel() {
  const t = useTranslations("pay");
  return (
    <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted pt-3 pb-1">
      {t("linkOtherMethods")}
    </div>
  );
}

function PayButton({
  currency,
  kind,
  disabled,
  busy,
  onClick,
  amountCents,
  operatorMode,
  emphasis,
}: {
  currency: string;
  kind:
    | "apple"
    | "card"
    | "terminal"
    | "external_terminal"
    | "pse"
    | "bre_b"
    | "cash"
    | "credit"
    | "demo_terminal";
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
  amountCents: number;
  operatorMode: boolean;
  /**
   * Pisa el estilo propio del medio: "primary" (lleno) para el
   * preseleccionado del link de pago, "secondary" (contorno) para las
   * alternativas. Sin él, cada medio conserva su estilo de siempre.
   */
  emphasis?: "primary" | "secondary";
}) {
  const t = useTranslations("pay");
  const locale = useLocale() as Locale;
  const meta = (operatorMode ? BUTTON_META_OP : BUTTON_META_DINER)[kind];
  const className =
    emphasis === "primary" ? "mp-pay--ink" : emphasis === "secondary" ? "mp-pay--outline" : meta.className;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={"mp-pay text-sm " + className}
    >
      <span className="text-base leading-none" aria-hidden>
        {meta.icon}
      </span>
      <span>
        {busy
          ? t("processing")
          : `${t(meta.labelKey)} · ${formatMoney(amountCents, { currency, locale, fractionDigits: amountCents % 100 ? 2 : 0 })}`}
      </span>
    </button>
  );
}

// labelKey es una clave del catálogo `pay` — PayButton la resuelve con t().
type ButtonMeta = { labelKey: string; icon: string; className: string };

// Copy written for the diner — they're asking the system to do
// something on their behalf, so "llamar al mesero" / "pedir datáfono"
// frame the action correctly.
const BUTTON_META_DINER: Record<
  "apple" | "card" | "terminal" | "external_terminal" | "pse" | "bre_b" | "cash" | "credit" | "demo_terminal",
  ButtonMeta
> = {
  apple: {
    labelKey: "btnApple",
    icon: "",
    className: "mp-pay--ink",
  },
  card: {
    labelKey: "btnCard",
    icon: "💳",
    className: "mp-pay--ink",
  },
  terminal: {
    labelKey: "btnTerminal",
    icon: "💳",
    className: "mp-pay--accent",
  },
  external_terminal: {
    labelKey: "btnExternalTerminal",
    icon: "💳",
    className: "mp-pay--outline",
  },
  pse: {
    labelKey: "btnPse",
    icon: "🏦",
    className: "mp-pay--outline",
  },
  bre_b: {
    labelKey: "btnBreB",
    icon: "📲",
    className: "mp-pay--outline",
  },
  cash: {
    labelKey: "btnCash",
    icon: "💵",
    className: "mp-pay--outline",
  },
  credit: {
    labelKey: "opBtnCredit", // nunca se muestra al comensal; por el tipo
    icon: "🧾",
    className: "mp-pay--outline",
  },
  demo_terminal: {
    labelKey: "btnDemoTerminal",
    icon: "🧪",
    className: "mp-pay--outline",
  },
};

// Copy written for the waiter who's the one collecting the bill.
// They aren't "calling the mesero" or "asking for the datáfono" —
// they're recording how the diner is paying right now.
const BUTTON_META_OP: Record<
  "apple" | "card" | "terminal" | "external_terminal" | "pse" | "bre_b" | "cash" | "credit" | "demo_terminal",
  ButtonMeta
> = {
  apple: BUTTON_META_DINER.apple, // never shown in op mode, kept for type safety
  card: {
    labelKey: "opBtnCard",
    icon: "💳",
    className: "mp-pay--ink",
  },
  terminal: {
    labelKey: "opBtnTerminal",
    icon: "💳",
    className: "mp-pay--accent",
  },
  external_terminal: {
    labelKey: "opBtnExternalTerminal",
    icon: "💳",
    className: "mp-pay--outline",
  },
  pse: BUTTON_META_DINER.pse, // never shown in op mode, kept for type safety
  bre_b: {
    labelKey: "opBtnBreB",
    icon: "📲",
    className: "mp-pay--outline",
  },
  cash: {
    labelKey: "opBtnCash",
    icon: "💵",
    className: "mp-pay--outline",
  },
  credit: {
    labelKey: "opBtnCredit",
    icon: "🧾",
    className: "mp-pay--outline",
  },
  demo_terminal: {
    labelKey: "opBtnDemoTerminal",
    icon: "🧪",
    className: "mp-pay--outline",
  },
};

function ModeButton({
  active,
  label,
  hint,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        "p-3 rounded-xl border text-left transition-[transform,box-shadow,background,border-color] duration-150 disabled:opacity-50 " +
        (active
          ? "bg-ink text-bone border-ink shadow-[0_1px_2px_rgba(26,22,19,0.14)]"
          : "bg-paper border-hairline text-ink hover:border-ink/30 hover:-translate-y-px")
      }
    >
      <div className="font-medium text-sm">{label}</div>
      <div className="text-[11px] opacity-70 mt-0.5">{hint}</div>
    </button>
  );
}

function Row({
  label,
  value,
  muted,
  accent,
}: {
  label: string;
  value: string;
  muted?: boolean;
  // Slight emphasis — used for the "Pendiente por cobrar" subtotal
  // so it stands out between "Ya cubierto" (muted) and the per-
  // person split below.
  accent?: boolean;
}) {
  return (
    <div
      className={
        "flex items-center justify-between " +
        (muted ? "text-muted " : "") +
        (accent ? "pt-1 mt-1 border-t border-hairline font-medium" : "")
      }
    >
      <span className="text-sm">{label}</span>
      <span className="font-mono tabular">{value}</span>
    </div>
  );
}

/**
 * "¿Tenés un bono?" — verifica el código contra la cuenta (saldo y cuánto
 * se aplicaría) y, al confirmar, lo aplica. Mismo campo para el comensal
 * y para el staff (mesero / caja): el server decide el canal por la
 * sesión. Los errores llegan como CÓDIGOS y se traducen acá.
 */
function VoucherCard({
  tenantSlug,
  orderId,
  operatorMode,
  disabled,
  onApplied,
}: {
  tenantSlug: string;
  orderId: string;
  operatorMode: boolean;
  disabled: boolean;
  onApplied: (fullyPaid: boolean) => void;
}) {
  const t = useTranslations("pay");
  const apiError = useApiError();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<{
    code: string;
    balanceCents: number;
    applicableCents: number;
    outstandingCents: number;
  } | null>(null);
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const errorText = (j: { error?: unknown }) => {
    const key = typeof j.error === "string" ? `voucherErr_${j.error}` : "";
    return key && t.has(key) ? t(key) : apiError(j, t("voucherErr_generic"));
  };

  async function check() {
    if (code.trim().length < 4) return;
    setBusy("check");
    setErr(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/vouchers/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, code: code.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(errorText(j));
        return;
      }
      setPreview(j);
    } catch {
      setErr(t("voucherErr_generic"));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy("apply");
    setErr(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/vouchers/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, code: code.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(errorText(j));
        setPreview(null);
        return;
      }
      setApplied(
        j.fullyPaid
          ? t("voucherAppliedFull", { amount: fmtCOP(j.amountCents) })
          : t("voucherAppliedPartial", {
              amount: fmtCOP(j.amountCents),
              remaining: fmtCOP(j.outstandingAfterCents),
            }),
      );
      setPreview(null);
      setCode("");
      onApplied(!!j.fullyPaid);
    } catch {
      setErr(t("voucherErr_generic"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 bg-paper rounded-2xl border border-hairline p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
        {operatorMode ? t("voucherTitleOp") : t("voucherTitle")}
      </div>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setPreview(null);
            setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void check();
            }
          }}
          placeholder={t("voucherPlaceholder")}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1 h-11 rounded-xl border border-hairline bg-bone px-3 text-sm font-mono tracking-[0.08em] focus:outline-none focus:border-ink"
        />
        <button
          type="button"
          onClick={check}
          disabled={disabled || busy !== null || code.trim().length < 4}
          className="h-11 px-4 rounded-xl border border-ink text-sm font-medium disabled:opacity-40"
        >
          {busy === "check" ? t("voucherChecking") : t("voucherCheck")}
        </button>
      </div>
      {preview && (
        <div className="mt-3 rounded-xl border border-hairline bg-ivory p-3">
          <div className="text-sm">
            {t("voucherFound", {
              code: preview.code,
              balance: fmtCOP(preview.balanceCents),
              amount: fmtCOP(preview.applicableCents),
            })}
          </div>
          {preview.applicableCents < preview.balanceCents && (
            <div className="text-xs text-muted mt-1">
              {t("voucherLeftover", {
                left: fmtCOP(preview.balanceCents - preview.applicableCents),
              })}
            </div>
          )}
          {preview.applicableCents < preview.outstandingCents && (
            <div className="text-xs text-muted mt-1">
              {t("voucherRemainder", {
                remaining: fmtCOP(preview.outstandingCents - preview.applicableCents),
              })}
            </div>
          )}
          <button
            type="button"
            onClick={apply}
            disabled={disabled || busy !== null}
            className="mt-3 w-full h-11 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
          >
            {busy === "apply"
              ? t("voucherApplying")
              : t("voucherApply", { amount: fmtCOP(preview.applicableCents) })}
          </button>
          <p className="text-[11px] text-muted-2 text-center mt-2">{t("voucherNoTip")}</p>
        </div>
      )}
      {applied && (
        <div role="status" className="mt-3 text-sm text-success">
          {applied}
        </div>
      )}
      {err && <div className="mt-3 text-sm text-danger">{err}</div>}
    </div>
  );
}

/** Línea "Debe hoy · Límite · Disponible" de un cliente con crédito. */
function CustomerCreditLine({ customer }: { customer: PayCustomer }) {
  const t = useTranslations("pay");
  const available = creditAvailableCents(customer);
  return (
    <div className="text-xs text-muted mt-1">
      <span className={(customer.debtCents ?? 0) > 0 ? "text-terracotta" : ""}>
        {t("customerDebt", { amount: fmtCOP(customer.debtCents ?? 0) })}
      </span>
      {customer.creditLimitCents != null && (
        <span>
          {" · "}
          {t("customerCreditLimit", {
            limit: fmtCOP(customer.creditLimitCents),
            available: fmtCOP(available ?? 0),
          })}
        </span>
      )}
    </div>
  );
}

/**
 * Paso opcional "Cliente" del cobro (staff): quién es el cliente de
 * facturación de esta cuenta. Al elegirlo el server aplica su descuento y
 * devuelve su deuda; acá se muestra el resultado y se puede cambiar.
 */
function CustomerCard({
  customer,
  notice,
  disabled,
  currency,
  onPick,
}: {
  customer: PayCustomer | null;
  notice: string | null;
  disabled: boolean;
  currency: string;
  onPick: (customer: BillingCustomerRecord) => void;
}) {
  const t = useTranslations("pay");
  const [picking, setPicking] = useState(customer === null);
  return (
    <div className="mt-6 bg-paper rounded-2xl border border-hairline p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
        {t("customerCardTitleOp")}
      </div>
      {customer && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium break-words">{customer.customerName}</div>
            <div className="text-xs text-muted">
              {customer.docType} {billingDocument(customer)}
              {customer.discountEnabled && customer.discountBps > 0
                ? ` · ${t("customerDiscountBadge", { pct: discountBpsToPctText(customer.discountBps) })}`
                : ""}
            </div>
            {customer.creditEnabled && <CustomerCreditLine customer={customer} />}
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPicking((v) => !v)}
            className="text-xs underline text-muted shrink-0 disabled:opacity-50"
          >
            {picking ? t("customerKeep") : t("customerChange")}
          </button>
        </div>
      )}
      {!customer && <p className="text-xs text-muted mb-3">{t("customerCardHint")}</p>}
      {picking && (
        <div className={customer ? "mt-3" : ""}>
          <CustomerPicker
            currency={currency}
            onSelect={(picked) => {
              setPicking(false);
              onPick(picked);
            }}
          />
        </div>
      )}
      {notice && (
        <div role="status" className="mt-3 text-sm text-success">
          {notice}
        </div>
      )}
    </div>
  );
}

/**
 * "Cobrar a crédito": elige (o confirma) el cliente con crédito, muestra lo
 * que debe hoy, su límite y lo que se le va a cargar, y confirma. El monto
 * es TODO lo pendiente más la propina: no hay crédito parcial.
 */
function CreditSheet({
  initialCustomer,
  subtotalCents,
  tipCents,
  busy,
  error,
  currency,
  onClose,
  onPick,
  onConfirm,
}: {
  initialCustomer: PayCustomer | null;
  subtotalCents: number;
  tipCents: number;
  busy: boolean;
  error: string | null;
  currency: string;
  onClose: () => void;
  onPick: (customer: BillingCustomerRecord) => void;
  onConfirm: (billingCustomerId: string) => void;
}) {
  const t = useTranslations("pay");
  const [picked, setPicked] = useState<PayCustomer | null>(initialCustomer);
  const total = subtotalCents + tipCents;
  const usable = picked?.creditEnabled ? picked : null;
  const available = usable ? creditAvailableCents(usable) : null;
  const overLimit = available != null && total > available;
  return (
    <div
      // Hoja del STAFF (cobro a crédito): sin cierre al tocar afuera, un clic perdido borraba lo elegido.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
              {t("creditKicker", { amount: fmtCOP(total) })}
            </div>
            <h2 className="font-display text-2xl mt-1">{t("creditTitle")}</h2>
            <p className="text-xs text-muted mt-1">{t("creditNote")}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        </div>

        {picked && !picked.creditEnabled && (
          <p className="text-sm text-danger">{t("creditCustomerNoCredit", { name: picked.customerName })}</p>
        )}
        {usable ? (
          <div className="rounded-xl border border-hairline bg-ivory p-3">
            <div className="text-sm font-medium break-words">{usable.customerName}</div>
            <div className="text-xs text-muted">
              {usable.docType} {billingDocument(usable)}
            </div>
            <CustomerCreditLine customer={usable} />
            <button
              type="button"
              disabled={busy}
              onClick={() => setPicked(null)}
              className="mt-2 text-xs underline text-muted disabled:opacity-50"
            >
              {t("customerChange")}
            </button>
          </div>
        ) : (
          <div>
            <p className="text-xs text-muted mb-2">{t("creditPickHint")}</p>
            <CustomerPicker
              creditOnly
              currency={currency}
              onSelect={(c) => {
                setPicked(c);
                onPick(c);
              }}
            />
          </div>
        )}

        <div className="rounded-xl border border-hairline bg-paper p-3 text-sm">
          {t("creditAmountLine", {
            subtotal: fmtCOP(subtotalCents),
            tip: fmtCOP(tipCents),
            total: fmtCOP(total),
          })}
        </div>
        {overLimit && (
          <p className="text-sm text-danger">
            {t("creditErr_credit_limit_exceeded", { available: fmtCOP(available ?? 0) })}
          </p>
        )}
        {error && <div className="text-sm text-danger">{error}</div>}

        <button
          type="button"
          onClick={() => usable && onConfirm(usable.id)}
          disabled={!usable || busy || total <= 0 || overLimit}
          className="w-full min-h-[52px] rounded-2xl bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? t("creditConfirming") : t("creditConfirm", { amount: fmtCOP(total) })}
        </button>
      </div>
    </div>
  );
}
