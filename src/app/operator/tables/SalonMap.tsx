"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import type { FloorScene, TablePlacement, TableShape } from "@/lib/floorPlan";
import { fmtCOP } from "@/lib/format";
import type { TableVisualState } from "@/lib/walkoutRisk";
import { minutesSincePaid } from "@/lib/tables/phonePaid";
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
// tileTokensForState), en valores CSS que el SVG entiende. Constantes: el
// dibujo de una mesa solo se rehace cuando cambia su estado.
const mix = (c: string, pct: number, base = "var(--op-surface)") =>
  `color-mix(in srgb, ${c} ${pct}%, ${base})`;
const AMBER = "#C98A2E";
const RED = "#C9302C";
const TEXT = "var(--op-text)";

type ToneKey = TableVisualState | "phone_paid" | "waiter";

const TONES: Record<ToneKey, TableTone> = {
  free: { fill: "var(--op-surface)", stroke: mix("var(--op-text)", 45, "transparent"), text: TEXT },
  recently_paid: { fill: mix("var(--ok)", 12), stroke: mix("var(--ok)", 60, "transparent"), text: TEXT, dot: "var(--ok)" },
  phone_paid: { fill: "var(--ok)", stroke: "var(--ok)", text: "var(--bone)", dot: "var(--bone)" },
  cooking: { fill: mix(AMBER, 9), stroke: mix(AMBER, 45, "transparent"), text: TEXT, dot: mix(AMBER, 70, "transparent") },
  ready_to_serve: { fill: mix(AMBER, 20), stroke: mix(AMBER, 75, "transparent"), text: TEXT, dot: AMBER },
  eating: { fill: mix("var(--op-text)", 7), stroke: mix("var(--op-text)", 35, "transparent"), text: TEXT, dot: mix("var(--op-text)", 50, "transparent") },
  eating_at_risk: { fill: mix(AMBER, 16), stroke: mix(AMBER, 65, "transparent"), text: TEXT, dot: AMBER },
  needs_payment: { fill: mix("var(--terracotta)", 14), stroke: mix("var(--terracotta)", 60, "transparent"), text: TEXT, dot: "var(--terracotta)" },
  needs_payment_urgent: { fill: mix("var(--terracotta)", 22), stroke: "var(--terracotta)", text: TEXT, dot: "var(--terracotta)", pulse: true },
  danger: { fill: mix(RED, 14), stroke: mix(RED, 65, "transparent"), text: TEXT, dot: RED, pulse: true },
  // Llamó al mesero: el punto de la esquina pasa a terracota y titila (en
  // la tarjeta es la campana).
  waiter: { fill: "var(--op-surface)", stroke: mix("var(--op-text)", 45, "transparent"), text: TEXT, dot: "var(--terracotta)", pulse: true },
};
const DIMMED = Object.fromEntries(
  Object.entries(TONES).map(([k, v]) => [k, { ...v, dim: true }]),
) as Record<ToneKey, TableTone>;
/** Variante con el punto de «llamó al mesero» sobre el color del estado. */
const WITH_WAITER = Object.fromEntries(
  Object.entries(TONES).map(([k, v]) => [k, { ...v, dot: "var(--terracotta)", pulse: true }]),
) as Record<ToneKey, TableTone>;
const WITH_WAITER_DIM = Object.fromEntries(
  Object.entries(WITH_WAITER).map(([k, v]) => [k, { ...v, dim: true }]),
) as Record<ToneKey, TableTone>;

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
      return {
        tone: set[tile.visualState],
        ariaLabel: tr("mapTableAria", {
          table: name,
          state: waiter ? `${amount}, ${tr("waiterCallPending")}` : amount,
        }),
        sub: amount,
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
