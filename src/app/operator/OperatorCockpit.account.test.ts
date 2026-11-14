import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Cerrar sesión» en el riel del operador. El bloque de cuenta (quién soy,
 * idioma y «Cerrar sesión») es el PIE del riel en escritorio y también en el
 * cajón del celular (pedido del dueño: «debe aparecer en la parte de abajo»).
 * Estos casos fijan la ESTRUCTURA; que el pie quede entero a la vista con el
 * cajón abierto lo cubre e2e/operator-signout-mobile.spec.ts:
 *   · en el cajón el bloque de cuenta va DESPUÉS de la lista, como pie;
 *   · nunca queda dentro del área que hace scroll;
 *   · en escritorio sigue siendo el pie del riel;
 *   · el CSS le da al cajón un alto que no pase de lo visible (con respaldo
 *     para navegadores sin `dvh`) y al pie la franja del área segura.
 */

const h = vi.hoisted(() => ({ open: false }));

// Mismo recurso que staffNavigationPrefetch.test.ts: abrir el cajón sin
// navegador (todo `useState(false)` arranca en `true` cuando `h.open`).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(h.open && initial === false ? true : initial),
  };
});
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/operator",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "es" }));
vi.mock("@/components/ui/AppDialog", () => ({
  AppDialog: ({ children, className }: { children: ReactNode; className?: string }) =>
    createElement("dialog", { className }, children),
}));

import { OperatorCockpit } from "./OperatorCockpit";
import type { NavEntry } from "./OperatorMobileMenu";

const navItems: NavEntry[] = [
  { href: "/operator", label: "Resumen" },
  { href: "/operator/kitchen", label: "Cocina" },
  { href: "/operator/tables", label: "Mesas" },
  { label: "Negocio", children: [
    { href: "/operator/reports", label: "Cierre" },
    { href: "/operator/wallet", label: "Wallet" },
  ] },
  { href: "/operator/ayuda", label: "Ayuda" },
];

const SIGN_OUT = 'data-probe="sign-out"';
const LOCALE = 'data-probe="locale"';

function render() {
  // eslint-disable-next-line react/no-children-prop -- Required by the component's props type.
  return renderToStaticMarkup(createElement(OperatorCockpit, {
    navItems, roleLabel: "Operador", tenantName: "Restaurante", userEmail: "duena@example.invalid",
    isAdmin: false, banners: null, children: null,
    localeSwitcher: createElement("span", { "data-probe": "locale" }),
    signOut: createElement("button", { "data-probe": "sign-out" }),
  }));
}

/** HTML completo (con hijos) del primer <div> cuya clase empieza con `classStart`. */
function divByClass(html: string, classStart: string): string {
  const at = html.indexOf(`class="${classStart}`);
  expect(at, `no hay <div class="${classStart}…">`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<div", at);
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`<div class="${classStart}…"> sin cierre`);
}

beforeEach(() => {
  h.open = false;
});

/** Abre el cajón y devuelve su riel, su bloque de cuenta y su lista. */
function drawerParts() {
  h.open = true;
  const html = render();
  const drawer = html.slice(html.indexOf("<dialog"));
  expect(drawer).toContain("mp-navigation-drawer");
  const rail = divByClass(drawer, "mp-rail mp-rail--drawer");
  const account = divByClass(rail, "mp-rail-footer mp-rail-account mp-rail-account--drawer");
  const nav = divByClass(rail, "mp-rail-nav");
  return { rail, account, nav };
}

