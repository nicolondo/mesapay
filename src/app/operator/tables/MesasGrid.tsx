"use client";
import { useClock } from "@/lib/browser/clock";

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { CompPolicyView } from "@/lib/staffPolicies";
import { fmtCOP } from "@/lib/format";
import {
  tileTokensForState,
  type RiskLevel,
  type TableVisualState,
} from "@/lib/walkoutRisk";
import {
  isPhonePaidHighlighted,
  isSalonTableActive,
  mostUrgentVisualState,
  sortTablesForSalon,
  sortTablesInSalonOrder,
  type SalonSortOptions,
} from "@/lib/tables/sortTables";
import {
  isRecentlyPaidVisible,
  minutesSincePaid,
} from "@/lib/tables/phonePaid";
import { TableDetailSheet } from "./TableDetailSheet";
import { resolveOpenDetail, type OpenTileRef } from "./openDetail";
import { useActiveSectionCollapsed } from "./activeSectionMemory";
import { TablesToolbar, type TableFilter } from "./TablesToolbar";
import { SalonMap, useSalonView, type SalonFloor } from "./SalonMap";
import { tileStateLabelKey } from "@/lib/tables/tileStateLabel";
import type { InvoiceIntent, InvoiceRequestSummary } from "@/components/invoice/types";
import type { InvoicedOrderView } from "@/components/invoice/PreInvoicePanel";
import type { PendingPaymentView } from "@/components/payments/PendingPaymentNotice";
import type { TerminalAmountView } from "@/lib/payments/terminalAmount";
import type { RestaurantTax } from "@/lib/salesTax";
import type { DiscountOriginView, OrderReviewView } from "@/lib/orderReview";

/**
 * Grilla compacta de mesas con chips de filtro + accordion-on-tap.
 * Diseñada para anti-walkout en mobile: ver el piso entero de un
 * vistazo, cada tile coloreado por nivel de riesgo de fuga sin pago,
 * tap → abre el sheet de detalle existente.
 *
 * Densidad target: 3 cols en mobile (iPhone 390px → ~24 tiles
 * visibles), 4 en tablet, 5-6 en desktop.
 *
 * ORDEN, en dos secciones (pedido del dueño: "las mesas ocupadas están en
 * la parte de arriba, o sea que se desaparecen de su ubicación original,
 * quisiera que esto siga así, pero que no se desaparezcan de su ubicación
 * original para poderlas ver en orden también"):
 *
 *   «Activas (N)»      las de cuenta abierta — las que piden acción arriba
 *                      de todo — y la que acaba de pagar desde el celular.
 *   «Todas las mesas»  el salón completo en su orden natural (por número),
 *                      con las ocupadas EN SU SITIO y con su color/estado.
 *
 * Así una mesa ocupada aparece DOS veces, y las dos apariciones son la
 * misma mesa: abren la misma ficha y se refrescan juntas (salen del mismo
 * array `liveTiles`). Ver src/lib/tables/sortTables.ts.
 *
 * La sección de arriba solo sale en el chip «Todas» y solo si hay alguna
 * activa: en «Por cobrar» / «Recién pagadas» / «Libres» la lista ya es de
 * un solo estado y repetirla no agrega nada, así que esos chips siguen con
 * una sola lista en el orden de siempre (activas primero). En modo edición
 * tampoco: ahí se renombra y se borra, no se atiende.
 *
 * En Mostrador (`counterMode`) no hay doble vista: el salón es UNA sola
 * tarjeta y dibujarla dos veces bajo encabezados de mesas no dice nada.
 *
 * El sheet de detalle (TableDetailSheet) se renderea en modo controlled y
 * se monta UNA sola vez, fuera de las listas: cuelga de la mesa + la
 * cuenta, no de la tarjeta que lo abrió (ver openDetail.ts). Así da igual
 * desde qué aparición se tocó, las dos apariciones no montan dos fichas, y
 * la ficha no se esconde si la mesa cambia de aparición entre dos
 * refrescos (p. ej. se ubica en el plano del mapa, o se saca de él).
 * Sólo una ficha a la vez. Tap fuera o tap en el mismo tile la cierra.
 *
 * FACTURAS MANUALES: cuentas sin mesa física (mesas ocultas
 * `kind = manual`, ver src/lib/manualInvoice.ts). NUNCA se dibujan acá:
 * viven en /operator/facturas-manuales (su ficha) y en Órdenes. El botón
 * "Factura manual" en la barra de facturación crea una y va a su ficha; al lado,
 * el acceso a las pendientes.
 */

