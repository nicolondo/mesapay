"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BoardDot, BOARD_BY_HREF, useAnyBoardAlert } from "./BoardDot";
import type { BoardActivity } from "./boardActivity";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon, routeIcon } from "@/components/ui/Icon";
import { ScrollerNavigationReset } from "@/components/ScrollerNavigationReset";
import { NavigationSearch } from "./NavigationSearch";
import type { NavEntry } from "./OperatorMobileMenu";
import { useActiveNav } from "./useActiveNav";
import { WORKSPACE_RAIL_THEME } from "@/components/ui/workspaceRailTheme";

/**
 * Shell "cockpit" del operador (rediseño detrás del flag mp_shell=cockpit):
 * riel lateral oscuro con el pulso de tableros en vivo arriba + contenido
 * claro. Reusa la data de nav, BoardDot y los nodos server-side (banners,
 * selector de idioma, salir) que el layout le pasa como props.
 *
 * La paleta del riel es oscura SIEMPRE (independiente del tema del contenido),
 * como en el mockup aprobado. Se define local para no ensuciar los tokens.
 * Los enlaces no precargan: cada refresh en vivo invalida el prefetch de
 * Next y volvería a solicitar todas las pantallas visibles del riel.
 */

export function OperatorCockpit({
  navItems,
  boardActivity,
  roleLabel,
  tenantName,
  userEmail,
  isAdmin,
  localeSwitcher,
  signOut,
  banners,
  children,
}: {
  navItems: NavEntry[];
  boardActivity?: BoardActivity;
  roleLabel: string;
  tenantName: string;
  userEmail: string;
  isAdmin: boolean;
  localeSwitcher: React.ReactNode;
  signOut: React.ReactNode;
  banners: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useTranslations("operator");
  const ux = useTranslations("workspaceUi");
  const pathname = usePathname();
  // Ítem activo (ruta + ?tab=) resuelto UNA vez sobre toda la nav.
  const { activeHref, locationKey } = useActiveNav(navItems);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const anyAlert = useAnyBoardAlert(boardActivity, pathname);

  // Cerrar el drawer al navegar (ajuste en render, no en efecto). Se mira la
  // ubicación completa: tocar una pestaña de contabilidad desde el drawer
  // también debe cerrarlo aunque la ruta no cambie.
  const [lastLocation, setLastLocation] = useState(locationKey);
  if (locationKey !== lastLocation) {
    setLastLocation(locationKey);
    setDrawerOpen(false);
  }

  const railProps = {
    navItems,
    boardActivity,
    roleLabel,
    tenantName,
    userEmail,
    isAdmin,
    localeSwitcher,
    signOut,
    activeHref,
    locationKey,
    adminLabel: t("adminLink"),
    liveLabel: t("liveSection"),
    accountLabel: t("accountSection"),
  };

  return (
    <div className="op-app-shell md:grid md:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)] bg-op-bg text-op-text overflow-hidden">
      <a href="#operator-content" className="mp-skip-link">
        {ux("skipContent")}
      </a>
      {/* Riel desktop. print:hidden — el chrome del panel no va al papel
          (páginas como los QRs de mesa se imprimen desde acá). */}
      <aside
        className="hidden md:flex print:hidden sticky top-0 h-full min-h-0"
        style={WORKSPACE_RAIL_THEME}
      >
        <Rail {...railProps} />
      </aside>

      {/* Columna de contenido */}
      <div className="flex min-w-0 min-h-0 flex-col h-full overflow-hidden">
        {/* Topbar móvil (hamburguesa) */}
        <div className="md:hidden print:hidden shrink-0 flex items-center gap-3 px-4 h-14 border-b border-op-border bg-op-surface">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("openMenu")}
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            className="relative inline-flex items-center justify-center w-10 h-10 rounded-lg border border-op-border text-op-text active:scale-95 transition-transform"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            >
              <line x1="3" y1="6" x2="17" y2="6" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="14" x2="17" y2="14" />
            </svg>
            {anyAlert && (
              <span
                className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-danger ring-2 ring-op-surface"
                aria-hidden
              />
            )}
          </button>
          <span className="font-display text-xl tracking-[-0.015em]">
            {"MESAPAY"}
          </span>
          <span className="ml-auto font-mono text-[9px] tracking-[0.16em] uppercase text-op-muted truncate max-w-[45%]">
            {tenantName}
          </span>
        </div>

        {/* Banners (impersonation / membership) rendereados server-side */}
        {banners}

        {/* Barra de acciones: buscar orden + accesos rápidos. Persistente
            arriba del contenido en todas las pantallas del operador. */}
        <CockpitTopbar navItems={navItems} />

        {/* Único scroller del contenido. Como vive en el layout, sobrevive a
            la navegación y conservaría el scroll de la pantalla anterior:
            ScrollerNavigationReset lo devuelve al inicio al cambiar de ruta. */}
        <ScrollerNavigationReset scrollerId="operator-content" />
        <main
          id="operator-content"
          tabIndex={-1}
          className="mp-workspace-main flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {children}
        </main>
      </div>

      {/* Drawer móvil */}
      {drawerOpen && (
        <AppDialog
          label={t("openMenu")}
          onClose={() => setDrawerOpen(false)}
          mobileOnly
          className="mp-navigation-drawer"
          style={WORKSPACE_RAIL_THEME}
        >
          <button
            type="button"
            autoFocus
            className="mp-drawer-close"
            onClick={() => setDrawerOpen(false)}
            aria-label={t("closeMenu")}
          >
            <Icon name="close" />
          </button>
          <Rail {...railProps} inDrawer />
        </AppDialog>
      )}
    </div>
  );
}

