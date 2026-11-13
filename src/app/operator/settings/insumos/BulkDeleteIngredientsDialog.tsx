"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { Locale } from "@/i18n/config";
import {
  deleteIngredients,
  previewIngredientsDeletion,
  skippedIngredientsText,
  type BulkDeletePreview,
  type BulkDeleteResult,
} from "@/lib/erp/ingredientDeletionText";

/**
 * «Eliminar» de la selección de Insumos. Antes de confirmar le pregunta al
 * server qué pasaría: cuántos se eliminan y cuáles no (con el motivo). Al
 * confirmar solo se mandan los que se anunciaron como eliminables, y el
 * server vuelve a revisar la regla con cada uno.
 */
export function BulkDeleteIngredientsDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: (result: BulkDeleteResult) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [preview, setPreview] = useState<BulkDeletePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // La selección es la de cuando se abrió el diálogo.
  const [requested] = useState(ids);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await previewIngredientsDeletion(requested);
      if (!cancelled) setPreview(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [requested, attempt]);

  async function confirm() {
    if (busy || !preview || preview.deletable.length === 0) return;
    setBusy(true);
    const result = await deleteIngredients(preview.deletable.map((row) => row.id));
    // Los que ya se sabía que no se podían también cuentan como «no se pudo».
    onDone({
      deleted: result.deleted,
      skipped: [...result.skipped, ...preview.skipped],
      failed: [...result.failed, ...preview.failed],
    });
  }

  const failedAll = !!preview && preview.deletable.length === 0 && preview.skipped.length === 0 && preview.failed.length > 0;
  const none = !!preview && preview.deletable.length === 0 && !failedAll;

  return (
    <AppDialog
      label={t("bulkDeleteTitle")}
      onClose={() => { if (!busy) onClose(); }}
      placement="center"
      className="rounded-2xl bg-op-surface text-op-text"
    >
      <div className="p-5" data-testid="ingredient-bulk-delete-dialog">
        <h2 className="text-lg font-semibold tracking-tight">{t("bulkDeleteTitle")}</h2>

        <div className="mt-3 space-y-2 text-sm" aria-live="polite">
          {!preview && <p className="text-op-muted">{t("deleteIngredientChecking")}</p>}
          {failedAll && <p role="alert" className="text-danger">{t("deleteIngredientCheckFailed")}</p>}
          {none && <p>{t("bulkDeleteNone")}</p>}
          {preview && preview.deletable.length > 0 && (
            <>
              <p>{t("bulkDeleteBody", { count: preview.deletable.length })}</p>
              {preview.skipped.length > 0 && <p className="text-op-muted">{t("bulkDeleteSkipNote", { count: preview.skipped.length })}</p>}
            </>
          )}
          {preview && preview.skipped.length > 0 && (
            <p className="break-words text-xs text-op-muted" data-testid="ingredient-bulk-delete-skipped">
              {skippedIngredientsText(t, locale, preview.skipped)}
            </p>
          )}
          {preview && !failedAll && preview.failed.length > 0 && (
            <p role="alert" className="text-xs text-danger">{t("ingredientsDeleteFailedSome", { count: preview.failed.length })}</p>
          )}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={busy} className="mp-btn mp-btn--secondary w-full sm:w-auto">
            {t(preview && preview.deletable.length === 0 ? "closeSheet" : "cancel")}
          </button>
          {failedAll && (
            <button type="button" onClick={() => { setPreview(null); setAttempt((n) => n + 1); }} className="mp-btn mp-btn--primary w-full sm:w-auto">
              {t("retry")}
            </button>
          )}
          {preview && preview.deletable.length > 0 && (
            <button type="button" onClick={() => void confirm()} disabled={busy} className="mp-btn mp-btn--danger-solid w-full sm:w-auto">
              {busy ? t("deleteIngredientDeleting") : t("bulkDeleteConfirm", { count: preview.deletable.length })}
            </button>
          )}
        </div>
      </div>
    </AppDialog>
  );
}
