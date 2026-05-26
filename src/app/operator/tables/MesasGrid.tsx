"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";
import {
  tileTokensForRisk,
  type RiskLevel,
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

type FilterChip = "all" | "by_pay" | "recent" | "free";

export function MesasGrid({
  tiles,
  tenantSlug,
  counterMode,
  isMeseroView,
  freeTables,
}: {
  tiles: TileData[];
  tenantSlug: string;
  counterMode: boolean;
  isMeseroView: boolean;
  freeTables: FreeTable[];
}) {
  const [filter, setFilter] = useState<FilterChip>("all");
  // ID del tile cuyo sheet está abierto. Solo uno a la vez.
  const [openTileId, setOpenTileId] = useState<string | null>(null);

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
          label="Todas"
          count={counts.all}
        />
        <Chip
          active={filter === "by_pay"}
          onClick={() => setFilter("by_pay")}
          label="Por cobrar"
          count={counts.by_pay}
          tone="danger"
        />
        <Chip
          active={filter === "recent"}
          onClick={() => setFilter("recent")}
          label="Recién pagadas"
          count={counts.recent}
          tone="ok"
        />
        <Chip
          active={filter === "free"}
          onClick={() => setFilter("free")}
          label="Libres"
          count={counts.free}
        />
      </div>

      {/* Grid de tiles compactos */}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
        {filtered.length === 0 && (
          <div className="col-span-full text-center text-sm text-op-muted py-8">
            No hay mesas en este filtro.
          </div>
        )}
        {filtered.map((tile) => {
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
            return <RecentlyPaidTile key={tile.id} tile={tile} counterMode={counterMode} />;
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
            />
          );
        })}
      </div>
    </>
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
        {counterMode ? "Mostr." : `M${tile.number}`}
      </div>
      {tile.label && (
        <div className="font-mono text-[9px] text-op-muted mt-1 truncate w-full">
          {tile.label}
        </div>
      )}
      <div className="font-mono text-[9px] tracking-wider uppercase text-op-muted mt-auto">
        libre
      </div>
    </Link>
  );
}

/**
 * Tile recién pagada — muestra dot verde + tiempo desde el pago.
 * No-op al tap por ahora (info histórica, no requiere acción).
 */
function RecentlyPaidTile({
  tile,
  counterMode,
}: {
  tile: Extract<TileData, { state: "recently_paid" }>;
  counterMode: boolean;
}) {
  const minsAgo = Math.max(
    0,
    Math.floor((Date.now() - new Date(tile.paidAt).getTime()) / 60000),
  );
  return (
    <div className="aspect-[4/3] rounded-xl border border-ok/35 bg-ok/10 p-2 flex flex-col items-center justify-center text-center">
      <div className="font-display text-base leading-none">
        {counterMode ? "Mostr." : `M${tile.number}`}
      </div>
      {tile.label && (
        <div className="font-mono text-[9px] text-op-muted mt-0.5 truncate w-full">
          {tile.label}
        </div>
      )}
      <div className="text-[10px] text-[#1E5339] font-medium mt-1">
        ✓ {minsAgo === 0 ? "ahora" : `${minsAgo}m`}
      </div>
    </div>
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
}: {
  tile: Extract<TileData, { state: "active" }>;
  counterMode: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  freeTables: FreeTable[];
}) {
  const tokens = tileTokensForRisk(tile.risk.level);
  const tableLabel = counterMode
    ? "Mostrador"
    : `Mesa ${tile.number}${tile.label ? ` · ${tile.label}` : ""}`;
  const pulse = tile.risk.level === "danger";
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className={
          "aspect-[4/3] rounded-xl border p-2 text-left flex flex-col transition-colors relative " +
          tokens.bg +
          " " +
          tokens.border +
          " hover:brightness-95"
        }
      >
        <div className="flex items-start justify-between gap-1">
          <div className="font-display text-base leading-none">
            {counterMode ? "Mostr." : `M${tile.number}`}
          </div>
          {tile.order.needsWaiter && (
            <span
              aria-hidden
              title="Llamado de mesero pendiente"
              className="text-[10px]"
            >
              🔔
            </span>
          )}
        </div>
        {tile.label && (
          <div className="font-mono text-[9px] text-op-muted truncate">
            {tile.label}
          </div>
        )}
        <div
          className={
            "mt-auto font-mono text-[12px] tabular leading-tight " +
            tokens.textAccent
          }
        >
          {fmtCOP(tile.order.outstandingCents)}
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="font-mono text-[9px] text-op-muted">
            {tile.risk.agingMinutes > 0 ? `${tile.risk.agingMinutes}m` : ""}
            {tile.risk.agingMinutes > 0 && tile.order.itemCount > 0
              ? " · "
              : ""}
            {tile.order.itemCount > 0
              ? `${tile.order.itemCount}i`
              : ""}
          </span>
          <span
            aria-hidden
            className={
              "inline-block w-1.5 h-1.5 rounded-full " +
              tokens.dot +
              (pulse ? " animate-pulse" : "")
            }
          />
        </div>
      </button>

      {/* Sheet de detalle en modo controlled. Sólo se monta cuando
          está abierto para no inflar el DOM con N sheets cerrados. */}
      {open && (
        <TableDetailSheet
          orderId={tile.order.id}
          shortCode={tile.order.shortCode}
          tableLabel={tableLabel}
          tableNumber={tile.number}
          freeTables={freeTables}
          initialRounds={tile.order.rounds}
          open={open}
          onOpenChange={onOpenChange}
          hideTrigger
        />
      )}
    </>
  );
}