/* ─────────────────────────── El riel ─────────────────────────── */

function Rail({
  navItems,
  boardActivity,
  roleLabel,
  tenantName,
  userEmail,
  isAdmin,
  localeSwitcher,
  signOut,
  activeHref,
  locationKey,
  adminLabel,
  liveLabel,
  accountLabel,
  inDrawer = false,
}: {
  navItems: NavEntry[];
  boardActivity?: BoardActivity;
  roleLabel: string;
  tenantName: string;
  userEmail: string;
  isAdmin: boolean;
  localeSwitcher: React.ReactNode;
  signOut: React.ReactNode;
  /** Href del único ítem activo (ver `resolveActiveHref`). */
  activeHref: string | null;
  /** Cambia con ruta o pestaña — para reabrir el grupo que contiene el activo. */
  locationKey: string;
  adminLabel: string;
  liveLabel: string;
  /** Nombre accesible del bloque de cuenta (usuario + idioma + salir). */
  accountLabel: string;
  /**
   * `true` en el cajón del celular: el bloque de cuenta es el pie FIJO del
   * cajón, en versión compacta. Ver `account` más abajo.
   */
  inDrawer?: boolean;
}) {
  // Los tableros en vivo (con BoardDot) van arriba, separados del resto.
  const boards = navItems.filter(
    (it) => !("children" in it) && it.href in BOARD_BY_HREF,
  ) as { href: string; label: string }[];
  const summary = navItems.find(
    (it) => !("children" in it) && it.href === "/operator",
  ) as { href: string; label: string } | undefined;
  const rest = navItems.filter(
    (it) =>
      "children" in it ||
      (it.href !== "/operator" && !(it.href in BOARD_BY_HREF)),
  );

  // Cuenta: quién soy + idioma + cerrar sesión. Es el PIE del riel, en
  // escritorio y en el cajón del celular (pedido del dueño: «debe aparecer en
  // la parte de abajo»), y nunca entra al área que hace scroll: la lista de
  // navegación es la única que se desplaza, por encima de él.
  // En el cajón el pie es compacto (quién soy en una fila; idioma y «Cerrar
  // sesión» en otra) y reserva él mismo la franja del indicador de inicio.
  // Que la barra del navegador no lo tape depende del ALTO del cajón, no de
  // dónde está el bloque: ver `.mp-navigation-drawer` en workspace.css.
  // El selector de idioma comparte fila con «Cerrar sesión» (en su propia
  // fila dejaba una franja vacía del ancho del cajón).
  const account = (
    <div
      role="group"
      aria-label={accountLabel}
      className={
        inDrawer
          ? "mp-rail-footer mp-rail-account mp-rail-account--drawer"
          : "mp-rail-footer mp-rail-account"
      }
    >
      <div className="mp-rail-identity flex items-center gap-3 min-w-0">
        <div className="mp-user-avatar">
          {(userEmail[0] || "?").toUpperCase()}
        </div>
        <div className="mp-rail-identity-text min-w-0">
          <div className="mp-rail-tenant text-sm font-medium truncate">
            {tenantName}
          </div>
          <div
            className="mp-rail-email text-xs truncate"
            style={{ color: "var(--rail-muted)" }}
          >
            {userEmail}
          </div>
        </div>
      </div>
      <div className="mp-rail-session">
        {localeSwitcher}
        {signOut}
      </div>
    </div>
  );

  return (
    <div
      className={
        inDrawer
          ? "mp-rail mp-rail--drawer flex w-full min-h-0 flex-col"
          : "mp-rail flex w-full min-h-0 flex-col"
      }
      style={{
        background: "var(--rail)",
        borderRight: "1px solid var(--rail-line)",
        color: "var(--rail-text)",
      }}
    >
      {/* Marca */}
      <div
        className="mp-rail-brand shrink-0 px-5 pt-6 pb-5"
        style={{ borderBottom: "1px solid var(--rail-line)" }}
      >
        <div
          className="font-mono text-[10px] tracking-[0.16em] uppercase truncate"
          style={{ color: "var(--rail-muted)" }}
        >
          {roleLabel}
        </div>
        <div className="font-display text-[28px] leading-none mt-1.5 tracking-[0.005em]">
          {"MESA"}
          <span style={{ color: "var(--rail-accent)" }}>{"PAY"}</span>
        </div>
      </div>

      {/* Scroll de nav: lo único que se desplaza del riel. */}
      <div className="mp-rail-nav min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-3">
        {/* Pulso: tableros en vivo */}
        <div
          className="rounded-[14px] p-1.5 mb-1.5"
          style={{
            background: "rgba(232,121,79,.06)",
            border: "1px solid var(--rail-line-2)",
          }}
        >
          <SecLabel>{liveLabel}</SecLabel>
          <nav className="flex flex-col">
            {summary && (
              <RailLink
                href={summary.href}
                label={summary.label}
                active={summary.href === activeHref}
                board
              />
            )}
            {boards.map((b) => (
              <RailLink
                key={b.href}
                href={b.href}
                label={b.label}
                active={b.href === activeHref}
                board
                boardActivity={boardActivity}
              />
            ))}
          </nav>
        </div>

        {/* Grupos / links */}
        <nav className="flex flex-col">
          {rest.map((it) =>
            "children" in it ? (
              <RailGroup
                key={it.label}
                label={it.label}
                items={it.children}
                activeHref={activeHref}
                locationKey={locationKey}
              />
            ) : (
              <RailLink
                key={it.href}
                href={it.href}
                label={it.label}
                active={it.href === activeHref}
                boardActivity={boardActivity}
              />
            ),
          )}
          {isAdmin && (
            <RailLink href="/admin" label={adminLabel} active={false} />
          )}
        </nav>
      </div>

      {/* Pie fijo: cuenta, idioma y «Cerrar sesión». */}
      {account}
    </div>
  );
}

function SecLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono text-[10px] tracking-[0.18em] uppercase px-2 pt-1.5 pb-1"
      style={{ color: "var(--rail-muted)" }}
    >
      {children}
    </div>
  );
}

function RailLink({
  href,
  label,
  active,
  board,
  boardActivity,
}: {
  href: string;
  label: string;
  active: boolean;
  board?: boolean;
  boardActivity?: BoardActivity;
}) {
  const boardKey = BOARD_BY_HREF[href];
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className="mp-rail-link flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-sm font-medium transition-colors relative"
      style={{
        color: active ? "#231205" : "var(--rail-text)",
        background: active ? "var(--rail-accent)" : "transparent",
      }}
      data-rail-link={board ? "board" : "nav"}
    >
      <Icon name={routeIcon(href)} className="shrink-0 opacity-80" />
      <span className="relative inline-flex items-center">
        {label}
        {boardKey && boardActivity && (
          <BoardDot
            boardKey={boardKey}
            path={href}
            activityMs={boardActivity[boardKey]}
          />
        )}
      </span>
    </Link>
  );
}

/**
 * Grupo plegable del riel (Pedidos, Carta, Administración, Contabilidad,
 * Reportes, Negocio…): arranca abierto si contiene el ítem activo y se
 * reabre al navegar hacia adentro (también al cambiar sólo de pestaña).
 */
