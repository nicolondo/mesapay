"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney, localeTag } from "@/lib/format";
import { useBackdropClose } from "@/lib/useBackdropClose";
import type { Locale } from "@/i18n/config";
import type { BlockerCode, DeletionCounts, WarningCode } from "@/lib/restaurantDeletion";
import {
  OPERATOR_DESTINATION_PATH,
  deleteGate,
  resolutionFor,
  type BlockerAction,
  type OperatorDestination,
} from "@/lib/restaurantDeletion/resolution";

/**
 * Zona de peligro: ELIMINAR el comercio con toda su información (sólo
 * platform_admin; ver src/lib/restaurantDeletion). El diálogo pide al
 * servidor el resumen —conteos, bloqueos y avisos—, exige tipear el slug
 * exacto y avisa que no se puede deshacer. El servidor vuelve a validar el
 * slug y los bloqueos: el botón deshabilitado es comodidad, no seguridad.
 *
 * Cada bloqueo dice qué hacer. Si hay una transición segura (anular las
 * solicitudes de cobro, anular links, cancelar el débito) se ofrece acá, con
 * una confirmación corta; si no (plata en vuelo, documentos DIAN), se explica
 * y se ofrece entrar como el comercio en la pantalla donde se resuelve. El
 * campo del slug se puede usar siempre: lo que se deshabilita es el botón, con
 * el motivo debajo del campo.
 */
type Preview = {
  restaurant: { id: string; name: string; slug: string };
  counts: DeletionCounts;
  blockers: { code: BlockerCode; count: number; detail?: string[] }[];
  warnings: { code: WarningCode; count?: number; text?: string; amountCents?: number; currency?: string }[];
};

const COUNT_KEYS: (keyof DeletionCounts)[] = [
  "orders",
  "payments",
  "invoices",
  "dianInvoices",
  "creditNotes",
  "users",
  "ingredients",
  "journalEntries",
  "files",
];

type ResolveResponse = {
  ok?: boolean;
  error?: string;
  reason?: string;
  detail?: string;
  preview?: Preview | null;
};

const SUBSCRIPTION_ERRORS = new Set(["billing_not_configured", "provider_rejected", "provider_unavailable"]);

const KNOWN_ERRORS = new Set([
  "confirm_mismatch",
  "blocked",
  "archive_too_large",
  "concurrent_activity",
  "leftover_rows",
  "not_found",
]);

