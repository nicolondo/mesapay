"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { Locale } from "@/i18n/config";
import type { IngredientDeletionReason, IngredientDeletionRemoves } from "@/lib/erp/ingredientDeletion";
import { deleteIngredient, deletionReasonsText, fetchIngredientDeletionCheck, listText } from "@/lib/erp/ingredientDeletionText";

type Phase =
  | { kind: "checking" }
  | { kind: "confirm"; removes: IngredientDeletionRemoves }
  | { kind: "blocked"; reasons: IngredientDeletionReason[] }
  | { kind: "checkFailed" }
  | { kind: "gone" };

/**
 * «Eliminar insumo»: le pregunta al server si se puede (la regla vive allá,
 * en `@/lib/erp/ingredientDeletion`) y según la respuesta pide confirmar o
 * explica por qué no y ofrece archivar. Lo usan Insumos (fila y ficha) e
 * Inventario (menú ⋯): los dos dicen exactamente lo mismo.
 */
export function IngredientDeleteDialog({
  ingredient,
  onClose,
  onDeleted,
  onArchive,
}: {
  ingredient: { id: string; name: string; active: boolean };
  onClose: () => void;
  /** Ya no existe (se eliminó acá, o ya lo había eliminado alguien más). */
  onDeleted: (ingredient: { id: string; name: string }, how: "deleted" | "gone") => void;
  /** Con esto, cuando no se puede eliminar se ofrece «Archivar». */
  onArchive?: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const { id, name } = ingredient;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchIngredientDeletionCheck(id);
      if (cancelled) return;
      if (!result.ok) setPhase({ kind: result.error === "not_found" ? "gone" : "checkFailed" });
      else if (result.check.deletable) setPhase({ kind: "confirm", removes: result.check.removes });
      else setPhase({ kind: "blocked", reasons: result.check.reasons });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  function retryCheck() {
    setError(null);
    setPhase({ kind: "checking" });
    setAttempt((n) => n + 1);
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await deleteIngredient(id);
    setBusy(false);
    if (result.ok) onDeleted({ id, name }, "deleted");
    else if (result.error === "not_found") setPhase({ kind: "gone" });
    // Entre preguntar y confirmar apareció una referencia: se explica.
    else if (result.error === "not_deletable") setPhase({ kind: "blocked", reasons: result.reasons });
    else setError(t("deleteIngredientFailed"));
  }

  function close() {
    if (busy) return;
    if (phase.kind === "gone") onDeleted({ id, name }, "gone");
    else onClose();
  }

  function alsoRemoves(removes: IngredientDeletionRemoves): string | null {
    const parts = [
      removes.supplierItems > 0 ? t("deleteRemovesSupplierItems", { count: removes.supplierItems }) : null,
      removes.invoiceAliases > 0 ? t("deleteRemovesAliases", { count: removes.invoiceAliases }) : null,
    ].filter((part): part is string => part !== null);
    if (parts.length === 0) return null;
    return t("deleteIngredientAlsoRemoves", { list: listText(locale, parts) });
  }

  const extras = phase.kind === "confirm" ? alsoRemoves(phase.removes) : null;
  const canArchive = phase.kind === "blocked" && ingredient.active && !!onArchive;

  return (
    <AppDialog label={t("deleteIngredientTitle")} onClose={close} placement="center" className="rounded-2xl bg-op-surface text-op-text">
      <div className="p-5" data-testid="ingredient-delete-dialog">
        <h2 className="text-lg font-semibold tracking-tight">{t("deleteIngredientTitle")}</h2>
        <p className="mt-0.5 break-words text-sm text-op-muted">{name}</p>

        <div className="mt-3 space-y-2 text-sm" aria-live="polite">
          {phase.kind === "checking" && <p className="text-op-muted">{t("deleteIngredientChecking")}</p>}
          {phase.kind === "confirm" && (
            <>
              <p>{t("deleteIngredientConfirmBody", { name })}</p>
              {extras && <p className="text-op-muted">{extras}</p>}
            </>
          )}
          {phase.kind === "blocked" && (
            <>
              <p data-testid="ingredient-delete-blocked">
                {t("deleteIngredientBlocked", { name, reasons: deletionReasonsText(t, locale, phase.reasons) })}
              </p>
              <p className="text-op-muted">
                {t(ingredient.active ? "deleteIngredientArchiveInstead" : "deleteIngredientAlreadyArchived")}
              </p>
            </>
          )}
          {phase.kind === "checkFailed" && <p role="alert" className="text-danger">{t("deleteIngredientCheckFailed")}</p>}
          {phase.kind === "gone" && <p>{t("deleteIngredientGone")}</p>}
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={close} disabled={busy} className="mp-btn mp-btn--secondary w-full sm:w-auto">
            {t(phase.kind === "confirm" || phase.kind === "checking" ? "cancel" : "closeSheet")}
          </button>
          {phase.kind === "confirm" && (
            <button type="button" onClick={() => void confirm()} disabled={busy} className="mp-btn mp-btn--danger-solid w-full sm:w-auto">
              {t(busy ? "deleteIngredientDeleting" : "deleteIngredientConfirm")}
            </button>
          )}
          {phase.kind === "checkFailed" && (
            <button type="button" onClick={retryCheck} className="mp-btn mp-btn--primary w-full sm:w-auto">
              {t("retry")}
            </button>
          )}
          {canArchive && (
            <button type="button" onClick={onArchive} className="mp-btn mp-btn--primary w-full sm:w-auto">
              {t("archiveIngredient")}
            </button>
          )}
        </div>
      </div>
    </AppDialog>
  );
}
