"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney, localeTag } from "@/lib/format";
import { useBackdropClose } from "@/lib/useBackdropClose";
import type { Locale } from "@/i18n/config";
import type { BlockerCode, DeletionCounts, WarningCode } from "@/lib/restaurantDeletion";

/**
 * Zona de peligro: ELIMINAR el comercio con toda su información (sólo
 * platform_admin; ver src/lib/restaurantDeletion). El diálogo pide al
 * servidor el resumen —conteos, bloqueos y avisos—, exige tipear el slug
 * exacto y avisa que no se puede deshacer. El servidor vuelve a validar el
 * slug y los bloqueos: el botón deshabilitado es comodidad, no seguridad.
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
  const backdrop = useBackdropClose(() => {
    if (!busy) onClose();
  });

  const previewUrl = `/api/admin/restaurants/${restaurantId}/delete`;
  const [attempt, setAttempt] = useState(0);

  function retry() {
    setLoadState("loading");
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

  const blocked = (preview?.blockers.length ?? 0) > 0;
  const canConfirm = !!preview && !blocked && !busy && slugInput === slug;

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
            disabled={busy}
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
                <ul className="mt-1 list-disc pl-5 space-y-1 text-sm">
                  {preview.blockers.map((b) => (
                    <li key={b.code}>
                      {t(`blocker_${b.code}`, { count: b.count, detail: (b.detail ?? []).join(", ") })}
                    </li>
                  ))}
                </ul>
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
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy || blocked}
                className="w-full px-3 h-10 rounded-lg border border-op-border bg-op-bg text-sm font-mono"
              />
              {error && <div className="text-xs text-danger" role="alert">{error}</div>}
            </div>

            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={onClose} disabled={busy} className="mp-btn mp-btn--secondary mp-btn--sm">
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={!canConfirm}
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
