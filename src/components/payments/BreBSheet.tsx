"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";
import {
  breBSecondsLeft,
  formatBreBCountdown,
  isBreBOpenState,
  type BreBChargeView,
} from "@/lib/payments/breB/view";

/**
 * De dónde sale el cobro: un pago de una cuenta, o el intento de un link de
 * pago de monto fijo (que no tiene pago).
 */
export type BreBSource =
  | { kind: "payment"; tenantSlug: string; paymentId: string }
  | { kind: "link"; tenantSlug: string; token: string; chargeId: string };

/**
 * Por qué se cerró la pantalla del QR:
 *   canceled / declined / expired — terminó sin pago.
 *   dismissed — quedó «sin confirmar» y se cerró el aviso (el cobro sigue).
 *   hidden    — el staff ocultó el código; el cobro sigue ACTIVO.
 */
export type BreBCloseReason = "canceled" | "declined" | "expired" | "dismissed" | "hidden";

function endpoint(source: BreBSource): string {
  return source.kind === "payment"
    ? `/api/tenant/${source.tenantSlug}/payment/${source.paymentId}/bre-b`
    : `/api/tenant/${source.tenantSlug}/pay-links/${source.token}/bre-b`;
}

/** Cada cuánto se le pregunta a MESAPAY (que a su vez dosifica a Kushki). */
const POLL_MS = 3000;

/**
 * Lo ÚNICO que se pinta como QR: el PNG incrustado que entrega Kushki. El
 * servidor ya lo validó; acá se vuelve a mirar el prefijo antes de ponerlo
 * en un `<img src>` (nunca se interpreta como HTML).
 */
function safeQr(value: string | null | undefined): string | null {
  return typeof value === "string" && value.startsWith("data:image/png;base64,") ? value : null;
}

/**
 * Pantalla del QR Bre-B, a pantalla completa en el celular. La misma para
 * el comensal (paga desde la app de su banco) y para el staff (muestra el
 * código en SU dispositivo para que el cliente lo escanee).
 *
 *   · QR grande con el monto, y «Guardar código QR» para quien paga desde
 *     el mismo celular: no puede escanear su propia pantalla, pero la app de
 *     su banco puede leer el QR desde sus fotos.
 *   · Cuenta regresiva (el QR vence a los 10 minutos) con la hora del
 *     SERVIDOR. Vencido, se ofrece generar uno nuevo.
 *   · Estado en vivo: los avisos del comercio (SSE) y un sondeo cada 3 s.
 *   · Salir o cambiar de medio CANCELA el código en Kushki: no pueden entrar
 *     dos pagos por la misma cuenta. Si la cancelación no se puede
 *     confirmar, el cobro queda «sin confirmar» y la pantalla lo dice: no se
 *     ofrece otro medio como si nada.
 */
