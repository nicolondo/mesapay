"use client";

import { useTranslations } from "next-intl";
import type { ChimeBoard } from "@/lib/kitchen/newOrderChime";
import { useNewOrderChime } from "@/lib/kitchen/useNewOrderChime";

/**
 * Encabezado del tablero de cocina/bar con el control del pitido de pedido
 * nuevo (activar/silenciar + "Probar sonido") y, si entró un pedido y el
 * navegador todavía no dejó sonar (nadie tocó la pantalla desde que cargó),
 * un aviso fijo arriba para desbloquear el audio.
 */
export function NewOrderChime({
  board,
  roundIds,
  scope,
}: {
  board: ChimeBoard;
  roundIds: readonly string[];
  scope?: string;
}) {
  const tr = useTranslations("kitchen");
  const chime = useNewOrderChime({ board, roundIds, scope });

  return (
    <>
      <div className="px-6 pt-4 flex flex-wrap items-center justify-end gap-2">
        {chime.supported ? (
          <>
            <button
              type="button"
              onClick={chime.toggle}
              aria-pressed={chime.enabled}
              title={tr("soundToggleHint")}
              className={
                "h-9 px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 active:scale-95 transition-transform " +
                (chime.enabled
                  ? "bg-op-surface border-op-border text-op-text"
                  : "bg-op-bg border-op-border text-op-muted")
              }
            >
              {chime.enabled ? <BellIcon /> : <BellOffIcon />}
              {chime.enabled ? tr("soundOn") : tr("soundOff")}
            </button>
            <button
              type="button"
              onClick={chime.test}
              className="h-9 px-3 rounded-lg border border-op-border bg-op-surface text-xs font-medium text-op-text active:scale-95 transition-transform"
            >
              {tr("soundTest")}
            </button>
          </>
        ) : (
          <span className="text-xs text-op-muted inline-flex items-center gap-1.5">
            <BellOffIcon />
            {tr("soundUnsupported")}
          </span>
        )}
      </div>

      {chime.needsUnlock && (
        // Arriba del tablero, no sticky: en /cocina y /bar el encabezado del
        // layout ya es sticky y lo taparía. Tocarlo (o tocar cualquier parte
        // de la pantalla) desbloquea el audio y lo oculta.
        <div role="alert" className="px-6 pt-3">
          <button
            type="button"
            onClick={chime.unlock}
            className="w-full min-h-12 rounded-xl bg-terracotta text-bone px-4 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 shadow-lg"
          >
            <BellIcon />
            {tr("soundUnlock")}
          </button>
        </div>
      )}
    </>
  );
}

function BellIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function BellOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" />
      <path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      <path d="m2 2 20 20" />
    </svg>
  );
}