function RailGroup({
  label,
  items,
  activeHref,
  locationKey,
}: {
  label: string;
  items: { href: string; label: string }[];
  activeHref: string | null;
  locationKey: string;
}) {
  const containsActive = activeHref != null && items.some((i) => i.href === activeHref);
  const [open, setOpen] = useState(containsActive);
  const id = useId();
  const [lastLocation, setLastLocation] = useState(locationKey);
  if (locationKey !== lastLocation) {
    setLastLocation(locationKey);
    if (containsActive) setOpen(true);
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="mp-rail-link flex items-center gap-3 w-full px-3 py-2.5 rounded-[10px] text-sm font-medium text-left"
        style={{ color: "var(--rail-text)" }}
      >
        <Icon
          name={routeIcon(items[0]?.href ?? "")}
          className="shrink-0 opacity-80"
        />
        {label}
        <svg
          className="ml-auto transition-transform"
          style={{
            color: "var(--rail-muted)",
            transform: open ? "rotate(90deg)" : "none",
          }}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          className="ml-5 pl-2 my-1 flex flex-col gap-1"
          style={{ borderLeft: "1px solid var(--rail-line-2)" }}
        >
          {items.map((i) => {
            const on = i.href === activeHref;
            return (
              <Link
                key={i.href}
                href={i.href}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className="mp-rail-link px-3 py-2.5 rounded-[8px] text-[13px] transition-colors"
                style={{
                  color: on ? "var(--rail-accent)" : "var(--rail-muted)",
                  background: on ? "rgba(232,121,79,.1)" : undefined,
                }}
              >
                {i.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────────────────── Barra de acciones superior ─────────────────────
   Buscar orden + accesos rápidos (cierre de turno · nueva orden). En móvil
   los botones muestran solo el ícono; el label aparece desde `sm`.

   "Nueva orden" ofrece dos cosas: ir a Mesas (tomar el pedido de una
   mesa) o abrir una FACTURA MANUAL directo — una cuenta sin mesa que se
   crea acá mismo y aterriza en Mesas con su ficha desplegada. */
function CockpitTopbar({ navItems }: { navItems: NavEntry[] }) {
  const t = useTranslations("operator");
  const router = useRouter();
  const [q, setQ] = useState("");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [openingManual, setOpeningManual] = useState(false);
  const [manualErr, setManualErr] = useState<string | null>(null);

  async function openManualInvoice() {
    setOpeningManual(true);
    setManualErr(null);
    try {
      const res = await fetch("/api/operator/manual-invoices", {
        method: "POST",
      });
      if (!res.ok) {
        setManualErr(t("newOrderManualFailed"));
        return;
      }
      const j = (await res.json()) as { tableId: string };
      setChooserOpen(false);
      // Carga completa: la ficha abre al cargar con `?open=`.
      window.location.assign(`/operator/facturas-manuales?open=${encodeURIComponent(j.tableId)}`);
    } catch {
      setManualErr(t("newOrderManualFailed"));
    } finally {
      setOpeningManual(false);
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    // La búsqueda de arriba es global: en todas las fechas (código de la
    // cuenta o número de factura), no sólo en el día de hoy.
    router.push(
      term
        ? `/operator/orders?q=${encodeURIComponent(term)}&fechas=todas`
        : "/operator/orders",
    );
  };

  return (
    <div className="shrink-0 print:hidden flex min-h-16 items-center gap-2 lg:gap-3 border-b border-op-border bg-op-surface px-3 md:px-5">
      <NavigationSearch items={navItems} />
      <form
        role="search"
        onSubmit={submit}
        className="relative min-w-0 max-w-sm flex-1"
      >
        <svg
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-op-muted"
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="9" cy="9" r="6" />
          <line x1="14" y1="14" x2="17.5" y2="17.5" />
        </svg>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("searchOrders")}
          aria-label={t("searchOrders")}
          className="h-10 w-full rounded-xl border border-op-border bg-op-bg pl-9 pr-10 text-sm text-op-text placeholder:text-op-muted focus:border-op-text/30 focus:outline-none"
        />
        <button
          type="submit"
          aria-label={t("searchOrders")}
          className="absolute right-1 top-1/2 -translate-y-1/2 mp-icon-button"
        >
          <Icon name="arrow" width="16" height="16" />
        </button>
      </form>
      <Link
        href="/operator/reports"
        prefetch={false}
        aria-label={t("shiftClose")}
        className="mp-shift-close mp-btn mp-btn--secondary mp-btn--sm ml-auto shrink-0"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="10" cy="10" r="7.25" />
          <path d="M10 6v4.3l2.8 1.7" />
        </svg>
        <span className="hidden sm:inline">{t("shiftClose")}</span>
      </Link>
      <button
        type="button"
        onClick={() => {
          setManualErr(null);
          setChooserOpen(true);
        }}
        aria-label={t("newOrder")}
        aria-haspopup="dialog"
        className="mp-btn mp-btn--primary mp-btn--sm shrink-0"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          aria-hidden
        >
          <line x1="10" y1="4.5" x2="10" y2="15.5" />
          <line x1="4.5" y1="10" x2="15.5" y2="10" />
        </svg>
        <span className="hidden sm:inline">{t("newOrder")}</span>
      </button>

      {chooserOpen && (
        <AppDialog
          label={t("newOrder")}
          onClose={() => setChooserOpen(false)}
          className="w-[min(92vw,24rem)] rounded-3xl"
        >
          <div className="p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-display text-2xl">{t("newOrderChoose")}</h2>
              <button
                type="button"
                onClick={() => setChooserOpen(false)}
                className="text-op-muted text-sm shrink-0"
                aria-label={t("newOrderCancel")}
              >
                {"✕"}
              </button>
            </div>
            <div className="mt-4 space-y-2">
              <Link
                href="/operator/tables"
                prefetch={false}
                onClick={() => setChooserOpen(false)}
                className="block w-full rounded-2xl border border-op-border bg-op-surface px-4 py-3 text-left hover:bg-op-bg"
              >
                <div className="text-sm font-medium">{t("newOrderTable")}</div>
                <div className="text-xs text-op-muted mt-0.5">
                  {t("newOrderTableHint")}
                </div>
              </Link>
              <button
                type="button"
                onClick={openManualInvoice}
                disabled={openingManual}
                className="block w-full rounded-2xl border border-terracotta/50 bg-terracotta/5 px-4 py-3 text-left hover:bg-terracotta/10 disabled:opacity-60"
              >
                <div className="text-sm font-medium text-terracotta">
                  {openingManual
                    ? t("newOrderManualOpening")
                    : t("newOrderManual")}
                </div>
                <div className="text-xs text-op-muted mt-0.5">
                  {t("newOrderManualHint")}
                </div>
              </button>
              {manualErr && <div className="text-xs text-danger">{manualErr}</div>}
            </div>
          </div>
        </AppDialog>
      )}
    </div>
  );
}
