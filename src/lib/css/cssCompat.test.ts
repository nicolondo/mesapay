/**
 * Compila el CSS de la app por el mismo camino que `next build` (Tailwind →
 * respaldos → Lightning CSS con el browserslist de package.json) y exige que
 * no quede nada roto para el piso: Firefox 107 (el datáfono Sunmi), Chrome/
 * WebView 99 y Safari iOS 15.4. En CI además se revisa la salida real del build con
 * `scripts/check-css-compat.mjs`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import browserslist from "browserslist";
import { browserslistToTargets, transform } from "lightningcss";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { checkCss } from "./cssCompatCheck.cjs";
import { FLOOR } from "./legacyCss.cjs";
import legacyFallbacks from "./postcssLegacyFallbacks.cjs";

const ROOT = path.resolve(__dirname, "../../..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { browserslist: string[] };

describe("piso de soporte", () => {
  it("package.json declara el mismo piso que el chequeo", () => {
    expect(pkg.browserslist).toContain(`chrome >= ${FLOOR.chrome}`);
    expect(pkg.browserslist).toContain(`ios_saf >= ${FLOOR.safari}`);
    expect(pkg.browserslist).toContain(`safari >= ${FLOOR.safari}`);
    // El datáfono Sunmi: Firefox para Android 107 (GeckoView) como PWA.
    expect(pkg.browserslist).toContain(`firefox >= ${FLOOR.firefox}`);
    expect(pkg.browserslist).toContain(`and_ff >= ${FLOOR.firefox}`);
  });
});

describe("checkCss", () => {
  it("marca lo que el piso no entiende", () => {
    const { errors } = checkCss(`
      .a { & .b { color: red } }
      @media (width >= 40rem) { .c { color: red } }
      .d { background: color-mix(in srgb, var(--x) 10%, transparent) }
      .e { color: var(--op-text) }
      @supports (color: color-mix(in lab, red, red)) { .e { color: color-mix(in oklab, var(--op-text) 10%, transparent) } }
      .f { height: 100dvh }
      .g { translate: 0 -50% }
      .h:has(.i) { color: red }
      @property --tw-sin-respaldo { syntax: "*"; inherits: false; initial-value: 0 }
    `);
    const kinds = errors.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["anidamiento", "media por rango", "color", "viewport", "transform", ":has()", "@property"]),
    );
    expect(errors.find((e) => e.where.startsWith(".e"))?.message).toMatch(/respaldo malo/);
  });

  it("acepta los respaldos bien armados", () => {
    const { errors } = checkCss(`
      @media (min-width: 40rem) { .c { color: red } }
      .e { color: #1a16131a }
      @supports (color: color-mix(in lab, red, red)) { .e { color: color-mix(in oklab, var(--op-text) 10%, transparent) } }
      .f { height: 100vh; height: 100dvh }
      .g { translate: 0 -50% }
      @supports not (translate: 0) { .g { transform: translate(0, -50%) } }
      .k { color: #fb2c36; color: oklch(63.7% .237 25.331) }
      @property --tw-border-style { syntax: "*"; inherits: false; initial-value: solid }
      @layer properties {
        @supports (((-webkit-hyphens: none)) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color: rgb(from red r g b)))) {
          *, ::before, ::after, ::backdrop { --tw-border-style: solid }
        }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("CSS de la app", () => {
  it("compilado como en producción, no deja nada roto para Firefox 107 / Chrome 99 / Safari iOS 15.4", async () => {
    const file = path.join(ROOT, "src/app/globals.css");
    const compiled = await postcss([tailwind({ base: ROOT, optimize: true }), legacyFallbacks]).process(
      readFileSync(file, "utf8"),
      { from: file },
    );
    const { code } = transform({
      filename: "globals.css",
      code: Buffer.from(compiled.css),
      minify: true,
      targets: browserslistToTargets(browserslist(pkg.browserslist)),
    });
    const css = code.toString();
    // Que Tailwind haya escaneado la app de verdad (y el respaldo corregido).
    expect(css).toContain(".bg-op-text\\/30{background-color:#1a16134d}");
    const { errors } = checkCss(css);
    expect(errors.map((e) => `[${e.kind}] ${e.message} :: ${e.where}`)).toEqual([]);
  }, 60_000);
});