/**
 * Listas vacías estables para las tarjetas cerradas: `ActiveTile` sólo usa
 * los destinos de «Mover a otra mesa» con la ficha abierta, y una literal
 * `[]` nueva en cada render rompería su memoización.
 */
const NO_FREE_TABLES: FreeTable[] = [];
const NO_ALL_TABLES: AllTable[] = [];

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
      // La cuenta la cerró el comensal desde su celular (tarjeta, Apple/Google
      // Pay, PSE) sin que nadie del equipo cobrara: durante los minutos del
      // comercio la mesa va de primera y en verde fuerte. Ver phonePaid.ts.
      paidFromPhone: boolean;
      // Cerrada (toda o una parte) a crédito: la mesa quedó libre, pero la
      // plata no entró; es deuda del cliente en Cartera. Ver creditSale.ts.
      onCredit?: boolean;
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
  /** Cobrable: el subtotal ya con el descuento del comensal restado. */
  subtotalCents: number;
  /** Subtotal antes del descuento — solo para el desglose. */
  grossSubtotalCents: number;
  discountCents: number;
  discountPct: number | null;
  /** De dónde viene el descuento (cliente de facturación o comensal). */
  discountOrigin: DiscountOriginView;
  /** Aviso «Revisar» (src/lib/orderReviewFlags.ts); null = nada que revisar. */
  review: OrderReviewView | null;
  customer: {
    id: string;
    name: string | null;
    email: string;
    cedula: string | null;
  } | null;
  /** Solicitud de factura pendiente de la cuenta: el cliente al que va. */
  invoiceRequest: InvoiceRequestSummary | null;
  /** Lo que ya se pidió de factura (personalizada / genérica con correo). */
  invoiceIntent: InvoiceIntent | null;
  /** Factura ya emitida (antes de cobrar): la cuenta queda cerrada. */
  invoice: InvoicedOrderView | null;
  outstandingCents: number;
  needsWaiter: boolean;
  rounds: Round[];
  /** Pagos `pending` (solicitudes del comensal y pagos en línea en curso). */
  pendingPayments: PendingPaymentView[];
  /** Datáfono aprobado por otro monto (propina del datáfono o parcial). */
  terminalAmounts?: TerminalAmountView[];
};

type Round = {
  id: string;
  seq: number;
  status: string;
  placedAt: string;
  placedByName: string | null;
  placedByRole: string | null;
  items: ItemDetail[];
};

