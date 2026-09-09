"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { InvoiceChoiceButtons } from "@/components/invoice/InvoiceChoiceButtons";
import { InvoiceFormSheet } from "@/components/invoice/InvoiceFormSheet";
import { SimpleInvoiceSheet } from "@/components/invoice/SimpleInvoiceSheet";
import type { InvoiceRequestSummary } from "@/components/invoice/types";

/**
 * Estado de la factura DESPUÉS del pago.
 *
 * La pregunta grande ya no vive acá: se hace en el checkout
 * (`InvoiceCheckoutCard`), cuando el comensal todavía está pagando. Acá queda
 * lo que corresponde a esta pantalla:
 *
 *  - Si ya pidió factura → el estado (pendiente / generada) y "corregir datos".
 *  - Si no pidió nada → un acceso discreto, para el que cambió de opinión.
 *    No se elimina del todo: sin esa salida, el que se arrepiente queda
 *    colgado y termina pidiéndosela al mesero.
 */
export function InvoiceRequestPanel({
  tenantSlug,
  orderId,
  existing,
  simpleRequestEmail = null,
  prefillEmail = null,
  operatorMode = false,
}: {
  tenantSlug: string;
  orderId: string;
  existing: InvoiceRequestSummary | null;
  /**
   * Correo que dejó en el checkout para la factura genérica (sin datos
   * personales). Se muestra como confirmación en vez del panel grande.
   */
  simpleRequestEmail?: string | null;
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

  const sheets = (
    <>
      {open && (
        <InvoiceFormSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          initial={existing}
          prefillEmail={prefillEmail ?? simpleRequestEmail}
          operatorMode={operatorMode}
          onClose={() => setOpen(false)}
          onSaved={() => router.refresh()}
        />
      )}
      {simpleOpen && (
        <SimpleInvoiceSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          prefillEmail={prefillEmail ?? simpleRequestEmail}
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
              <div className="mt-0.5">
                {existing.address}, {existing.city}, {existing.department}
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

  // Pidió la genérica en el checkout: ya salió (o sale en cuanto se procese
  // el cobro) al correo que dejó. Confirmación corta, sin formulario.
  if (simpleRequestEmail) {
    return (
      <div className="rounded-2xl border border-ok/30 bg-ok/10 p-5">
        <div className="font-display text-lg text-ok">
          {"✓"} {t("invSentTitle")}
        </div>
        <p className="text-sm text-ink-3 mt-1">
          {t.rich("invSentBody", {
            email: simpleRequestEmail,
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
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
