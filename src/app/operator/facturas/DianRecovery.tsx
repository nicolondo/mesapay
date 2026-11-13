"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { DianRecoveryAction, DianRejectionCause } from "@/lib/dian/invoiceResponse";
import { adviceCauseKey } from "@/lib/dian/invoiceRowView";
import { blockReasonText } from "./EmissionBanner";

/**
 * Piezas sueltas para una factura que la DIAN no dejó aceptada por una
 * causa que ya no aplica (ver `dianRecoveryAdvice` en
 * src/lib/dian/invoiceResponse.ts). Autocontenidas a propósito: la fila de
 * Facturas las usa hoy, y un rediseño de la fila puede ponerlas como acción
 * principal o como ítem de un menú sin tocarlas.
 *
 *   · `DianCauseNotice`  — la causa en palabras claras y, abajo, el mensaje
 *     crudo de la DIAN (desplegable). Lo claro va primero: un mensaje
 *     guardado con la tilde rota («Se�or usuario…») no se puede arreglar,
 *     pero ya no es lo único que se lee.
 *   · `DianRecoveryButton` — «Reenviar a la DIAN» / «Consultar en la DIAN»
 *     (`POST /api/operator/dian/documents/[id]/recover`), con su resultado.
 *   · `useDianRecovery` — la misma acción sin el botón: la fila compacta de
 *     Facturas la pone como acción principal (o en el menú «⋯») y muestra el
 *     resultado debajo de la fila.
 */

export type DianAdvice = { cause: DianRejectionCause; action: DianRecoveryAction };

/** Claves de la causa: la sin confirmar (pending) tiene su propio texto. */
function causeKey(advice: DianAdvice, waiting: boolean): string {
  return adviceCauseKey(advice, waiting ? "in_process" : "rejected") ?? advice.cause;
}

export function DianCauseNotice({
  advice,
  errors,
  waiting = false,
  fallback,
}: {
  advice: DianAdvice;
  /** Mensajes de la DIAN tal cual quedaron guardados. */
  errors: readonly string[];
  /** true ⇒ la DIAN dijo tenerla y falta confirmarlo (no es un rechazo). */
  waiting?: boolean;
  /** Texto para la causa "other" (el motivo de siempre). */
  fallback?: string | null;
}) {
  const t = useTranslations("opEInvoices");
  const key = causeKey(advice, waiting);
  const known = advice.cause !== "other";
  return (
    <div className="mt-1 space-y-1">
      <p className={"text-[11px] break-words " + (waiting ? "text-op-muted" : "text-danger")}>
        {known ? t(`cause_${key}`) : fallback}
      </p>
      {known && <p className="text-[11px] text-op-muted break-words">{t(`causeDetail_${key}`)}</p>}
      {errors.length > 0 && (
        <details>
          <summary className="text-[11px] text-op-muted cursor-pointer">{t("dianRawTitle")}</summary>
          <ul className="mt-1 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i} className="font-mono text-[10px] text-op-muted break-all">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type RecoverResponse = {
  result?: { outcome: string; reason?: string | null };
  error?: string;
};

export function DianRecoveryButton({
  documentId,
  action,
  invoiceNumber,
  variant = "button",
}: {
  documentId: string;
  action: Exclude<DianRecoveryAction, "none">;
  /** Para la confirmación del reenvío («mismo número FESM7913»). */
  invoiceNumber: string;
  /** "menuItem": sin borde, a todo el ancho, para un menú «⋯». */
  variant?: "button" | "menuItem";
}) {
  const recovery = useDianRecovery(documentId, action, invoiceNumber);
  return (
    <>
      <button
        type="button"
        onClick={recovery.run}
        disabled={recovery.busy}
        className={
          variant === "menuItem"
            ? "w-full text-left px-3 py-2 text-sm hover:bg-op-bg disabled:opacity-60"
            : "mp-btn mp-btn--secondary mp-btn--sm"
        }
      >
        {recovery.label}
      </button>
      {recovery.msg && (
        <span
          role="status"
          className={"basis-full text-[11px] " + (recovery.msg.ok ? "text-[#1E5339]" : "text-danger")}
        >
          {recovery.msg.text}
        </span>
      )}
    </>
  );
}

export type DianRecoveryState = {
  run: () => Promise<void>;
  busy: boolean;
  msg: { ok: boolean; text: string } | null;
  /** «Reenviar a la DIAN» / «Consultar en la DIAN» (o su texto de espera). */
  label: string;
};

/**
 * «Reenviar a la DIAN» / «Consultar en la DIAN» sin botón propio. `action`
 * null ⇒ la factura no tiene acción recomendada y `run` no hace nada (el
 * hook se llama igual en todas las filas).
 */
export function useDianRecovery(
  documentId: string,
  action: Exclude<DianRecoveryAction, "none"> | null,
  invoiceNumber: string,
): DianRecoveryState {
  const t = useTranslations("opEInvoices");
  const tf = useTranslations("opFacturas");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const resend = action === "resend";

  function outcomeText(r: NonNullable<RecoverResponse["result"]>): { ok: boolean; text: string } {
    switch (r.outcome) {
      case "accepted":
        return { ok: true, text: t("recoverAccepted") };
      case "pending":
        return { ok: true, text: t("recoverPending") };
      case "unverified":
        return { ok: false, text: t("recoverUnverified") };
      case "rejected":
        return {
          ok: false,
          text: r.reason ? t("recoverRejected", { reason: r.reason }) : t("recoverRejectedNoReason"),
        };
      case "blocked":
        return {
          ok: false,
          text: t(resend ? "retryBlocked" : "recoverCheckBlocked", {
            reason: blockReasonText(r.reason ?? "", tf),
          }),
        };
      case "already":
        return { ok: false, text: t("recoverAlready") };
      case "not_applicable":
        return { ok: false, text: t("recoverChanged") };
      default:
        return { ok: false, text: t("recoverError") };
    }
  }

  async function run() {
    if (busy || !action) return;
    if (resend && !window.confirm(t("resendConfirm", { number: invoiceNumber }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/operator/dian/documents/${documentId}/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => null)) as RecoverResponse | null;
      if (res.status === 429) setMsg({ ok: false, text: t("recoverRateLimited") });
      else if (data?.result) setMsg(outcomeText(data.result));
      else setMsg({ ok: false, text: t("recoverFailed") });
      startTx(() => router.refresh());
    } catch {
      setMsg({ ok: false, text: t("recoverFailed") });
    } finally {
      setBusy(false);
    }
  }

  const label = busy
    ? t(resend ? "actionResending" : "actionChecking")
    : t(resend ? "actionResend" : "actionCheck");
  return { run, busy, msg, label };
}
