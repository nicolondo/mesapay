"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import type { IngredientDeletionCheck } from "@/lib/erp/ingredientDeletion";
import { deletionReasonsText, fetchIngredientDeletionCheck } from "@/lib/erp/ingredientDeletionText";

/**
 * Pie de la ficha del insumo: le pregunta al server si se puede eliminar.
 * Si se puede, ofrece «Eliminar»; si no, dice por qué en palabras simples
 * («está en 3 recetas», «tiene existencias»…) y ofrece «Archivar».
 */
export function IngredientDeletePanel({
  ingredient,
  disabled = false,
  onDelete,
  onArchive,
}: {
  ingredient: { id: string; active: boolean };
  disabled?: boolean;
  onDelete: () => void;
  onArchive: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [check, setCheck] = useState<IngredientDeletionCheck | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);

  const { id } = ingredient;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchIngredientDeletionCheck(id);
      if (!cancelled) setCheck(result.ok ? result.check : "failed");
    })();
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (check === null) {
    return <p className="text-xs text-op-muted" aria-live="polite">{t("deleteIngredientChecking")}</p>;
  }
  if (check === "failed") {
    return (
      <p className="text-xs text-op-muted">
        {t("deleteIngredientCheckFailed")}{" "}
        <button type="button" onClick={() => { setCheck(null); setAttempt((n) => n + 1); }} className="underline underline-offset-2 hover:text-ink">
          {t("retry")}
        </button>
      </p>
    );
  }
  if (check.deletable) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-op-border bg-op-bg p-3" data-testid="ingredient-delete-panel">
        <p className="min-w-0 text-xs text-op-muted">{t("deleteIngredientCanDelete")}</p>
        <button type="button" onClick={onDelete} disabled={disabled} className="mp-btn mp-btn--danger mp-btn--sm shrink-0">
          {t("deleteIngredient")}
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-op-border bg-op-bg p-3" data-testid="ingredient-delete-panel">
      <p className="min-w-0 text-xs text-op-muted">
        {t("deleteIngredientBlockedShort", { reasons: deletionReasonsText(t, locale, check.reasons) })}{" "}
        {t(ingredient.active ? "deleteIngredientArchiveInstead" : "deleteIngredientAlreadyArchived")}
      </p>
      {ingredient.active && (
        <button type="button" onClick={onArchive} disabled={disabled} className="mp-btn mp-btn--secondary mp-btn--sm shrink-0">
          {t("archiveIngredient")}
        </button>
      )}
    </div>
  );
}
