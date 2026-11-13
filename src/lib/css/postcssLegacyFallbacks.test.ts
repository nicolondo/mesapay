import postcss from "postcss";
import { describe, expect, it } from "vitest";
import legacyFallbacks from "./postcssLegacyFallbacks.cjs";

const ROOT = ":root { --op-text: #1A1613; --op-surface: #FFFFFF; --ok: #2E6B4C; }\n";

async function run(css: string) {
  const res = await postcss([legacyFallbacks]).process(ROOT + css, { from: undefined });
  return { css: res.css.replace(/\s+/g, " ").trim(), warnings: res.warnings().map((w) => w.text) };
}

describe("color-mix(): respaldo de Tailwind", () => {
  it("salida anidada (dev): cambia el color sólido por la mezcla con alfa", async () => {
    const { css } = await run(`.bg-op-text\\/30 {
      background-color: var(--op-text);
      @supports (color: color-mix(in lab, red, red)) {
        background-color: color-mix(in oklab, var(--op-text) 30%, transparent);
      }
    }`);
    expect(css).toContain("background-color: #1a16134d; @supports");
    expect(css).toContain("color-mix(in oklab, var(--op-text) 30%, transparent)");
  });

  it("salida aplanada (build): corrige un respaldo estático equivocado", async () => {
    const { css } = await run(
      ".n{background:#2E6B4C}@supports (color:color-mix(in lab, red, red)){.n{background:color-mix(in srgb, var(--ok) 8%, var(--op-surface))}}",
    );
    expect(css).toContain(".n{background:#eef3f1}");
  });

  it("separa una lista de selectores juntada por el minificador", async () => {
    const { css } = await run(
      ".a,.b\\/10{color:var(--op-text)}@supports (color:color-mix(in lab, red, red)){.b\\/10{color:color-mix(in oklab, var(--op-text) 10%, transparent)}}",
    );
    expect(css).toContain(".a{color:var(--op-text)}");
    expect(css).toContain(".b\\/10{color:#1a16131a}");
  });

  it("deja tranquilo un respaldo correcto", async () => {
    const input = ".x{color:#1a16131a}@supports (color:color-mix(in lab, red, red)){.x{color:color-mix(in oklab, var(--op-text) 10%, transparent)}}";
    const { css } = await run(input);
    expect(css).toContain(input);
  });

  it("con currentColor quita el respaldo sólido (mejor sin efecto que un bloque de color)", async () => {
    const { css, warnings } = await run(
      ".c:hover{background:currentColor}@supports (color:color-mix(in lab, red, red)){.c:hover{background:color-mix(in srgb, currentColor 10%, transparent)}}",
    );
    expect(css).not.toContain("background:currentColor");
    expect(warnings).toEqual([]);
  });

  it("usa la definición base de una variable de componente", async () => {
    const { css } = await run(
      ".fp-canvas{--fp-ink:var(--op-text)}.fp-view--diner .fp-canvas{--fp-ink:#000}.fp-grid{stroke:var(--fp-ink)}@supports (color:color-mix(in lab, red, red)){.fp-grid{stroke:color-mix(in srgb, var(--fp-ink) 20%, transparent)}}",
    );
    expect(css).toContain(".fp-grid{stroke:#1a161333}");
  });

  it("avisa cuando una variable no tiene valor en :root", async () => {
    const { warnings } = await run(
      ".v{color:var(--x)}@supports (color:color-mix(in lab, red, red)){.v{color:color-mix(in srgb, var(--x) 10%, transparent)}}",
    );
    expect(warnings.join(" ")).toMatch(/--x no está definida/);
  });
});

describe("color-mix() escrito a mano sin gate", () => {
  it("lo gatea con un respaldo estático y respeta el orden de la regla", async () => {
    const { css } = await run(".b { color: red; border-color: color-mix(in srgb, var(--op-text) 28%, transparent); padding: 1px; }");
    expect(css).toContain(".b { color: red; border-color: #1a161347; }");
    expect(css).toContain(
      "@supports (color: color-mix(in lab, red, red)) { .b { border-color: color-mix(in srgb, var(--op-text) 28%, transparent); } } .b { padding: 1px; }",
    );
    expect(css.indexOf("padding")).toBeGreaterThan(css.indexOf("@supports"));
  });

  it("dentro de @keyframes usa el color estático", async () => {
    const { css } = await run("@keyframes r { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); } }");
    expect(css).toContain("box-shadow: 0 0 0 0 #2e6b4c8c");
  });
});

describe("dvh/svh/lvh", () => {
  it("antepone la misma declaración en vh", async () => {
    const { css } = await run(".s { height: 100dvh; max-height: calc(100svh - 12px); }");
    expect(css).toContain("height: 100vh; height: 100dvh;");
    expect(css).toContain("max-height: calc(100vh - 12px); max-height: calc(100svh - 12px)");
  });

  it("no duplica un respaldo que ya existe", async () => {
    const { css } = await run(".s { height: 100vh; height: 100dvh; }");
    expect(css.match(/100vh/g)).toHaveLength(1);
  });
});

describe("translate/rotate/scale sueltas", () => {
  it("arma el transform equivalente bajo @supports not (translate: 0)", async () => {
    const { css } = await run(".t { translate: var(--tw-translate-x) var(--tw-translate-y); }");
    expect(css).toContain("@supports not (translate: 0) { .t { --mp-fb-translate: translate(var(--tw-translate-x), var(--tw-translate-y));");
    expect(css).toContain("transform: var(--mp-fb-translate, translate(0)) var(--mp-fb-rotate, rotate(0)) var(--mp-fb-scale, scale(1))");
    expect(css).toContain("@property --mp-fb-translate");
  });

  it("también dentro de reglas anidadas (salida de desarrollo)", async () => {
    const { css } = await run(".g { &:hover { @media (hover: hover) { rotate: 180deg; } } }");
    expect(css).toContain("rotate: 180deg; @supports not (translate: 0) { --mp-fb-rotate: rotate(180deg);");
  });
});
