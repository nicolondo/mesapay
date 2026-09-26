"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { InvoiceChoiceButtons } from "@/components/invoice/InvoiceChoiceButtons";
import { InvoiceFormSheet } from "@/components/invoice/InvoiceFormSheet";
import { SimpleInvoiceSheet } from "@/components/invoice/SimpleInvoiceSheet";
import type { InvoiceRequestSummary } from "@/components/invoice/types";
import {
  isSimpleInvoiceRequested,
  simpleInvoiceEmailFrom,
} from "@/lib/simpleInvoiceRequest";

/**
 * Estado de la factura DESPUÉS del pago.
 *
 * La pregunta grande ya no vive acá: se hace en el checkout
 * (`InvoiceCheckoutCard`), cuando el comensal todavía está pagando. Acá queda
 * lo que corresponde a esta pantalla:
 *
 *  - Si ya pidió factura → el estado (pendiente / generada) y "corregir datos".
 *    La genérica pudo pedirse SIN correo: entonces no se envía nada y lo que
 *    queda es el botón de imprimir, apenas la factura exista.
 *  - Si no pidió nada → un acceso discreto, para el que cambió de opinión.
 *    No se elimina del todo: sin esa salida, el que se arrepiente queda
 *    colgado y termina pidiéndosela al mesero.
 */
