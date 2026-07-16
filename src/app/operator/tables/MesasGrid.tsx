"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import {
  tileTokensForState,
  type RiskLevel,
  type TableVisualState,
} from "@/lib/walkoutRisk";
import { TableDetailSheet } from "./TableDetailSheet";

/**
 * Grilla compacta de mesas con chips de filtro + accordion-on-tap.
 * Diseñada para anti-walkout en mobile: ver el piso entero de un
 * vistazo, cada tile coloreado por nivel de riesgo de fuga sin pago,
 * tap → abre el sheet de detalle existente.
 *
 * Densidad target: 3 cols en mobile (iPhone 390px → ~24 tiles
 * visibles), 4 en tablet, 5-6 en desktop.
 *
 * El sheet de detalle (TableDetailSheet) se renderea en modo
 * controlled — el padre maneja qué tile está expandido. Sólo uno a
 * la vez. Tap fuera o tap en el mismo tile lo cierra.
 */

export type TileData =
  | {
      id: string;
      number: number;
      label: string | null;
      qrToken: string;
      state: "free";
    }
  | {
      id: string;
      number: number;
      label: string | null;
      qrToken: string;
      state: "recently_paid";
      paidAt: string; // ISO
    }
  | {
      id: string;
      number: number;
      label: string | null;
      qrToken: string;
      state: "active";
      // Estado discreto que drivea el color del tile (cooking,
      // ready_to_serve, eating, needs_payment, danger, etc).
      visualState: TableVisualState;
      order: ActiveOrder;
      risk: {
        level: RiskLevel;
        agingMinutes: number;
        reason: "request" | "served" | "none";
      };
    };

export type ActiveOrder = {
  id: string;
  shortCode: string;
  status: string;
  itemCount: number;
  subtotalCents: number;
  outstandingCents: number;
  needsWaiter: boolean;
  rounds: Round[];
};

type Round = {
  id: string;
  seq: number;
  status: string;
  placedAt: string;
  items: ItemDetail[];
};

type ItemDetail = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  preparationStartedAt: string | null;
  servedAt: string | null;
  expediteRequestedAt: string | null;
  guestName: string | null;
  notes: string | null;
};

type FreeTable = { id: string; number: number; label: string | null };

// Todas las mesas (libres y ocupadas) para "Mover un plato".
type AllTable = {
  id: string;
  number: number;
  label: string | null;
  occupied: boolean;
};

type FilterChip = "all" | "by_pay" | "recent" | "free";