describe("bloque de cuenta del riel del operador", () => {
  it("en el cajón del celular es el pie: después de la lista y fuera de su scroll", () => {
    const { rail, account, nav } = drawerParts();

    expect(account).toContain(SIGN_OUT);
    expect(account).toContain(LOCALE);
    expect(account).toContain("duena@example.invalid");
    expect(account).toContain("Restaurante");
    expect(account).toContain('role="group"');
    expect(account).toContain('aria-label="accountSection"');
    // Fuera del área que hace scroll…
    expect(nav).not.toContain(SIGN_OUT);
    // …y después de ella: es el pie del cajón.
    expect(rail.indexOf('class="mp-rail-nav')).toBeLessThan(rail.indexOf(SIGN_OUT));
    // Es lo último del riel: nada queda debajo del pie.
    expect(rail.endsWith(`${account}</div>`)).toBe(true);
    // La marca sigue siendo lo primero del cajón.
    expect(rail.indexOf('class="mp-rail-brand')).toBeLessThan(rail.indexOf('class="mp-rail-nav'));
    // Una sola vez por riel: no se duplica arriba.
    expect(rail.split(SIGN_OUT)).toHaveLength(2);
    expect(rail).not.toContain("mp-rail-account--top");
  });

  it("en el pie, quién soy va en una fila y el idioma con «Cerrar sesión» en otra", () => {
    const { account } = drawerParts();
    const identity = divByClass(account, "mp-rail-identity");
    const session = divByClass(account, "mp-rail-session");
    expect(identity).toContain("Restaurante");
    expect(identity).toContain("duena@example.invalid");
    expect(identity).not.toContain(SIGN_OUT);
    expect(session).toContain(LOCALE);
    expect(session).toContain(SIGN_OUT);
    expect(account.indexOf('class="mp-rail-identity')).toBeLessThan(account.indexOf('class="mp-rail-session'));
  });

  it("en escritorio sigue siendo el pie del riel, fuera del scroll de la lista", () => {
    const html = render();
    expect(html).not.toContain("<dialog");
    const rail = divByClass(html, "mp-rail flex");
    const account = divByClass(rail, "mp-rail-footer mp-rail-account");
    const nav = divByClass(rail, "mp-rail-nav");

    expect(account).toContain(SIGN_OUT);
    expect(account).not.toContain("mp-rail-account--drawer");
    expect(nav).not.toContain(SIGN_OUT);
    expect(rail.indexOf('class="mp-rail-nav')).toBeLessThan(rail.indexOf(SIGN_OUT));
    expect(rail.split(SIGN_OUT)).toHaveLength(2);
  });
});

describe("estilos del bloque de cuenta (workspace.css)", () => {
  const css = readFileSync(path.resolve(__dirname, "../workspace.css"), "utf8");
  const rule = (selector: string, from = 0) => {
    const at = css.indexOf(`\n${selector} {`, from);
    expect(at, `falta la regla ${selector}`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  /** Cuerpo del bloque `@media <query> { … }` (con sus reglas). */
  const media = (query: string) => {
    const at = css.indexOf(`@media ${query} {`);
    expect(at, `falta @media ${query}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
    }
    throw new Error(`@media ${query} sin cierre`);
  };

  it("el bloque no se encoge y el botón respeta el objetivo táctil de 44px", () => {
    expect(rule(".mp-rail-account")).toMatch(/flex-shrink:\s*0/);
    expect(rule(".mp-rail-signout")).toMatch(/min-height:\s*44px/);
  });

  it("el cajón no mide más que lo visible: 100dvh, con respaldo previo sin dvh y 100vh sólo en la PWA", () => {
    const drawer = rule(".mp-navigation-drawer");
    // El respaldo va JUSTO ANTES (un navegador sin dvh descarta la segunda
    // declaración y se queda con la primera; y así postcssLegacyFallbacks no
    // antepone el suyo en vh). Nunca 100vh fuera de la PWA: en Chrome mide
    // como si no hubiera barra de direcciones y el pie quedaría debajo.
    expect(drawer).toMatch(/(?<![-\w])height:\s*100%;\s*height:\s*100dvh;/);
    expect(drawer).toMatch(/max-height:\s*100%;\s*max-height:\s*100dvh;/);
    expect(drawer).not.toMatch(/100vh/);
    expect(media("all and (display-mode: standalone)")).toMatch(
      /\.mp-navigation-drawer \{[^}]*height:\s*100vh/,
    );
  });

  it("el pie del cajón reserva el área segura de abajo, también en pantallas bajas", () => {
    const foot = rule(".mp-navigation-drawer .mp-rail-account--drawer");
    expect(foot).toMatch(/padding:[^;]*env\(safe-area-inset-bottom/);
    const low = media("(max-height: 600px)");
    expect(low).toMatch(
      /\.mp-navigation-drawer \.mp-rail-account--drawer \{[^}]*padding-bottom:[^;]*env\(safe-area-inset-bottom/,
    );
    // El riel del cajón no repite esa franja (quedaría un hueco bajo el pie).
    expect(rule(".mp-navigation-drawer .mp-rail--drawer")).toMatch(/padding-bottom:\s*0/);
  });

  it("la lista del cajón ya no deja la cola de 112px: el pie la cierra", () => {
    const nav = rule(".mp-navigation-drawer .mp-rail-nav");
    expect(nav).not.toMatch(/padding-bottom/);
    expect(nav).toMatch(/overscroll-behavior:\s*contain/);
    expect(css).not.toContain("mp-rail-account--top");
  });
});
