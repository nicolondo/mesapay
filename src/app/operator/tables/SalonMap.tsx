"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import type { FloorScene, TablePlacement, TableShape } from "@/lib/floorPlan";
import { fmtCOP } from "@/lib/format";
import type { TableVisualState } from "@/lib/walkoutRisk";
import { minutesSincePaid } from "@/lib/tables/phonePaid";
import { tileStateLabelKey } from "@/lib/tables/tileStateLabel";
import {
  FloorPlanView,
  type CanvasTable,
  type TableState,
  type TableTone,
} from "@/components/floorplan/FloorPlanCanvas";
import type { TileData } from "./MesasGrid";

/** Plano del Salón: la escena y, por mesa ubicada, su lugar, forma y puestos. */
export type SalonFloor = {
  scene: FloorScene;
  tables: Record<string, { placement: TablePlacement; shape: TableShape; capacity: number }>;
};

export type SalonView = "cards" | "map";

/* ───────────── preferencia Tarjetas / Mapa (por usuario y equipo) ───────────── */

const VIEW_EVENT = "mesapay:salon-view";

/**
 * Vista elegida, guardada en este navegador para este usuario. Si el
 * almacenamiento no está disponible (navegación privada), el cambio igual
 * vale mientras la pantalla esté abierta.
 */
export function useSalonView(viewerId: string | null): [SalonView, (v: SalonView) => void] {
  const key = `mesapay.salonView.${viewerId ?? "anon"}`;
  const [override, setOverride] = useState<SalonView | null>(null);
  const subscribe = useCallback(
    (cb: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (!e.key || e.key === key) cb();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(VIEW_EVENT, cb);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(VIEW_EVENT, cb);
      };
    },
    [key],
  );
  const stored = useSyncExternalStore<SalonView>(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(key) === "map" ? "map" : "cards";
      } catch {
        return "cards";
      }
    },
    () => "cards",
  );
  const set = useCallback(
    (v: SalonView) => {
      setOverride(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* sin almacenamiento: queda solo en esta pantalla */
      }
      window.dispatchEvent(new Event(VIEW_EVENT));
    },
    [key],
  );
  return [override ?? stored, set];
}

/* ─────────────────────────── colores por estado ─────────────────────────── */

// Mismo código de color que las tarjetas (src/lib/walkoutRisk.ts →
// tileTokensForState): tinte, borde (sólido y más grueso en los estados que
// piden acción), punto y color del monto. Sin color-mix(): van como
// atributos del SVG y el datáfono (Firefox 107) no lo entiende — ver
// TableTone. Constantes: el dibujo de una mesa solo se rehace si cambia.
const AMBER = "#C98A2E";
const RED = "#C9302C";
const TEXT = "var(--op-text)";
const ACTION = 2.5;

type ToneKey = TableVisualState | "phone_paid";

const TONES: Record<ToneKey, TableTone> = {
  free: { fill: "var(--op-surface)", stroke: "var(--op-text)", strokeOpacity: 0.45, text: TEXT },
  recently_paid: { fill: "var(--ok)", fillOpacity: 0.12, stroke: "var(--ok)", strokeOpacity: 0.6, text: TEXT, subText: "#1E5339", dot: "var(--ok)" },
  phone_paid: { fill: "var(--ok)", stroke: "var(--ok)", text: "var(--bone)", dot: "var(--bone)" },
  cooking: { fill: AMBER, fillOpacity: 0.1, stroke: AMBER, strokeOpacity: 0.45, text: TEXT, dot: AMBER },
  ready_to_serve: { fill: AMBER, fillOpacity: 0.2, stroke: AMBER, strokeWidth: ACTION, text: TEXT, subText: "#6E4D19", dot: AMBER },
  eating: { fill: "var(--ink)", fillOpacity: 0.06, stroke: "var(--ink)", strokeOpacity: 0.3, text: TEXT, dot: "var(--ink)" },
  eating_at_risk: { fill: AMBER, fillOpacity: 0.14, stroke: AMBER, strokeWidth: ACTION, text: TEXT, subText: "#7F5A1F", dot: AMBER },
  needs_payment: { fill: "var(--terracotta)", fillOpacity: 0.14, stroke: "var(--terracotta)", strokeWidth: ACTION, text: TEXT, subText: "var(--terracotta-2)", dot: "var(--terracotta)" },
  needs_payment_urgent: { fill: "var(--terracotta)", fillOpacity: 0.22, stroke: "var(--terracotta-2)", strokeWidth: ACTION, text: TEXT, subText: "#8E3519", dot: "var(--terracotta-2)", pulse: true },
  danger: { fill: RED, fillOpacity: 0.14, stroke: RED, strokeWidth: ACTION, text: TEXT, subText: "#A12622", dot: RED, pulse: true },
};
const variant = (fn: (t: TableTone) => TableTone) =>
  Object.fromEntries(Object.entries(TONES).map(([k, v]) => [k, fn(v)])) as Record<ToneKey, TableTone>;
