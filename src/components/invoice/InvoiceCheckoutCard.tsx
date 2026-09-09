"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { InvoiceChoiceButtons } from "./InvoiceChoiceButtons";
import { InvoiceFormSheet } from "./InvoiceFormSheet";
import { SimpleInvoiceSheet } from "./SimpleInvoiceSheet";
import type { InvoiceIntent } from "./types";

/**
 * La pregunta por la factura, DENTRO del checkout — antes de confirmar el
 * pago, que es cuando el comensal todavía tiene el celular en la mano y la
 * intención fresca. Antes vivía en la pantalla posterior al cobro, cuando ya
 * estaba guardando el teléfono.
 *
 * Los datos se mandan al servidor apenas completa el formulario, sin esperar
 * al pago: si después paga en efectivo y el mesero confirma diez minutos más
 * tarde, la solicitud ya está guardada y la factura sale sola.
 *
 * Una vez cargados, acá queda un resumen corto (una línea) con opción de
 * corregir — no el formulario abierto ocupando media pantalla de cobro.
 */
export function InvoiceCheckoutCard({
  tenantSlug,
  orderId,
  initialIntent = null,
  prefillEmail = null,
  operatorMode = false,
}: {
  tenantSlug: string;
  orderId: string;
  /** Lo que ya se había pedido en esta cuenta (sobrevive a un refresh). */
  initialIntent?: InvoiceIntent | null;
  prefillEmail?: string | null;
  /** El mesero cobra por el cliente: la copia va en tercera persona. */
  operatorMode?: boolean;
}) {
  const t = useTranslations("done");
  const [intent, setIntent] = useState<InvoiceIntent | null>(initialIntent);
  const [formOpen, setFormOpen] = useState(false);
  const [simpleOpen, setSimpleOpen] = useState(false);

  return (
    <section className="mt-6 rounded-2xl border border-hairline bg-paper p-5">
      {intent ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-ok">
              {t("invRequested")}
            </div>
            <p className="text-sm mt-1 break-words">
              {intent.kind === "formal"
                ? t("invSummaryPerson", {
                    name: intent.summary.customerName,
                    doc: `${intent.summary.docType} ${intent.summary.docNumber}`,
                  })
                : t("invSummaryGeneric", { email: intent.email })}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              intent.kind === "formal" ? setFormOpen(true) : setSimpleOpen(true)
            }
            className="shrink-0 h-9 px-3 rounded-full border border-hairline text-xs font-medium hover:bg-ivory"
          >
            {t("invCorrectData")}
          </button>
        </div>
      ) : (
        <>
          <div className="font-display text-xl">
            {t(operatorMode ? "invCheckoutTitleOp" : "invCheckoutTitle")}
          </div>
          <p className="text-sm text-muted mt-1">
            {t(operatorMode ? "invCheckoutIntroOp" : "invCheckoutIntro")}
          </p>
          <div className="mt-4">
            <InvoiceChoiceButtons
              operatorMode={operatorMode}
              onPickSimple={() => setSimpleOpen(true)}
              onPickFormal={() => setFormOpen(true)}
            />
          </div>
        </>
      )}

      {formOpen && (
        <InvoiceFormSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          initial={intent?.kind === "formal" ? intent.summary : null}
          prefillEmail={
            intent?.kind === "simple" ? intent.email : prefillEmail
          }
          beforePayment
          operatorMode={operatorMode}
          onClose={() => setFormOpen(false)}
          onSaved={(summary) => setIntent({ kind: "formal", summary })}
        />
      )}
      {simpleOpen && (
        <SimpleInvoiceSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          prefillEmail={intent?.kind === "simple" ? intent.email : prefillEmail}
          beforePayment
          operatorMode={operatorMode}
          onClose={() => setSimpleOpen(false)}
          onSaved={(email) => setIntent({ kind: "simple", email })}
        />
      )}
    </section>
  );
}