export function MesasGrid({
  tiles,
  tenantSlug,
  counterMode,
  isMeseroView,
  freeTables,
  allTables,
}: {
  tiles: TileData[];
  tenantSlug: string;
  counterMode: boolean;
  isMeseroView: boolean;
  freeTables: FreeTable[];
  allTables: AllTable[];
}) {
  const tr = useTranslations("opTables");
  const [filter, setFilter] = useState<FilterChip>("all");
  // ID del tile cuyo sheet está abierto. Solo uno a la vez.
  const [openTileId, setOpenTileId] = useState<string | null>(null);
  // Modo edición: los tiles dejan de navegar/abrir cobro y pasan a
  // renombrar/borrar la mesa vía un sheet estable (no se rompe con el
  // auto-refresh de LiveRefresh). Solo operator/admin — el mesero no
  // gestiona el alta/baja de mesas.
  const [editMode, setEditMode] = useState(false);
  const [manageTile, setManageTile] = useState<{
    id: string;
    number: number;
    label: string | null;
  } | null>(null);

  const counts = useMemo(() => {
    const c = { all: tiles.length, by_pay: 0, recent: 0, free: 0 };
    for (const t of tiles) {
      if (t.state === "active") c.by_pay += 1;
      else if (t.state === "recently_paid") c.recent += 1;
      else c.free += 1;
    }
    return c;
  }, [tiles]);

  const filtered = useMemo(() => {
    if (filter === "all") return tiles;
    if (filter === "by_pay") return tiles.filter((t) => t.state === "active");
    if (filter === "recent")
      return tiles.filter((t) => t.state === "recently_paid");
    return tiles.filter((t) => t.state === "free");
  }, [tiles, filter]);

  return (
    <>
      {/* Filter chips — sticky abajo del header de la página.
          Los counts ayudan a ver "tengo 3 cuentas pendientes" sin
          tener que contar. */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        <Chip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={tr("filterAll")}
          count={counts.all}
        />
        <Chip
          active={filter === "by_pay"}
          onClick={() => setFilter("by_pay")}
          label={tr("filterByPay")}
          count={counts.by_pay}
          tone="danger"
        />
        <Chip
          active={filter === "recent"}
          onClick={() => setFilter("recent")}
          label={tr("filterRecent")}
          count={counts.recent}
          tone="ok"
        />
        <Chip
          active={filter === "free"}
          onClick={() => setFilter("free")}
          label={tr("filterFree")}
          count={counts.free}
        />
        {!isMeseroView && (
          <button
            type="button"
            onClick={() => {
              setEditMode((v) => !v);
              setOpenTileId(null);
            }}
            className={
              "ml-auto h-8 px-3 inline-flex items-center rounded-full text-xs font-medium border transition-colors " +
              (editMode
                ? "bg-ink text-bone border-ink"
                : "bg-op-surface border-op-border text-op-muted hover:text-op-text")
            }
          >
            {editMode ? tr("editDone") : tr("editTables")}
          </button>
        )}
      </div>

      {/* Grid de tiles compactos */}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
        {filtered.length === 0 && (
          <div className="col-span-full text-center text-sm text-op-muted py-8">
            {tr("emptyFilter")}
          </div>
        )}
        {filtered.map((tile) => {
          if (editMode) {
            return (
              <ManageTileButton
                key={tile.id}
                number={tile.number}
                label={tile.label}
                counterMode={counterMode}
                onClick={() =>
                  setManageTile({
                    id: tile.id,
                    number: tile.number,
                    label: tile.label,
                  })
                }
              />
            );
          }
          if (tile.state === "free") {
            return (
              <FreeTile
                key={tile.id}
                tile={tile}
                counterMode={counterMode}
                isMeseroView={isMeseroView}
                tenantSlug={tenantSlug}
              />
            );
          }
          if (tile.state === "recently_paid") {
            return (
              <RecentlyPaidTile
                key={tile.id}
                tile={tile}
                counterMode={counterMode}
                isMeseroView={isMeseroView}
                tenantSlug={tenantSlug}
              />
            );
          }
          // active
          return (
            <ActiveTile
              key={tile.id}
              tile={tile}
              counterMode={counterMode}
              open={openTileId === tile.id}
              onOpenChange={(next) =>
                setOpenTileId(next ? tile.id : null)
              }
              freeTables={freeTables.filter((ft) => ft.id !== tile.id)}
              allTables={allTables.filter((at) => at.id !== tile.id)}
              tenantSlug={tenantSlug}
              isMeseroView={isMeseroView}
            />
          );
        })}
      </div>

      {manageTile && (
        <ManageTableSheet
          tile={manageTile}
          onClose={() => setManageTile(null)}
        />
      )}
    </>
  );
}

/**
 * Tile en modo edición — no navega ni abre cobro; al tap abre el sheet
 * de gestión (renombrar / borrar). Mismo tamaño que los tiles normales
 * para que la grilla no salte al entrar/salir de edición.
 */
function ManageTileButton({
  number,
  label,
  counterMode,
  onClick,
}: {
  number: number;
  label: string | null;
  counterMode: boolean;
  onClick: () => void;
}) {
  const tr = useTranslations("opTables");
  return (
    <button
      type="button"
      onClick={onClick}
      className="aspect-[4/3] rounded-xl border border-dashed border-op-border bg-op-surface hover:bg-op-bg flex flex-col items-center justify-center p-2 text-center transition-colors relative"
    >
      <div className="font-display text-base leading-none">
        {counterMode ? tr("tileCounterShort") : tr("tileTableShort", { number })}
      </div>
      {label && (
        <div className="font-mono text-[9px] text-op-muted mt-1 truncate w-full">
          {label}
        </div>
      )}
      <div className="font-mono text-[9px] tracking-wider uppercase text-op-muted mt-auto">
        {tr("editTap")}
      </div>
    </button>
  );
}

/**
 * Sheet de gestión de una mesa: renombrar (label) + borrar. Vive en el
 * cliente con su propio estado, así el auto-refresh de fondo no lo
 * resetea. Usa la misma API que el editor de Configuración › Mesas.
 */
function ManageTableSheet({
  tile,
  onClose,
}: {
  tile: { id: string; number: number; label: string | null };
  onClose: () => void;
}) {
  const tr = useTranslations("opTables");
  const router = useRouter();
  const [num, setNum] = useState(String(tile.number));
  const [label, setLabel] = useState(tile.label ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const parsedNum = Number(num);
    if (!Number.isInteger(parsedNum) || parsedNum < 1) {
      setErr(tr("numberInvalid"));
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/operator/tables/${tile.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.trim() || null, number: parsedNum }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(
        j.error === "number_taken"
          ? tr("numberTaken")
          : tr("saveLabelFailed"),
      );
      return;
    }
    router.refresh();
    onClose();
  }

  async function del() {
    if (!window.confirm(tr("confirmDeleteTable", { number: tile.number }))) {
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/operator/tables/${tile.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(
        j.error === "open_order"
          ? tr("deleteOpenOrder")
          : j.error === "has_history"
            ? tr("deleteHasHistory")
            : tr("deleteTableFailed"),
      );
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-sm bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-2xl">
            {tr("tableFull", { number: tile.number })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted text-sm shrink-0"
            aria-label={tr("close")}
          >
            {"✕"}
          </button>
        </div>

        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5">
            {tr("manageNumberLabel")}
          </div>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={num}
            onChange={(e) => setNum(e.target.value)}
            className="w-full h-11 px-3 rounded-xl border border-op-border bg-op-bg text-sm tabular"
          />
        </div>

        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5">
            {tr("manageNameLabel")}
          </div>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            placeholder={tr("labelPlaceholder")}
            className="w-full h-11 px-3 rounded-xl border border-op-border bg-op-bg text-sm"
          />
        </div>

        {err && <div className="text-xs text-danger">{err}</div>}

        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="mp-btn mp-btn--primary mp-btn--block"
        >
          {tr("manageSave")}
        </button>
        <button
          type="button"
          onClick={del}
          disabled={busy}
          className="mp-btn mp-btn--danger mp-btn--block"
        >
          {tr("deleteTable")}
        </button>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "danger" | "ok";
}) {
  const toneActive =
    tone === "danger"
      ? "bg-[#C9302C] text-bone border-[#C9302C]"
      : tone === "ok"
        ? "bg-[#2E6B4C] text-bone border-[#2E6B4C]"
        : "bg-ink text-bone border-ink";
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-8 px-3 inline-flex items-center gap-1.5 rounded-full text-xs font-medium border transition-colors " +
        (active
          ? toneActive
          : "bg-op-surface border-op-border text-op-muted hover:text-op-text")
      }
    >
      <span>{label}</span>
      <span
        className={
          "font-mono tabular text-[10px] " +
          (active ? "opacity-80" : "text-op-muted")
        }
      >
        {count}
      </span>
    </button>
  );
}

/**
 * Tile libre — link directo a "Tomar pedido". No abre sheet (no hay
 * orden que ver). En operator/admin abre tab nueva; en mesero
 * navega interno.
 */
function FreeTile({
  tile,
  counterMode,
  isMeseroView,
  tenantSlug,
}: {
  tile: Extract<TileData, { state: "free" }>;
  counterMode: boolean;
  isMeseroView: boolean;
  tenantSlug: string;
}) {
  const tr = useTranslations("opTables");
  const href = isMeseroView
    ? `/mesero/pedir/${tile.id}`
    : `/t/${tenantSlug}/menu?table=${tile.qrToken}&op=1`;
  const targetProps = isMeseroView
    ? {}
    : { target: "_blank" as const, rel: "noreferrer" };
  return (
    <Link
      href={href}
      {...targetProps}
      className="aspect-[4/3] rounded-xl border border-op-border bg-op-surface hover:bg-op-bg flex flex-col items-center justify-center p-2 text-center transition-colors"
    >
      <div className="font-display text-base leading-none">
        {counterMode
          ? tr("tileCounterShort")
          : tr("tileTableShort", { number: tile.number })}
      </div>
      {tile.label && (
        <div className="font-mono text-[9px] text-op-muted mt-1 truncate w-full">
          {tile.label}
        </div>
      )}
      <div className="font-mono text-[9px] tracking-wider uppercase text-op-muted mt-auto">
        {tr("tileFree")}
      </div>
    </Link>
  );
}

/**
 * Tile recién pagada — muestra dot verde + tiempo desde el pago.
 * Tap arranca un pedido nuevo (la mesa ya está físicamente libre y
 * un grupo nuevo puede llegar enseguida — mismo target que FreeTile).
 */
function RecentlyPaidTile({
  tile,
  counterMode,
  isMeseroView,
  tenantSlug,
}: {
  tile: Extract<TileData, { state: "recently_paid" }>;
  counterMode: boolean;
  isMeseroView: boolean;
  tenantSlug: string;
}) {
  const tr = useTranslations("opTables");
  const minsAgo = Math.max(
    0,
    Math.floor((Date.now() - new Date(tile.paidAt).getTime()) / 60000),
  );
  // Mismo href + target que FreeTile — la mesa está libre para
  // recibir un grupo nuevo, sólo que recordamos el pago previo como
  // info al operador.
  const href = isMeseroView
    ? `/mesero/pedir/${tile.id}`
    : `/t/${tenantSlug}/menu?table=${tile.qrToken}&op=1`;
  const targetProps = isMeseroView
    ? {}
    : { target: "_blank" as const, rel: "noreferrer" };
  return (
    <Link
      href={href}
      {...targetProps}
      className="aspect-[4/3] rounded-xl border border-ok/35 bg-ok/10 hover:bg-ok/15 p-2 flex flex-col items-center justify-center text-center relative transition-colors"
    >
      <div className="font-display text-base leading-none">
        {counterMode
          ? tr("tileCounterShort")
          : tr("tileTableShort", { number: tile.number })}
      </div>
      {tile.label && (
        <div className="font-mono text-[9px] text-op-muted mt-0.5 truncate w-full">
          {tile.label}
        </div>
      )}
      <div className="text-[10px] text-[#1E5339] font-medium mt-1">
        <span aria-hidden>{"✓ "}</span>
        {minsAgo === 0 ? tr("tileNow") : tr("tileMinutesAgo", { mins: minsAgo })}
      </div>
      <span
        aria-hidden
        className="absolute bottom-2.5 right-2.5 inline-block w-2 h-2 rounded-full bg-ok"
      />
    </Link>
  );
}

/**
 * Tile activo — bg según walkout-risk, dot abajo a la derecha,
 * outstanding + edad. Tap abre el sheet en modo controlled.
 */
function ActiveTile({
  tile,
  counterMode,
  open,
  onOpenChange,
  freeTables,
  allTables,
  tenantSlug,
  isMeseroView,
}: {
  tile: Extract<TileData, { state: "active" }>;
  counterMode: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  freeTables: FreeTable[];
  allTables: AllTable[];
  tenantSlug: string;
  isMeseroView: boolean;
}) {
  const tr = useTranslations("opTables");
  const tokens = tileTokensForState(tile.visualState);
  const tableLabel = counterMode
    ? tr("tableFullCounter")
    : tile.label
      ? tr("tableFullWithLabel", { number: tile.number, label: tile.label })
      : tr("tableFull", { number: tile.number });
  const pulse = tokens.pulse;
  // Combinamos age + items en una sola linea compacta. Si nada
  // que mostrar, dejamos en blanco para que el layout no salte.
  const metaLine =
    (tile.risk.agingMinutes > 0
      ? tr("tileMetaMinutes", { mins: tile.risk.agingMinutes })
      : "") +
    (tile.risk.agingMinutes > 0 && tile.order.itemCount > 0
      ? tr("tileMetaSep")
      : "") +
    (tile.order.itemCount > 0
      ? tr("tileMetaItems", { count: tile.order.itemCount })
      : "");
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className={
          "aspect-[4/3] rounded-xl border p-2 flex flex-col items-center justify-center text-center transition-colors relative " +
          tokens.bg +
          " " +
          tokens.border +
          " hover:brightness-95"
        }
      >
        <div className="font-display text-base leading-none">
          {counterMode
            ? tr("tileCounterShort")
            : tr("tileTableShort", { number: tile.number })}
        </div>
        {tile.label && (
          <div className="font-mono text-[9px] text-op-muted truncate w-full mt-0.5">
            {tile.label}
          </div>
        )}
        <div
          className={
            "font-mono text-[12px] tabular leading-tight mt-1 " +
            tokens.textAccent
          }
        >
          {fmtCOP(tile.order.outstandingCents)}
        </div>
        {metaLine && (
          <div className="font-mono text-[9px] text-op-muted mt-0.5">
            {metaLine}
          </div>
        )}

        {/* Overlay: dot en la esquina inferior derecha — fuera del
            flujo del flex centrado para no romper el balance. Inset
            de 10px para no chocar contra el curve del rounded-xl
            (que es 12px). */}
        <span
          aria-hidden
          className={
            "absolute bottom-2.5 right-2.5 inline-block w-2 h-2 rounded-full " +
            tokens.dot +
            (pulse ? " animate-pulse" : "")
          }
        />
        {/* Overlay: icono de llamada mesero arriba derecha. */}
        {tile.order.needsWaiter && (
          <span
            aria-hidden
            title={tr("waiterCallPending")}
            className="absolute top-1 right-1.5 text-[10px]"
          >
            🔔
          </span>
        )}
      </button>

      {/* Sheet de detalle en modo controlled. Sólo se monta cuando
          está abierto para no inflar el DOM con N sheets cerrados. */}
      {open && (
        <TableDetailSheet
          orderId={tile.order.id}
          shortCode={tile.order.shortCode}
          tableLabel={tableLabel}
          tableNumber={tile.number}
          tableId={tile.id}
          freeTables={freeTables}
          allTables={allTables}
          initialRounds={tile.order.rounds}
          open={open}
          onOpenChange={onOpenChange}
          hideTrigger
          orderStatus={tile.order.status}
          outstandingCents={tile.order.outstandingCents}
          subtotalCents={tile.order.subtotalCents}
          tenantSlug={tenantSlug}
          qrToken={tile.qrToken}
          isMeseroView={isMeseroView}
        />
      )}
    </>
  );
}