export function BreBSheet({
  source,
  initial = null,
  operatorMode = false,
  onApproved,
  onClosed,
  onRetry,
}: {
  source: BreBSource;
  /** El cobro recién creado (ya trae el QR). Sin él, se pide al abrir. */
  initial?: BreBChargeView | null;
  operatorMode?: boolean;
  onApproved: (view: BreBChargeView) => void;
  /** Volver a los medios de pago, con el motivo para el aviso. */
  onClosed: (reason: BreBCloseReason) => void;
  /** El código venció: generar uno nuevo por el mismo monto. */
  onRetry?: () => void;
}) {
  const t = useTranslations("breB");
  const locale = useLocale() as Locale;
  const url = endpoint(source);
  const [view, setView] = useState<BreBChargeView | null>(initial);
  const [qr, setQr] = useState<string | null>(safeQr(initial?.qrImage));
  // Reloj del servidor: diferencia con el del teléfono al último dato.
  const [offsetMs, setOffsetMs] = useState(() =>
    initial ? Date.parse(initial.serverNow) - Date.now() : 0,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState<"check" | "cancel" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const finished = useRef(false);
  const requesting = useRef(false);
  // `onClosed` cambia en cada render del padre: se lee siempre el último.
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((next: BreBChargeView) => {
    if (!alive.current) return;
    setView(next);
    setOffsetMs(Date.parse(next.serverNow) - Date.now());
    // El sondeo no trae el QR (no cambia): se conserva el que ya está.
    if (next.qrImage !== undefined) setQr(safeQr(next.qrImage));
  }, []);

  const request = useCallback(
    async (action: "load" | "check" | "cancel", force = false): Promise<BreBChargeView | null> => {
      try {
        const res =
          action === "load"
            ? await fetch(url, { cache: "no-store" })
            : await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(
                  source.kind === "payment"
                    ? { action, ...(force ? { force: true } : {}) }
                    : { action, chargeId: source.chargeId },
                ),
              });
        const json = (await res.json().catch(() => ({}))) as { charge?: BreBChargeView | null };
        // El cobro que se quería retomar ya no existe (o no es de esta
        // cuenta): no hay nada que mostrar ni que cancelar.
        if (action === "load" && (res.status === 404 || (res.ok && json.charge === null))) {
          finished.current = true;
          onClosedRef.current("hidden");
          return null;
        }
        if (!res.ok || !json.charge) return null;
        apply(json.charge);
        return json.charge;
      } catch {
        return null;
      }
    },
    [apply, source, url],
  );

  // Sin QR a mano (se retomó el cobro, o se recargó la página): se pide.
  useEffect(() => {
    if (safeQr(initial?.qrImage)) return;
    const timer = setTimeout(() => void request("load"), 0);
    return () => clearTimeout(timer);
    // Sólo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = view?.state ?? "creating";
  const open = isBreBOpenState(state);

  const poll = useCallback(async () => {
    if (requesting.current || finished.current) return;
    requesting.current = true;
    try {
      await request("check");
    } finally {
      requesting.current = false;
    }
  }, [request]);

  // Sondeo de respaldo mientras el cobro siga abierto.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, poll]);

  // Avisos en vivo del comercio (pago aprobado / rechazado): consulta ya.
  useVisibleEventSource(
    `/api/tenant/${source.tenantSlug}/events`,
    (es) => es.addEventListener("message", () => void poll()),
    () => void poll(),
    { enabled: open && source.kind === "payment" },
  );

  // Cuenta regresiva.
  useEffect(() => {
    if (state !== "active") return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state]);
  const secondsLeft = state === "active" ? breBSecondsLeft(view?.expiresAt ?? null, nowMs + offsetMs) : null;
  // Al llegar a cero se consulta de inmediato: el servidor lo vence o lo salda.
  const expiredOnce = useRef(false);
  useEffect(() => {
    if (secondsLeft !== 0 || expiredOnce.current) return;
    expiredOnce.current = true;
    void poll();
  }, [secondsLeft, poll]);

  // Resultados finales.
  useEffect(() => {
    if (!view || finished.current) return;
    if (view.state === "approved") {
      finished.current = true;
      const timer = setTimeout(() => onApproved(view), 1200);
      return () => clearTimeout(timer);
    }
    if (view.state === "canceled") {
      finished.current = true;
      onClosed("canceled");
      return;
    }
    if (view.state === "declined") {
      finished.current = true;
      const timer = setTimeout(() => onClosed("declined"), 2200);
      return () => clearTimeout(timer);
    }
    // Vencido: se queda en pantalla para ofrecer un código nuevo.
    if (view.state === "expired") finished.current = true;
    // onApproved / onClosed cambian en cada render del padre; sólo importa el estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function cancel() {
    if (busy) return;
    if (operatorMode && !window.confirm(t("cancelConfirm"))) return;
    setBusy("cancel");
    setNote(null);
    const after = await request("cancel");
    if (!alive.current) return;
    setBusy(null);
    if (!after) setNote(t("errNetwork"));
  }

  async function checkNow() {
    if (busy) return;
    setBusy("check");
    setNote(null);
    const after = await request("check", true);
    if (!alive.current) return;
    setBusy(null);
    if (!after) setNote(t("errNetwork"));
    else if (after.state === "uncertain") setNote(t("stillUncertain"));
  }

  /**
   * Para pagar desde el mismo celular: la imagen del QR va a las fotos (hoja
   * de compartir del sistema) o, donde no la hay, se descarga. La app del
   * banco la lee desde ahí.
   */
  async function saveQr() {
    if (!qr) return;
    setNote(null);
    try {
      const blob = await (await fetch(qr)).blob();
      const file = new File([blob], "bre-b-qr.png", { type: "image/png" });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const link = document.createElement("a");
        link.href = qr;
        link.download = "bre-b-qr.png";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
      setSaved(true);
      setTimeout(() => alive.current && setSaved(false), 2500);
    } catch (err) {
      // Cerrar la hoja de compartir no es un error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setNote(t("saveFailed"));
    }
  }

  const amount = view
    ? formatMoney(view.amountCents, {
        currency: view.currency,
        locale,
        fractionDigits: view.amountCents % 100 ? 2 : 0,
      })
    : "";

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-bone text-ink"
      role="dialog"
      aria-modal="true"
      aria-label={operatorMode ? t("titleCharge") : t("titlePay")}
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-5 py-8">
        {state === "approved" && (
          <Result tone="ok" icon="✓" title={t("approvedTitle")} body={t("approvedBody")} />
        )}

        {(state === "declined" || state === "canceled") && (
          <Result tone="danger" icon="✕" title={t("declinedTitle")} body={t("declinedBody")}>
            <button type="button" className="mp-pay mp-pay--ink text-sm" onClick={() => onClosed("declined")}>
              {t("chooseOther")}
            </button>
          </Result>
        )}

        {state === "expired" && (
          <Result tone="muted" icon="⏱" title={t("expiredTitle")} body={t("expiredBody")}>
            {onRetry && (
              <button type="button" className="mp-pay mp-pay--ink text-sm" onClick={onRetry}>
                {t("newCode")}
              </button>
            )}
            <button
              type="button"
              className={"mp-pay text-sm " + (onRetry ? "mp-pay--outline" : "mp-pay--ink")}
              onClick={() => onClosed("expired")}
            >
              {t("chooseOther")}
            </button>
          </Result>
        )}

        {state === "uncertain" && (
          <Result
            tone="warn"
            icon="!"
            title={t("uncertainTitle")}
            body={operatorMode ? t("uncertainBodyOp") : t("uncertainBody")}
          >
            {amount && <div className="font-display text-3xl tabular">{amount}</div>}
            <button
              type="button"
              className="mp-pay mp-pay--ink text-sm"
              disabled={busy !== null}
              onClick={checkNow}
            >
              {busy === "check" ? t("checking") : t("checkStatus")}
            </button>
            <button
              type="button"
              className="mp-pay mp-pay--outline text-sm"
              disabled={busy !== null}
              onClick={() => onClosed("dismissed")}
            >
              {t("close")}
            </button>
            {note && (
              <p className="text-sm text-muted" role="status">
                {note}
              </p>
            )}
          </Result>
        )}

        {(state === "creating" || state === "active") && (
          <>
            <div className="text-center">
              <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
                {operatorMode ? t("amountLabelOp") : t("amountLabel")}
              </div>
              <div className="font-display text-5xl tracking-[-0.015em] tabular mt-1">{amount}</div>
              <h1 className="font-display text-2xl mt-3">{operatorMode ? t("titleCharge") : t("titlePay")}</h1>
            </div>

            <div className="mt-5 rounded-3xl border border-hairline bg-white p-4">
              {qr ? (
                // PNG incrustado (data URI) que entrega Kushki: `next/image` no aplica.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qr}
                  alt={t("qrAlt", { amount })}
                  className="mx-auto block aspect-square w-full max-w-[340px]"
                />
              ) : (
                <div
                  className="mx-auto flex aspect-square w-full max-w-[340px] items-center justify-center text-sm text-muted"
                  role="status"
                >
                  {t("preparing")}
                </div>
              )}
            </div>

            <p className="mt-4 text-center text-sm text-muted">
              {operatorMode ? t("scanHintOp") : t("scanHint")}
            </p>

            {secondsLeft != null && (
              <div className="mt-3 flex items-center justify-center gap-2 text-sm" role="timer" aria-live="off">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-terracotta animate-pulse" aria-hidden />
                <span>
                  {t.rich("expiresIn", {
                    time: formatBreBCountdown(secondsLeft),
                    b: (chunks) => <span className="font-mono tabular">{chunks}</span>,
                  })}
                </span>
              </div>
            )}
            <p className="mt-1 text-center text-xs text-muted-2" role="status" aria-live="polite">
              {t("waiting")}
            </p>

            {qr && (
              <div className="mt-5 rounded-2xl border border-hairline bg-paper p-4">
                <div className="text-sm font-medium">
                  {operatorMode ? t("samePhoneTitleOp") : t("samePhoneTitle")}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {operatorMode ? t("samePhoneBodyOp") : t("samePhoneBody")}
                </p>
                <button
                  type="button"
                  onClick={saveQr}
                  className="mt-3 w-full min-h-11 rounded-full border border-hairline bg-ivory text-sm font-medium"
                >
                  {saved ? t("saved") : t("saveQr")}
                </button>
              </div>
            )}

            {note && (
              <p className="mt-3 text-center text-sm text-danger" role="alert">
                {note}
              </p>
            )}

            <div className="mt-6 space-y-2">
              {operatorMode && (
                <button
                  type="button"
                  className="mp-pay mp-pay--ink text-sm"
                  disabled={busy !== null}
                  onClick={checkNow}
                >
                  {busy === "check" ? t("checking") : t("checkStatus")}
                </button>
              )}
              <button
                type="button"
                className="mp-pay mp-pay--outline text-sm"
                disabled={busy !== null}
                onClick={cancel}
              >
                {busy === "cancel" ? t("cancelling") : operatorMode ? t("cancelCharge") : t("chooseOther")}
              </button>
              {/* El staff puede dejar de mirar el código sin cancelarlo: el
                  cobro sigue en curso y aparece en los pagos pendientes. */}
              {operatorMode && state === "active" && (
                <button
                  type="button"
                  className="w-full min-h-11 text-sm text-muted underline"
                  disabled={busy !== null}
                  onClick={() => onClosed("hidden")}
                >
                  {t("hideCode")}
                </button>
              )}
              {view?.mockUrl && (
                <a
                  href={view.mockUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block pt-2 text-center text-xs text-terracotta underline"
                >
                  {t("mockLink")}
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Result({
  tone,
  icon,
  title,
  body,
  children,
}: {
  tone: "ok" | "danger" | "warn" | "muted";
  icon: string;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  const ring =
    tone === "ok"
      ? "bg-ok/20 text-ok"
      : tone === "danger"
        ? "bg-danger/20 text-danger"
        : tone === "warn"
          ? "bg-terracotta/15 text-terracotta"
          : "bg-hairline text-muted";
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center" role="status" aria-live="polite">
      <div
        className={`flex h-14 w-14 items-center justify-center rounded-full font-display text-3xl ${ring}`}
        aria-hidden
      >
        {icon}
      </div>
      <h1 className="font-display text-3xl tracking-[-0.015em] mt-4">{title}</h1>
      <p className="mt-2 max-w-xs text-sm text-muted">{body}</p>
      {children && <div className="mt-6 w-full max-w-xs space-y-2">{children}</div>}
    </div>
  );
}
