"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BoardDot, BOARD_BY_HREF, useAnyBoardAlert } from "./BoardDot";
import type { BoardActivity } from "./boardActivity";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon, routeIcon } from "@/components/ui/Icon";
import { NavigationSearch } from "./NavigationSearch";
import type { NavEntry } from "./OperatorMobileMenu";

/**
 * Shell "cockpit" del operador (rediseño detrás del flag mp_shell=cockpit):
 * riel lateral oscuro con el pulso de tableros en vivo arriba + contenido
 * claro. Reusa la data de nav, BoardDot y los nodos server-side (banners,
 * selector de idioma, salir) que el layout le pasa como props.
 *
 * La paleta del riel es oscura SIEMPRE (independiente del tema del contenido),
 * como en el mockup aprobado. Se define local para no ensuciar los tokens.
 */

const RAIL_VARS = {
  ["--rail" as string]: "#151109",
  ["--rail-2" as string]: "#1C1710",
  ["--rail-line" as string]: "#2C2418",
  ["--rail-line-2" as string]: "#3A3020",
  ["--rail-text" as string]: "#F1EADD",
  ["--rail-muted" as string]: "#9C9184",
  // --rail-accent NO va acá: vive en :root (globals.css) para que el aviso
  // de "pidieron la cuenta", que se pinta fuera del riel, use el mismo
  // naranja sin duplicar el hex. El riel lo hereda igual.
} as React.CSSProperties;

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const anyAlert = useAnyBoardAlert(boardActivity, pathname);

  // Cerrar el drawer al navegar (ajuste en render, no en efecto).
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setDrawerOpen(false);
  }

  const rail = (
    <Rail
      navItems={navItems}
      boardActivity={boardActivity}
      roleLabel={roleLabel}
      tenantName={tenantName}
      userEmail={userEmail}
      isAdmin={isAdmin}
      localeSwitcher={localeSwitcher}
      signOut={signOut}
      pathname={pathname}
      adminLabel={t("adminLink")}
      liveLabel={t("liveSection")}
    />
  );

  return (
    <div className="op-app-shell md:grid md:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)] bg-op-bg text-op-text overflow-hidden">
      <a href="#operator-content" className="mp-skip-link">
        {ux("skipContent")}
      </a>
      {/* Riel desktop. print:hidden — el chrome del panel no va al papel
          (páginas como los QRs de mesa se imprimen desde acá). */}
      <aside
        className="hidden md:flex print:hidden sticky top-0 h-[100dvh]"
        style={RAIL_VARS}
      >
        {rail}
      </aside>

      {/* Columna de contenido */}
      <div className="flex min-w-0 flex-col h-[100dvh] overflow-hidden">
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

        {/* Único scroller del contenido */}
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
          style={RAIL_VARS}
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
          {rail}
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
  pathname,
  adminLabel,
  liveLabel,
}: {
  navItems: NavEntry[];
  boardActivity?: BoardActivity;
  roleLabel: string;
  tenantName: string;
  userEmail: string;
  isAdmin: boolean;
  localeSwitcher: React.ReactNode;
  signOut: React.ReactNode;
  pathname: string | null;
  adminLabel: string;
  liveLabel: string;
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

  return (
    <div
      className="mp-rail flex w-full min-h-0 flex-col"
      style={{
        background: "var(--rail)",
        borderRight: "1px solid var(--rail-line)",
        color: "var(--rail-text)",
      }}
    >
      {/* Marca */}
      <div
        className="px-5 pt-6 pb-5"
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

      {/* Scroll de nav */}
      <div className="flex-1 overflow-y-auto px-3 pt-4 pb-3">
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
                active={pathname === summary.href}
                board
              />
            )}
            {boards.map((b) => (
              <RailLink
                key={b.href}
                href={b.href}
                label={b.label}
                active={isActive(pathname, b.href)}
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
                pathname={pathname}
              />
            ) : (
              <RailLink
                key={it.href}
                href={it.href}
                label={it.label}
                active={isActive(pathname, it.href)}
                boardActivity={boardActivity}
              />
            ),
          )}
          {isAdmin && (
            <RailLink href="/admin" label={adminLabel} active={false} />
          )}
        </nav>
      </div>

      {/* Pie: usuario + idioma + salir. El selector de idioma vivía en su
          propia fila y dejaba una franja vacía del ancho del cajón para una
          pastilla de dos palabras; va en la misma fila del usuario. */}
      <div className="mp-rail-footer">
        <div className="flex items-center gap-3 min-w-0">
          <div className="mp-user-avatar">
            {(userEmail[0] || "?").toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{tenantName}</div>
            <div
              className="text-xs truncate"
              style={{ color: "var(--rail-muted)" }}
            >
              {userEmail}
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          {localeSwitcher}
          {signOut}
        </div>
      </div>
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

function RailGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: { href: string; label: string }[];
  pathname: string | null;
}) {
  const containsActive = items.some((i) => isActive(pathname, i.href));
  const [open, setOpen] = useState(containsActive);
  const id = useId();
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
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
            const on = isActive(pathname, i.href);
            return (
              <Link
                key={i.href}
                href={i.href}
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

/** Activo por match exacto o prefijo (excepto "/operator" que es exacto). */
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/operator") return pathname === "/operator";
  return pathname === href || pathname.startsWith(href + "/");
}

/* ───────────────────── Barra de acciones superior ─────────────────────
   Buscar orden + accesos rápidos (cierre de turno · nueva orden). En móvil
   los botones muestran solo el ícono; el label aparece desde `sm`. */
function CockpitTopbar({ navItems }: { navItems: NavEntry[] }) {
  const t = useTranslations("operator");
  const router = useRouter();
  const [q, setQ] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    router.push(
      term
        ? `/operator/orders?q=${encodeURIComponent(term)}`
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
      <Link
        href="/operator/tables"
        aria-label={t("newOrder")}
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
      </Link>
    </div>
  );
}