export function DeleteRestaurantPanel({
  restaurantId,
  slug,
  name,
}: {
  restaurantId: string;
  slug: string;
  name: string;
}) {
  const t = useTranslations("adminDelete");
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-2xl border-2 border-danger/60 bg-danger/5 p-5 mb-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-danger">{t("zoneTitle")}</div>
      <p className="text-sm mt-1 text-op-muted">{t("zoneIntro")}</p>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => setOpen(true)} className="mp-btn mp-btn--danger-solid mp-btn--sm">
          {t("openButton")}
        </button>
      </div>
      {open && (
        <DeleteDialog restaurantId={restaurantId} slug={slug} name={name} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function DeleteDialog({
  restaurantId,
  slug,
  name,
  onClose,
}: {
  restaurantId: string;
  slug: string;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations("adminDelete");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed">("loading");
  const [slugInput, setSlugInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Acciones sobre los bloqueos: cuál pide confirmación, cuál está corriendo
  // y el error de la última corrida de cada una.
  const [confirming, setConfirming] = useState<BlockerAction | null>(null);
  const [running, setRunning] = useState<BlockerAction | null>(null);
  const [actionErrors, setActionErrors] = useState<Partial<Record<BlockerAction, string>>>({});
  const [opening, setOpening] = useState<OperatorDestination | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const working = busy || running !== null || opening !== null;
  const backdrop = useBackdropClose(() => {
    if (!working) onClose();
  });

  const previewUrl = `/api/admin/restaurants/${restaurantId}/delete`;
  const [attempt, setAttempt] = useState(0);

  function retry() {
    setLoadState("loading");
    setAttempt((n) => n + 1);
  }

  /** Vuelve a pedir el resumen sin vaciar el diálogo (lo de ahora queda a la vista). */
  function refresh() {
    setAttempt((n) => n + 1);
  }

  // Carga perezosa: los conteos sólo se piden cuando se abre el diálogo (y
  // otra vez con "Reintentar"). El estado se toca en los callbacks.
  useEffect(() => {
    let alive = true;
    fetch(previewUrl, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<Preview>;
      })
      .then((data) => {
        if (!alive) return;
        setPreview(data);
        setLoadState("idle");
      })
      .catch(() => {
        if (alive) setLoadState("failed");
      });
    return () => {
      alive = false;
    };
  }, [previewUrl, attempt]);

  const numberFmt = new Intl.NumberFormat(localeTag(locale));

  const gate = deleteGate({ blockerCount: preview?.blockers.length ?? 0, slugInput, slug });
  const blocked = gate.reason === "blocked";
  const canConfirm = !!preview && gate.canDelete && !working;
  const reasonId = "delete-restaurant-reason";

  function actionErrorText(body: ResolveResponse): string {
    if (body.error === "subscription_cancel_failed" && body.reason && SUBSCRIPTION_ERRORS.has(body.reason)) {
      return t(`subscriptionError_${body.reason}`, { detail: body.detail ?? "" });
    }
    return t("actionError_generic");
  }

  async function runAction(action: BlockerAction) {
    setConfirming(null);
    setRunning(action);
    setActionErrors((prev) => ({ ...prev, [action]: undefined }));
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantId}/delete/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => ({}))) as ResolveResponse;
      // El servidor devuelve el resumen recalculado (también si falló).
      if (body.preview) setPreview(body.preview);
      else refresh();
      if (!res.ok) setActionErrors((prev) => ({ ...prev, [action]: actionErrorText(body) }));
    } catch {
      setActionErrors((prev) => ({ ...prev, [action]: t("actionError_generic") }));
      refresh();
    } finally {
      setRunning(null);
    }
  }

  /** Entra como el comercio (igual que "Entrar como operador") y abre la pantalla donde se resuelve. */
  async function openAsRestaurant(destination: OperatorDestination) {
    setOpening(destination);
    setOpenError(null);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restaurantId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      window.location.assign(OPERATOR_DESTINATION_PATH[destination]);
    } catch {
      setOpenError(t("openFailed"));
      setOpening(null);
    }
  }

  async function confirm() {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantId}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmSlug: slugInput }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        blockers?: Preview["blockers"];
      };
      if (!res.ok) {
        if (body.error === "blocked" && body.blockers && preview) setPreview({ ...preview, blockers: body.blockers });
        setError(body.error && KNOWN_ERRORS.has(body.error) ? t(`error_${body.error}`) : t("error_generic"));
        setBusy(false);
        return;
      }
      router.push(`/admin/restaurants/eliminados?deleted=${encodeURIComponent(slug)}`);
      router.refresh();
    } catch {
      setError(t("error_generic"));
      setBusy(false);
    }
  }

  function warningText(w: Preview["warnings"][number]): string {
    if (w.code === "wallet_balance") {
      return t("warning_wallet_balance", {
        amount: formatMoney(w.amountCents ?? 0, { currency: w.currency, locale }),
      });
    }
    if (w.code === "group_member") return t("warning_group_member", { name: w.text ?? "" });
    return t(`warning_${w.code}`, { count: w.count ?? 0 });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      {...backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("dialogTitle", { name })}
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border-2 border-danger/60 p-5 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="font-display text-2xl text-danger">{t("dialogTitle", { name })}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={working}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        </div>

        {loadState === "loading" && <p className="text-sm text-op-muted">{t("loading")}</p>}
        {loadState === "failed" && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-danger">{t("loadFailed")}</p>
            <button type="button" onClick={retry} className="mp-btn mp-btn--secondary mp-btn--sm">
              {t("retry")}
            </button>
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            <div>
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
                {t("willDelete")}
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {COUNT_KEYS.map((key) => (
                  <div key={key} className="rounded-xl border border-op-border bg-op-bg/40 px-3 py-2">
                    <dt className="text-[11px] text-op-muted">{t(`count_${key}`)}</dt>
                    <dd className="font-mono tabular text-lg">{numberFmt.format(preview.counts[key])}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {blocked && (
              <div className="rounded-xl border border-danger/50 bg-danger/10 p-3">
                <div className="text-sm font-medium text-danger">{t("blockersTitle")}</div>
                <ul className="mt-2 space-y-3 text-sm">
                  {preview.blockers.map((b) => {
                    const resolution = resolutionFor(b.code);
                    const action = resolution.kind === "action" ? resolution.action : null;
                    const actionError = action ? actionErrors[action] : undefined;
                    return (
                      <li key={b.code} className="space-y-2">
                        <p>{t(`blocker_${b.code}`, { count: b.count, detail: (b.detail ?? []).join(", ") })}</p>
                        {action && confirming === action && (
                          <div className="rounded-lg border border-danger/40 bg-op-surface p-2 space-y-2">
                            <p className="text-xs">{t(`confirm_${action}`, { count: b.count })}</p>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => runAction(action)}
                                disabled={working}
                                className="mp-btn mp-btn--danger-solid mp-btn--sm"
                              >
                                {t(`confirmYes_${action}`)}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirming(null)}
                                className="mp-btn mp-btn--secondary mp-btn--sm"
                              >
                                {t("actionBack")}
                              </button>
                            </div>
                          </div>
                        )}
                        {action && confirming !== action && (
                          <button
                            type="button"
                            onClick={() => setConfirming(action)}
                            disabled={working}
                            aria-busy={running === action}
                            className="mp-btn mp-btn--danger mp-btn--sm"
                          >
                            {running === action ? t(`running_${action}`) : t(`action_${action}`, { count: b.count })}
                          </button>
                        )}
                        {resolution.kind === "operator" && (
                          <button
                            type="button"
                            onClick={() => openAsRestaurant(resolution.destination)}
                            disabled={working}
                            aria-busy={opening === resolution.destination}
                            className="mp-btn mp-btn--secondary mp-btn--sm"
                          >
                            {opening === resolution.destination ? t("opening") : t(`goto_${resolution.destination}`)}
                          </button>
                        )}
                        {actionError && (
                          <p className="text-xs text-danger" role="alert">
                            {actionError}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {openError && (
                  <p className="mt-2 text-xs text-danger" role="alert">
                    {openError}
                  </p>
                )}
              </div>
            )}

            {preview.warnings.length > 0 && (
              <div className="rounded-xl border border-[#C98A2E]/50 bg-[#C98A2E]/10 p-3">
                <div className="text-sm font-medium text-[#7F5A1F]">{t("warningsTitle")}</div>
                <ul className="mt-1 list-disc pl-5 space-y-1 text-sm">
                  {preview.warnings.map((w) => (
                    <li key={w.code}>{warningText(w)}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-2 text-xs text-op-muted">
              <p>{t("archiveNote")}</p>
              <p>{t("usersNote")}</p>
              <p>{t("keptNote")}</p>
              <p>{t("impersonationNote")}</p>
            </div>

            <div className="rounded-xl border border-danger/40 bg-op-bg/40 p-3 space-y-2">
              <p className="text-sm font-medium text-danger">{t("irreversible")}</p>
              <label className="block text-xs text-op-muted" htmlFor="delete-restaurant-slug">
                {t.rich("typeSlug", {
                  slug,
                  code: (chunks) => <span className="font-mono text-op-text">{chunks}</span>,
                })}
              </label>
              <input
                id="delete-restaurant-slug"
                type="text"
                value={slugInput}
                onChange={(e) => {
                  setSlugInput(e.target.value);
                  setError(null);
                }}
                placeholder={slug}
                aria-label={t("slugLabel")}
                aria-describedby={gate.reason ? reasonId : undefined}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                // Siempre editable (también con bloqueos): lo que se deshabilita es el botón.
                disabled={gate.slugFieldDisabled}
                className="w-full px-3 h-10 rounded-lg border border-op-border bg-op-bg text-sm font-mono"
              />
              {gate.reason && (
                <p id={reasonId} className={`text-xs ${blocked ? "text-danger" : "text-op-muted"}`}>
                  {t(`reason_${gate.reason}`)}
                </p>
              )}
              {error && <div className="text-xs text-danger" role="alert">{error}</div>}
            </div>

            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={onClose} disabled={working} className="mp-btn mp-btn--secondary mp-btn--sm">
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={!canConfirm}
                aria-describedby={gate.reason ? reasonId : undefined}
                className="mp-btn mp-btn--danger-solid mp-btn--sm"
              >
                {busy ? t("busy") : t("confirmCta")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