type ItemDetail = {
  id: string;
  menuItemId: string | null;
  name: string;
  qty: number;
  priceCents: number;
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  preparationStartedAt: string | null;
  preparationFirstStartedAt: string | null;
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

export function MesasGrid({
  floor = null,
  tableManagement,
  viewerId = null,
  initialTime,
  tiles,
  manualPendingCount,
  canOpenManual,
  initialOpenTileId = null,
  tenantSlug,
  counterMode,
  isMeseroView,
  chargeLocked,
  moveLocked,
  compPolicy,
  viewerRole,
  freeTables,
  allTables,
  country,
  salesTax,
  phonePaidHighlightMinutes,
}: {
  // Plano del salón (vista «Mapa»). null = no hay mesas ubicadas en el
  // plano (o modo mostrador): el conmutador Tarjetas / Mapa no aparece.
  floor?: SalonFloor | null;
  // Alta e impresión de mesas, dentro de la gestión secundaria del salón.
  tableManagement?: ReactNode;
  // Para recordar la vista elegida por usuario en este equipo.
  viewerId?: string | null;
  initialTime: number;
  tiles: TileData[];
  // Facturas manuales pendientes (borrador o enviadas con link): NO se
  // dibujan acá — viven en /operator/facturas-manuales. Sólo el número,
  // para el acceso. 0 para el mesero.
  manualPendingCount: number;
  // Si se muestra el botón "Factura manual" — caja, no el mesero.
  canOpenManual: boolean;
  // Mesa cuya ficha abre al cargar (`?open=<tableId>`): así "Nueva
  // orden → Factura manual" y el menú en modo operador aterrizan en la
  // factura recién abierta.
  initialOpenTileId?: string | null;
  tenantSlug: string;
  counterMode: boolean;
  isMeseroView: boolean;
  // "Solo el administrador cobra" activo y quien mira es un mesero: el
  // sheet cambia "Cobrar la cuenta" por "Pedir la cuenta".
  chargeLocked: boolean;
  moveLocked: boolean;
  // Quién puede "No cobrar" un plato: si quien mira está bloqueado y qué
  // roles sí pueden (para el aviso). Ver src/lib/staffPolicies.ts.
  compPolicy: CompPolicyView;
  viewerRole: string | null;
  freeTables: FreeTable[];
  allTables: AllTable[];
  // País del comercio (ISO-2). Decide qué tarifas de impuesto se le ofrecen a
  // una línea libre — el IVA de Colombia no es el de México.
  country: string | null;
  // Impuesto de ventas del comercio: el que un cargo puede llevar "incluido"
  // en el precio (como un plato de la carta) y el que la ficha muestra.
  salesTax: RestaurantTax | null;
  // Minutos que una mesa que acaba de pagar desde el celular va de primera y
  // en verde fuerte (Restaurant.phonePaidHighlightMinutes; 0 = apagado).
  phonePaidHighlightMinutes: number;
}) {
  const tr = useTranslations("opTables");
  // Para el mapa del mesero: tocar una mesa libre abre la toma de pedido.
  const router = useRouter();
  const [filter, setFilter] = useState<TableFilter>("all");
  // Reloj del cliente (tick de 10 s): el refresh de la grilla es por SSE y
  // nada avisa cuando VENCE un resalte, así que "ahora" se reevalúa acá para
  // que la mesa pagada desde el celular baje sola y la recién pagada caiga a
  // libre a los 15 min sin esperar al servidor. Arranca con la hora del
  // servidor para que hidratación y primer render coincidan.
  const now = useClock(initialTime);
  const sortOpts = useMemo<SalonSortOptions>(
    () => ({ now, phonePaidHighlightMinutes }),
    [now, phonePaidHighlightMinutes],
  );
  // Qué ficha está abierta: la mesa Y su cuenta (ver openDetail.ts). Sólo
  // una a la vez. No guarda en qué tarjeta se tocó: la ficha se monta en
  // un solo lugar, así que la aparición da igual.
  //
  // La cuenta se fija al abrir, también la que llega por URL (`?open=`):
  // así, cuando esa cuenta termina, la selección deja de resolver para
  // siempre y la ficha no reaparece sola al abrirse la SIGUIENTE cuenta en
  // esa mesa. `?open=` de una mesa sin cuenta no abre nada.
  const [openTile, setOpenTile] = useState<OpenTileRef | null>(() => {
    const t = initialOpenTileId
      ? tiles.find((x) => x.id === initialOpenTileId)
      : undefined;
    return t?.state === "active" ? { tableId: t.id, orderId: t.order.id } : null;
  });
  const [openingManual, setOpeningManual] = useState(false);

  /**
   * Abre una factura manual nueva y va a su ficha, en Facturas manuales:
   * una factura manual no es una mesa y nunca se dibuja en Mesas.
   */
  async function openManualInvoice() {
    setOpeningManual(true);
    try {
      const res = await fetch("/api/operator/manual-invoices", {
        method: "POST",
      });
      if (!res.ok) {
        window.alert(tr("manualInvoiceOpenFailed"));
        return;
      }
      const j = (await res.json()) as { tableId: string };
      // Carga completa: su ficha abre al cargar con `?open=` (una
      // navegación del cliente la cerraba con el historial de la ficha).
      window.location.assign(`/operator/facturas-manuales?open=${encodeURIComponent(j.tableId)}`);
    } catch {
      window.alert(tr("manualInvoiceOpenFailed"));
    } finally {
      setOpeningManual(false);
    }
  }
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

  // Lo que el servidor mandó, releído con el reloj del cliente: una recién
  // pagada cuyo tiempo venció desde el último refresh pasa a libre acá mismo
  // (misma regla que usa el servidor para armar el tile, isRecentlyPaidVisible).
  const liveTiles = useMemo<TileData[]>(
    () =>
      tiles.map((t) =>
        t.state === "recently_paid" &&
        !isRecentlyPaidVisible(t.paidAt, now, {
          paidFromPhone: t.paidFromPhone,
          phonePaidHighlightMinutes,
        })
          ? {
              id: t.id,
              number: t.number,
              label: t.label,
              qrToken: t.qrToken,
              state: "free",
            }
          : t,
      ),
    [tiles, now, phonePaidHighlightMinutes],
  );

  const counts = useMemo(() => {
    const c = { all: liveTiles.length, by_pay: 0, recent: 0, free: 0 };
    for (const t of liveTiles) {
      if (t.state === "active") c.by_pay += 1;
      else if (t.state === "recently_paid") c.recent += 1;
      else c.free += 1;
    }
    return c;
  }, [liveTiles]);

  // La mesa que ACABA DE PAGAR DESDE EL CELULAR va de primera (la más
  // reciente arriba) mientras dure su resalte; después las activas (las que
  // piden acción arriba) y al final las vacías; dentro de cada grupo por
  // número. Se ordena ANTES de filtrar, así el orden vale igual en cualquier
  // chip. `tiles` llega nuevo con cada refresh de LiveRefresh y `now` cambia
  // cada 10 s: React reordena solo por la `key` del tile.
  const ordered = useMemo(
    () => sortTablesForSalon(liveTiles, sortOpts),
    [liveTiles, sortOpts],
  );

  const filtered = useMemo(() => {
    if (filter === "all") return ordered;
    if (filter === "by_pay") return ordered.filter((t) => t.state === "active");
    if (filter === "recent")
      return ordered.filter((t) => t.state === "recently_paid");
    return ordered.filter((t) => t.state === "free");
  }, [ordered, filter]);

  // Sección de arriba: las mesas que `ordered` adelanta (cuenta abierta +
  // la que acaba de pagar desde el celular), en ese mismo orden.
  const activeTiles = useMemo(
    () => filtered.filter((t) => isSalonTableActive(t, sortOpts)),
    [filtered, sortOpts],
  );
  // Lista completa en el orden natural del salón: cada mesa en su sitio de
  // siempre, ocupada o no. Es la misma gente de `filtered`, solo reordenada.
  const inSalonOrder = useMemo(() => sortTablesInSalonOrder(filtered), [filtered]);

  // Vista «Mapa»: las mesas en su lugar real. Solo si hay plano y fuera
  // del modo edición (que usa las tarjetas para renombrar/borrar).
  const [view, setView] = useSalonView(viewerId);
  const canMap = !!floor && !counterMode;
  const showMap = canMap && !editMode && view === "map";
  // Doble vista solo en «Todas» y solo con alguna mesa activa: si no, la
  // sección de arriba sería la misma lista repetida (o estaría vacía). En
  // Mostrador nunca: el salón es una sola tarjeta («Mostrador»), repetirla
  // bajo dos encabezados de mesas no ayuda a nadie.
  const showActiveSection =
    !showMap &&
    !editMode &&
    !counterMode &&
    filter === "all" &&
    activeTiles.length > 0;
  // Plegar/desplegar «Activas», recordado en este equipo para este
  // comercio (ver activeSectionMemory.ts). Plegada, el encabezado con el
  // contador se queda: se ve cuántas hay sin que ocupen pantalla.
  const [activeCollapsed, setActiveCollapsed] =
    useActiveSectionCollapsed(tenantSlug);
  const activeGridId = useId();
  // Con la sección plegada no se ven las tarjetas, así que el encabezado
  // insinúa con un punto del mismo tono que ya usan los tiles si alguna
  // mesa pide acción (riesgo de fuga, cobro pedido, mesero llamado). NO se
  // despliega sola: el que la plegó decidió que quería la pantalla libre,
  // y abrírsela de golpe mientras cobra sería peor que el aviso.
  const urgentState = useMemo(
    () => (activeCollapsed ? mostUrgentVisualState(activeTiles, sortOpts) : null),
    [activeCollapsed, activeTiles, sortOpts],
  );
  // La mesa cuya ficha está abierta, si su cuenta sigue viva. Sale de
  // `liveTiles` (no de las listas filtradas): un chip o el mapa no cierran
  // la ficha de una mesa que dejó de estar a la vista.
  const openDetail = useMemo(() => {
    const tile = resolveOpenDetail(openTile, liveTiles);
    // `resolveOpenDetail` ya garantiza la cuenta abierta; el chequeo
    // vuelve a estrechar la unión de TileData para TypeScript.
    return tile?.state === "active" ? tile : null;
  }, [openTile, liveTiles]);
  // Si la cuenta terminó (se cobró, se canceló), `openDetail` ya es null y
  // la ficha se va. La selección que queda colgando es inerte: apunta a una
  // cuenta que no vuelve, así que ninguna cuenta futura la revive. La
  // próxima mesa que se toque la reemplaza.

  // Destinos de «Mover a otra mesa»: sólo los usa la ficha abierta, que es
  // una sola. Calcularlos por tarjeta rehacía dos listas por cada mesa
  // ocupada en cada tick del reloj (10 s), con las fichas cerradas.
  const detailFreeTables = useMemo(
    () => (openDetail ? freeTables.filter((ft) => ft.id !== openDetail.id) : NO_FREE_TABLES),
    [openDetail, freeTables],
  );
  const detailAllTables = useMemo(
    () => (openDetail ? allTables.filter((at) => at.id !== openDetail.id) : NO_ALL_TABLES),
    [openDetail, allTables],
  );
  const visibleIds = useMemo(() => new Set(filtered.map((t) => t.id)), [filtered]);
  const isHighlighted = useCallback(
    (t: Extract<TileData, { state: "recently_paid" }>) => isPhonePaidHighlighted(t, sortOpts),
    [sortOpts],
  );
  // Tocar una mesa en el mapa hace lo mismo que tocar su tarjeta: libre o
  // recién pagada → tomar pedido (pestaña nueva en caja, misma app en el
  // mesero); con cuenta → la ficha.
  const activateFromMap = useCallback(
    (id: string) => {
      const tile = liveTiles.find((t) => t.id === id);
      if (!tile) return;
      if (tile.state === "active") {
        setOpenTile({ tableId: id, orderId: tile.order.id });
        return;
      }
      const href = isMeseroView
        ? `/mesero/pedir/${tile.id}`
        : `/t/${tenantSlug}/menu?table=${tile.qrToken}&op=1`;
      if (isMeseroView) router.push(href);
      else window.open(href, "_blank", "noreferrer");
    },
    [liveTiles, isMeseroView, tenantSlug, router],
  );
  const offMap = useMemo(
    () => (floor ? filtered.filter((t) => !floor.tables[t.id]) : []),
    [filtered, floor],
  );
  // Una tarjeta del Salón. La usan las dos secciones de la grilla y, en la
  // vista «Mapa», las mesas que no están en el plano. Con `sheetOnly` es
  // la ficha abierta: el único sitio donde se monta el sheet.
  //
  // La `key` es el id de la mesa a secas: una mesa ocupada se dibuja en
  // «Activas» y otra vez en «Todas las mesas», pero cada lista es un padre
  // distinto y las `key` sólo tienen que ser únicas entre hermanas.
  function renderTile(tile: TileData, opts?: { sheetOnly?: boolean }) {
          const sheetOnly = opts?.sheetOnly ?? false;
          const key = tile.id;
          if (editMode) {
            return (
              <ManageTileButton
                key={key}
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
                key={key}
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
                key={key}
                now={now}
                tile={tile}
                highlight={isPhonePaidHighlighted(tile, sortOpts)}
                counterMode={counterMode}
                isMeseroView={isMeseroView}
                tenantSlug={tenantSlug}
              />
            );
          }
          // active
          return (
            <ActiveTile
              key={key}
              tile={tile}
              sheetOnly={sheetOnly}
              counterMode={counterMode}
              // La tarjeta nunca monta el sheet: sólo avisa qué mesa se
              // tocó. El sheet lo monta la instancia `sheetOnly`.
              open={sheetOnly}
              onOpenChange={(next) =>
                setOpenTile(
                  next ? { tableId: tile.id, orderId: tile.order.id } : null,
                )
              }
              freeTables={sheetOnly ? detailFreeTables : NO_FREE_TABLES}
              allTables={sheetOnly ? detailAllTables : NO_ALL_TABLES}
              tenantSlug={tenantSlug}
              isMeseroView={isMeseroView}
              country={country}
              salesTax={salesTax}
              chargeLocked={chargeLocked}
              moveLocked={moveLocked}
              compPolicy={compPolicy}
              viewerRole={viewerRole}
            />
          );
  }

  return (
    <>
      <TablesToolbar
        filter={filter}
        counts={counts}
        onFilterChange={setFilter}
        view={view}
        onViewChange={setView}
        canMap={canMap}
        canManage={!isMeseroView}
        editMode={editMode}
        onEditModeChange={(editing) => {
          setEditMode(editing);
          setOpenTile(null);
        }}
        tableManagement={tableManagement}
        canOpenManual={canOpenManual}
        manualPendingCount={manualPendingCount}
        openingManual={openingManual}
        onOpenManual={openManualInvoice}
      />

      {showMap && floor ? (
        <>
          <SalonMap
            floor={floor}
            tiles={ordered}
            visibleIds={visibleIds}
            isHighlighted={isHighlighted}
            now={now}
            onActivate={activateFromMap}
          />
          {offMap.length > 0 && (
            <section className="mt-5">
              <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {tr("mapOffHeading")}
              </div>
              <p className="text-[11px] text-op-muted mt-0.5 mb-2">
                {tr("mapOffHint")}
                {!isMeseroView && (
                  <>
                    {" "}
                    <Link href="/operator/settings/salon" className="text-terracotta hover:underline">
                      {tr("mapEditLink")}
                    </Link>
                  </>
                )}
              </p>
              <div className="mp-table-grid">
                {offMap.map((tile) => renderTile(tile))}
              </div>
            </section>
          )}
        </>
      ) : showActiveSection ? (
        /* Dos secciones: las activas arriba y el salón completo debajo, con
           las ocupadas otra vez en su sitio. Son dos listas hermanas, cada
           una con sus propias `key`s. */
        <>
          <section>
            <h2 className="mp-table-section-heading">
              <button
                type="button"
                aria-expanded={!activeCollapsed}
                aria-controls={activeGridId}
                onClick={() => setActiveCollapsed(!activeCollapsed)}
                className="mp-table-section-toggle"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden="true"
                  className="mp-table-section-chevron"
                  data-open={!activeCollapsed}
                >
                  <path
                    d="m3 4.5 3 3 3-3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{tr("activeHeading", { count: activeTiles.length })}</span>
                {urgentState && (
                  <>
                    <span
                      aria-hidden
                      className={
                        "mp-table-section-dot " +
                        tileTokensForState(urgentState).dot +
                        (tileTokensForState(urgentState).pulse ? " animate-pulse" : "")
                      }
                    />
                    {/* El punto es color: el motivo, en texto, para quien
                        no lo ve. Entra en el nombre accesible del botón. */}
                    <span className="sr-only">{tr("activeUrgentHint")}</span>
                  </>
                )}
              </button>
            </h2>
            <div className="mp-table-grid" id={activeGridId} hidden={activeCollapsed}>
              {!activeCollapsed && activeTiles.map((tile) => renderTile(tile))}
            </div>
          </section>
          <section className="mt-5">
            <h2 className="mp-table-section-heading">{tr("allTablesHeading")}</h2>
            <p className="text-[11px] text-op-muted mt-0.5 mb-2">
              {tr("allTablesHint")}
            </p>
            <div className="mp-table-grid">
              {inSalonOrder.map((tile) => renderTile(tile))}
            </div>
          </section>
        </>
      ) : (
        /* Grid de tiles compactos */
        <div className="mp-table-grid">
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-sm text-op-muted py-8">
              {tr("emptyFilter")}
            </div>
          )}
          {filtered.map((tile) => renderTile(tile))}
        </div>
      )}

      {/* La ficha de la mesa abierta: UN solo sitio, fuera de las listas.
          Da igual desde qué tarjeta (o desde el mapa) se tocó, y no se
          esconde si la mesa cambia de aparición en un refresco. */}
      {openDetail && renderTile(openDetail, { sheetOnly: true })}

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
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
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

/**
 * Tile libre — link directo a "Tomar pedido". No abre sheet (no hay
 * orden que ver). En operator/admin abre tab nueva; en mesero
 * navega interno. Sin prefetch: cada refresh de la grilla volvería a
 * descargar la carta completa por cada mesa libre o recién pagada.
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
      prefetch={false}
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
 *
 * Con `highlight` (la cuenta la pagó el comensal desde su celular hace menos
 * de los minutos del comercio) se pinta de verde FUERTE con el rótulo "Pagó
 * desde el celular · hace N min": es la mesa que va de primera para ver que
 * ya pagó cuando la gente se está levantando. Al vencer, el padre deja de
 * pasar `highlight` y vuelve al verde claro de siempre.
 *
 * Tap arranca un pedido nuevo (la mesa ya está físicamente libre y
 * un grupo nuevo puede llegar enseguida — mismo target que FreeTile).
 */
function RecentlyPaidTile({
  now,
  tile,
  highlight,
  counterMode,
  isMeseroView,
  tenantSlug,
}: {
  // Reloj del padre (useClock): un solo tick para toda la grilla.
  now: number;
  tile: Extract<TileData, { state: "recently_paid" }>;
  highlight: boolean;
  counterMode: boolean;
  isMeseroView: boolean;
  tenantSlug: string;
}) {
  const tr = useTranslations("opTables");
  const minsAgo = minutesSincePaid(tile.paidAt, now);
  // Mismo href + target que FreeTile — la mesa está libre para
  // recibir un grupo nuevo, sólo que recordamos el pago previo como
  // info al operador.
  const href = isMeseroView
    ? `/mesero/pedir/${tile.id}`
    : `/t/${tenantSlug}/menu?table=${tile.qrToken}&op=1`;
  const targetProps = isMeseroView
    ? {}
    : { target: "_blank" as const, rel: "noreferrer" };
  const base =
    "aspect-[4/3] rounded-xl border p-2 flex flex-col items-center justify-center text-center relative transition-colors ";
  return (
    <Link
      href={href}
      prefetch={false}
      {...targetProps}
      className={
        base +
        (highlight
          ? "border-ok bg-ok text-bone hover:bg-ok/90 shadow-md"
          : "border-ok/35 bg-ok/10 hover:bg-ok/15")
      }
    >
      <div className="font-display text-base leading-none">
        {counterMode
          ? tr("tileCounterShort")
          : tr("tileTableShort", { number: tile.number })}
      </div>
      {tile.label && (
        <div
          className={
            "font-mono text-[9px] mt-0.5 truncate w-full " +
            (highlight ? "text-bone" : "text-op-muted")
          }
        >
          {tile.label}
        </div>
      )}
      {highlight ? (
        <>
          <div className="text-[10px] font-semibold mt-1 leading-tight">
            <span aria-hidden>{"✓ "}</span>
            {tr("tilePaidFromPhone")}
          </div>
          <div className="text-[10px] text-bone leading-tight">
            {minsAgo === 0 ? tr("tileNow") : tr("elapsedAgo", { mins: minsAgo })}
          </div>
        </>
      ) : (
        <div className="text-[10px] text-[#1E5339] font-medium mt-1">
          <span aria-hidden>{"✓ "}</span>
          {minsAgo === 0 ? tr("tileNow") : tr("tileMinutesAgo", { mins: minsAgo })}
        </div>
      )}
      {tile.onCredit && (
        <div
          className={
            "mt-0.5 rounded-full border px-1.5 text-[9px] font-medium leading-4 " +
            (highlight ? "border-bone/60 text-bone" : "border-[#C98A2E]/60 bg-[#C98A2E]/10 text-[#8F6828]")
          }
        >
          {tr("tileOnCredit")}
        </div>
      )}
      <span
        aria-hidden
        className={
          "absolute bottom-2.5 right-2.5 inline-block w-2 h-2 rounded-full " +
          (highlight ? "bg-bone" : "bg-ok")
        }
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
  sheetOnly = false,
  counterMode,
  open,
  onOpenChange,
  freeTables,
  allTables,
  tenantSlug,
  isMeseroView,
  country,
  salesTax,
  chargeLocked,
  moveLocked,
  compPolicy,
  viewerRole,
}: {
  tile: Extract<TileData, { state: "active" }>;
  /** Solo la ficha (la abrió el mapa): sin la tarjeta. */
  sheetOnly?: boolean;
  counterMode: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  freeTables: FreeTable[];
  allTables: AllTable[];
  tenantSlug: string;
  isMeseroView: boolean;
  country: string | null;
  salesTax: RestaurantTax | null;
  chargeLocked: boolean;
  moveLocked: boolean;
  compPolicy: CompPolicyView;
  viewerRole: string | null;
}) {
  const tr = useTranslations("opTables");
  const tPre = useTranslations("preInvoice");
  const tReview = useTranslations("orderReview");
  const tokens = tileTokensForState(tile.visualState);
  const tableLabel = counterMode
    ? tr("tableFullCounter")
    : tile.label
      ? tr("tableFullWithLabel", { number: tile.number, label: tile.label })
      : tr("tableFull", { number: tile.number });
  const pulse = tokens.pulse;
  // El estado también en texto: el color y el punto no alcanzan en pantallas
  // pobres (datáfono) ni para quien no distingue bien los colores.
  const stateKey = tileStateLabelKey(tile.visualState, {
    needsWaiter: tile.order.needsWaiter,
    pendingMethods: tile.order.pendingPayments.map((p) => p.method),
  });
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
      {!sheetOnly && (
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
        {stateKey && (
          <div className={"mp-tile-state " + tokens.textAccent}>
            {tr(stateKey)}
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
        {/* Overlay: cuenta ya facturada (factura antes de cobrar),
            arriba a la izquierda — pendiente de pago, no se le suma nada. */}
        {tile.order.invoice && (
          <span className="absolute top-1 left-1.5 font-mono text-[8px] tracking-wider uppercase text-[#8F6828] bg-[#F6EEDD] rounded px-1">
            {tPre("tileBadge")}
          </span>
        )}
        {/* Overlay: «Revisar» — la cuenta puede ser de otro grupo
            (descuento de un cliente puesto antes, cobro rechazado, horas
            sin rondas). El detalle y las acciones están en la ficha. */}
        {tile.order.review && (
          <span
            data-testid="tile-review-badge"
            className={
              "absolute left-1.5 font-mono text-[8px] tracking-wider uppercase text-bone bg-warn rounded px-1 " +
              (tile.order.invoice ? "top-4" : "top-1")
            }
          >
            {tReview("badge")}
          </span>
        )}
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
      )}

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
          grossSubtotalCents={tile.order.grossSubtotalCents}
          discountCents={tile.order.discountCents}
          discountPct={tile.order.discountPct}
          discountOrigin={tile.order.discountOrigin}
          review={tile.order.review}
          customer={tile.order.customer}
          invoiceIntent={tile.order.invoiceIntent}
          invoice={tile.order.invoice}
          pendingPayments={tile.order.pendingPayments}
          terminalAmounts={tile.order.terminalAmounts}
          counterMode={counterMode}
          tenantSlug={tenantSlug}
          qrToken={tile.qrToken}
          isMeseroView={isMeseroView}
          country={country}
          salesTax={salesTax}
          chargeLocked={chargeLocked}
          moveLocked={moveLocked}
          compPolicy={compPolicy}
          viewerRole={viewerRole}
        />
      )}
    </>
  );
}