const DIMMED = variant((t) => ({ ...t, dim: true }));
/** Llamó al mesero: el punto pasa a terracota y titila (en la tarjeta, la campana). */
const WITH_WAITER = variant((t) => ({ ...t, dot: "var(--terracotta)", pulse: true }));
const WITH_WAITER_DIM = variant((t) => ({ ...t, dot: "var(--terracotta)", pulse: true, dim: true }));

/**
 * Las mesas en su lugar real, con el mismo código de colores de las
 * tarjetas. Tocar una mesa hace exactamente lo mismo que tocar su tarjeta
 * (lo resuelve `onActivate` en MesasGrid). Las mesas que no entran en el
 * filtro activo se atenúan, no desaparecen: el mapa sigue siendo el salón.
 */
export function SalonMap({
  floor,
  tiles,
  visibleIds,
  isHighlighted,
  now,
  onActivate,
}: {
  floor: SalonFloor;
  tiles: TileData[];
  visibleIds: ReadonlySet<string>;
  isHighlighted: (tile: Extract<TileData, { state: "recently_paid" }>) => boolean;
  now: number;
  onActivate: (id: string) => void;
}) {
  const tr = useTranslations("opTables");
  const byId = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);

  // Mismo objeto por mesa mientras no cambie el plano (los refrescos en
  // vivo traen tiles nuevos, pero el lugar de cada mesa no cambia).
  const canvasTables = useMemo<CanvasTable[]>(() => {
    const out: CanvasTable[] = [];
    for (const tile of tiles) {
      const ft = floor.tables[tile.id];
      if (!ft) continue;
      out.push({
        id: tile.id,
        number: tile.number,
        label: tile.label,
        capacity: ft.capacity,
        shape: ft.shape,
        placement: ft.placement,
      });
    }
    return out;
  }, [tiles, floor.tables]);

  const tableState = useCallback(
    (c: CanvasTable): TableState => {
      const tile = byId.get(c.id);
      if (!tile) return {};
      const dim = !visibleIds.has(c.id);
      const name = tile.label
        ? tr("tableFullWithLabel", { number: tile.number, label: tile.label })
        : tr("tableFull", { number: tile.number });
      if (tile.state === "free") {
        return {
          tone: dim ? DIMMED.free : TONES.free,
          ariaLabel: tr("mapTableAria", { table: name, state: tr("tileFree") }),
          sub: tr("tileFree"),
        };
      }
      if (tile.state === "recently_paid") {
        const highlight = isHighlighted(tile);
        const mins = minutesSincePaid(tile.paidAt, now);
        const ago = mins === 0 ? tr("tileNow") : tr("elapsedAgo", { mins });
        const key: ToneKey = highlight ? "phone_paid" : "recently_paid";
        return {
          tone: (dim ? DIMMED : TONES)[key],
          ariaLabel: tr("mapTableAria", {
            table: name,
            state: highlight ? `${tr("tilePaidFromPhone")}, ${ago}` : ago,
          }),
          sub: mins === 0 ? tr("tileNow") : tr("tileMinutesAgo", { mins }),
        };
      }
      const amount = fmtCOP(tile.order.outstandingCents);
      const waiter = tile.order.needsWaiter;
      const set = waiter ? (dim ? WITH_WAITER_DIM : WITH_WAITER) : dim ? DIMMED : TONES;
      // El estado también en texto, igual que la tarjeta (tileStateLabel).
      const stateKey = tileStateLabelKey(tile.visualState, {
        needsWaiter: waiter,
        pendingMethods: tile.order.pendingPayments.map((p) => p.method),
      });
      const stateText = stateKey ? tr(stateKey) : null;
      const parts = [stateText, amount, waiter && stateKey !== "tileStateCalledWaiter" ? tr("waiterCallPending") : null];
      return {
        tone: set[tile.visualState],
        ariaLabel: tr("mapTableAria", { table: name, state: parts.filter(Boolean).join(", ") }),
        // Si la mesa se ve chica cabe una línea: el estado; si es grande,
        // también el monto.
        sub: stateText ?? amount,
        sub2: stateText ? amount : null,
      };
    },
    [byId, visibleIds, isHighlighted, now, tr],
  );

  return (
    <FloorPlanView
      scene={floor.scene}
      tables={canvasTables}
      tableState={tableState}
      onTableActivate={onActivate}
      ariaLabel={tr("mapAria")}
      minPxPerUnit={40}
      maxPxPerUnit={90}
      className="fp-view--salon"
    />
  );
}