export function InvoiceRequestPanel({
  tenantSlug,
  orderId,
  existing,
  simpleRequestEmail = null,
  issuedInvoiceUrl = null,
  orderPaid = false,
  prefillEmail = null,
  operatorMode = false,
}: {
  tenantSlug: string;
  orderId: string;
  existing: InvoiceRequestSummary | null;
  /**
   * `Order.simpleInvoiceEmail` tal cual: el pedido de la factura genérica
   * (sin datos personales). null = no la pidió; "" = la pidió sin correo,
   * sólo para imprimir; con correo = además se envía. Se muestra como
   * confirmación en vez del panel grande.
   */
  simpleRequestEmail?: string | null;
  /**
   * URL pública de la factura (tirilla) de esta cuenta, si ya se emitió.
   * Con ella la confirmación ofrece imprimirla.
   */
  issuedInvoiceUrl?: string | null;
  /** La cuenta ya está paga (la factura existe o está por existir). */
  orderPaid?: boolean;
  // Correo que el diner ya tipeó al pagar con tarjeta. Si lo tenemos,
  // prellenamos el campo de correo en los sheets de factura para no volver
  // a pedirlo.
  prefillEmail?: string | null;
  // En modo mesero (cobra por el cliente) la copia va en tercera persona.
  operatorMode?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("done");
  const [open, setOpen] = useState(false);
  // Sheet para la "tirilla simple" — flujo independiente del formal.
  const [simpleOpen, setSimpleOpen] = useState(false);
  // El que cambió de opinión: el link discreto despliega las dos opciones.
  const [showChoices, setShowChoices] = useState(false);
  const simpleEmail = simpleInvoiceEmailFrom(simpleRequestEmail);

  // Pidieron la genérica, la cuenta ya está paga y la factura todavía no
  // aparece: el aviso de "pagada" (SSE) sale un instante ANTES de que
  // termine la emisión, así que el refresco que dispara puede llegar
  // temprano. Se reintenta unas pocas veces hasta que exista y aparezca el
  // botón de imprimir. Acotado: si la emisión quedó frenada (p. ej. rango
  // de numeración agotado) no se refresca para siempre.
  const [refreshTries, setRefreshTries] = useState(0);
  const waitingInvoice =
    isSimpleInvoiceRequested(simpleRequestEmail) &&
    orderPaid &&
    !issuedInvoiceUrl;
  useEffect(() => {
    if (!waitingInvoice || refreshTries >= 5) return;
    const id = setTimeout(() => {
      setRefreshTries((n) => n + 1);
      router.refresh();
    }, 3000);
    return () => clearTimeout(id);
  }, [waitingInvoice, refreshTries, router]);

  const sheets = (
    <>
      {open && (
        <InvoiceFormSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          initial={existing}
          prefillEmail={prefillEmail ?? simpleEmail}
          operatorMode={operatorMode}
          onClose={() => setOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}
      {simpleOpen && (
        <SimpleInvoiceSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          prefillEmail={prefillEmail ?? simpleEmail}
          operatorMode={operatorMode}
          onClose={() => setSimpleOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}
    </>
  );

  if (existing?.status === "generated") {
    return (
      <div className="rounded-2xl border border-ok/30 bg-ok/10 p-5">
        <div className="font-display text-lg text-ok">
          {"✓"} {t("invGeneratedTitle")}
        </div>
        <p className="text-sm text-ink-3 mt-1">
          {t.rich("invGeneratedBody", {
            email: existing.email,
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </div>
    );
  }

  if (existing?.status === "pending") {
    return (
      <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-display text-lg text-[#7F5A1F]">
              {t("invPendingTitle")}
            </div>
            <p className="text-sm text-ink-3 mt-1">
              {t.rich("invPendingBody", {
                email: existing.email,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <div className="text-xs text-ink-3 mt-3">
              <div>
                <strong>{existing.customerName}</strong> · {existing.docType}{" "}
                {existing.docNumber}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 h-9 px-3 rounded-full border border-[#7F5A1F]/40 text-[#7F5A1F] text-xs font-medium hover:bg-[#C98A2E]/10"
          >
            {t("invCorrectData")}
          </button>
        </div>
        {sheets}
      </div>
    );
  }

  // Pidió la genérica: confirmación corta, sin formulario. Con correo, ya
  // salió (o sale en cuanto se procese el cobro) a ese correo. Sin correo,
  // no se envía nada: se genera al confirmarse el cobro y queda para
  // imprimir. En los dos casos, si la factura ya existe, se puede imprimir.
  if (isSimpleInvoiceRequested(simpleRequestEmail)) {
    return (
      <div className="rounded-2xl border border-ok/30 bg-ok/10 p-5">
        <div className="font-display text-lg text-ok">
          {"✓"}{" "}
          {simpleEmail
            ? t("invSentTitle")
            : issuedInvoiceUrl
              ? t("invGeneratedReady")
              : t("invDeferredPrintTitle")}
        </div>
        <p className="text-sm text-ink-3 mt-1">
          {simpleEmail
            ? t.rich("invSentBody", {
                email: simpleEmail,
                b: (chunks) => <strong>{chunks}</strong>,
              })
            : issuedInvoiceUrl
              ? t("invGeneratedReadyBody")
              : t(
                  operatorMode
                    ? "invDeferredPrintBodyOp"
                    : "invDeferredPrintBody",
                )}
        </p>
        {issuedInvoiceUrl && (
          <a
            href={`${issuedInvoiceUrl}?print=1`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 block text-center w-full h-11 leading-[2.75rem] rounded-2xl bg-ink text-bone text-sm font-medium"
          >
            {t("invPrintInvoice")}
          </a>
        )}
        {/* Si la pidió recién desde acá, el sheet sigue abierto con su
            propio "listo" hasta que lo cierre (el refresh no lo tumba). */}
        {sheets}
      </div>
    );
  }

  // Nadie pidió factura en el checkout. Acceso discreto — no el panel grande.
  return (
    <>
      {showChoices ? (
        <div className="rounded-2xl border border-hairline bg-paper p-5">
          <div className="font-display text-lg">
            {t(operatorMode ? "invCheckoutTitleOp" : "invCheckoutTitle")}
          </div>
          <div className="mt-4">
            <InvoiceChoiceButtons
              operatorMode={operatorMode}
              onPickSimple={() => setSimpleOpen(true)}
              onPickFormal={() => setOpen(true)}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowChoices(true)}
          className="text-sm text-muted underline underline-offset-4 hover:text-ink"
        >
          {t(operatorMode ? "invLaterOp" : "invLater")}
        </button>
      )}
      {sheets}
    </>
  );
}
