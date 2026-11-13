import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Cerrar sesión» en el riel del operador. El dueño reportó que en el celular
 * no encontraba la opción: vivía al pie del cajón, pegada al borde inferior,
 * que es la franja que el navegador puede tapar (barra de Safari, indicador
 * de inicio). Estos casos fijan la ESTRUCTURA que lo evita (el viewport real
 * lo cubre e2e/operator-signout-mobile.spec.ts):
 *   · en el cajón del celular el bloque de cuenta va ANTES de la lista;
 *   · nunca queda dentro del área que hace scroll;
 *   · en escritorio sigue siendo el pie del riel.
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

describe("bloque de cuenta del riel del operador", () => {
  it("en el cajón del celular va arriba, antes de la lista y fuera de su scroll", () => {
    h.open = true;
    const html = render();
    const drawer = html.slice(html.indexOf("<dialog"));
    expect(drawer).toContain("mp-navigation-drawer");
    const rail = divByClass(drawer, "mp-rail mp-rail--drawer");
    const account = divByClass(rail, "mp-rail-footer mp-rail-account mp-rail-account--top");
    const nav = divByClass(rail, "mp-rail-nav");

    expect(account).toContain(SIGN_OUT);
    expect(account).toContain(LOCALE);
    expect(account).toContain("duena@example.invalid");
    expect(account).toContain('role="group"');
    expect(account).toContain('aria-label="accountSection"');
    // Fuera del área que hace scroll…
    expect(nav).not.toContain(SIGN_OUT);
    // …y antes que ella: se ve apenas se abre el menú, sin desplazarse.
    expect(rail.indexOf(SIGN_OUT)).toBeLessThan(rail.indexOf('class="mp-rail-nav'));
    // La marca sigue siendo lo primero del cajón.
    expect(rail.indexOf('class="mp-rail-brand')).toBeLessThan(rail.indexOf(SIGN_OUT));
    // Una sola vez por riel: no se duplica al pie.
    expect(rail.split(SIGN_OUT)).toHaveLength(2);
  });

  it("en escritorio sigue siendo el pie del riel, fuera del scroll de la lista", () => {
    const html = render();
    expect(html).not.toContain("<dialog");
    const rail = divByClass(html, "mp-rail flex");
    const account = divByClass(rail, "mp-rail-footer mp-rail-account");
    const nav = divByClass(rail, "mp-rail-nav");

    expect(account).toContain(SIGN_OUT);
    expect(account).not.toContain("mp-rail-account--top");
    expect(nav).not.toContain(SIGN_OUT);
    expect(rail.indexOf('class="mp-rail-nav')).toBeLessThan(rail.indexOf(SIGN_OUT));
    expect(rail.split(SIGN_OUT)).toHaveLength(2);
  });
});

describe("estilos del bloque de cuenta (workspace.css)", () => {
  const css = readFileSync(path.resolve(__dirname, "../workspace.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `falta la regla ${selector}`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("el bloque no se encoge y el botón respeta el objetivo táctil de 44px", () => {
    expect(rule(".mp-rail-account")).toMatch(/flex-shrink:\s*0/);
    expect(rule(".mp-rail-signout")).toMatch(/min-height:\s*44px/);
  });

  it("la lista del cajón deja una cola para subir los últimos ítems sobre la barra del navegador", () => {
    const tail = /padding-bottom:\s*(\d+)px/.exec(rule(".mp-navigation-drawer .mp-rail-nav"));
    expect(tail).not.toBeNull();
    expect(Number(tail![1])).toBeGreaterThanOrEqual(96);
  });
});
