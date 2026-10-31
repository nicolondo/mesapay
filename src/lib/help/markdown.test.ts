import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  helpHeadings,
  helpLinks,
  helpPlainText,
  isInternalHref,
  parseHelpMarkdown,
  parseInline,
  slugifyHeading,
  validateHelpMarkdown,
} from "./markdown";
import { HelpMarkdown } from "@/components/help/HelpMarkdown";

const labels = { tip: "Consejo", warning: "Atención", copy: "Copiar", copied: "Copiado" };
const render = (source: string, allowHref?: (h: string) => boolean) =>
  renderToStaticMarkup(createElement(HelpMarkdown, { source, labels, allowHref }));

describe("parseInline", () => {
  it("negrita, código y enlace interno", () => {
    expect(parseInline("Toca **Guardar** y escribe `RESTAURAR` en [Copias](/operator/settings/backups).")).toEqual([
      { type: "text", value: "Toca " },
      { type: "strong", children: [{ type: "text", value: "Guardar" }] },
      { type: "text", value: " y escribe " },
      { type: "code", value: "RESTAURAR" },
      { type: "text", value: " en " },
      {
        type: "link",
        href: "/operator/settings/backups",
        children: [{ type: "text", value: "Copias" }],
      },
      { type: "text", value: "." },
    ]);
  });

  it("el código no se interpreta por dentro", () => {
    expect(parseInline("`C:\\Program Files\\**x**`")).toEqual([
      { type: "code", value: "C:\\Program Files\\**x**" },
    ]);
  });

  it("lo que no cierra queda como texto", () => {
    expect(parseInline("2 ** 3 y `abierto")).toEqual([{ type: "text", value: "2 ** 3 y `abierto" }]);
  });

  it("los enlaces externos pierden el enlace pero conservan el texto", () => {
    for (const href of [
      "https://evil.example",
      "//evil.example",
      "javascript:void0",
      "mailto:x@y.z",
      "/ruta con espacio",
    ]) {
      expect(parseInline(`[clic](${href})`)).toEqual([{ type: "text", value: "clic" }]);
    }
  });
});

describe("isInternalHref", () => {
  it("acepta rutas internas con ancla o consulta", () => {
    expect(isInternalHref("/operator/ayuda")).toBe(true);
    expect(isInternalHref("/operator/contabilidad?tab=chart")).toBe(true);
    expect(isInternalHref("/operator/ayuda#impresoras")).toBe(true);
  });
  it("rechaza todo lo demás", () => {
    for (const h of ["", "operator", "//x.com", "https://x.com", "/\\x", "/a b", '/a"b']) {
      expect(isInternalHref(h)).toBe(false);
    }
  });
});

describe("parseHelpMarkdown", () => {
  const src = [
    "Sirve para imprimir comandas.",
    "Segunda línea del mismo párrafo.",
    "",
    "## Antes de empezar",
    "- Un computador con Windows",
    "- La impresora en la misma red",
    "",
    "### Pasos",
    "1. Descarga el programa.",
    "2. Instálalo:",
    "  con el Símbolo del sistema.",
    "",
    "```bat",
    'cd "C:\\Program Files\\MESAPAY"',
    "mesapay-print-agent.exe install",
    "```",
    "",
    "> Guarda el token.",
    "> Se muestra una sola vez.",
    "",
    "> ⚠ No muevas el archivo.",
    "",
    "## Antes de empezar",
  ].join("\n");
  const blocks = parseHelpMarkdown(src);

  it("arma los bloques en orden", () => {
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "heading",
      "list",
      "heading",
      "list",
      "code",
      "callout",
      "callout",
      "heading",
    ]);
  });

  it("une las líneas de un párrafo y las continuaciones de un paso", () => {
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "Sirve para imprimir comandas. Segunda línea del mismo párrafo." }],
    });
    const steps = blocks[4];
    expect(steps.type === "list" && steps.ordered && steps.items[1]).toEqual([
      { type: "text", value: "Instálalo: con el Símbolo del sistema." },
    ]);
  });

  it("el bloque de código queda literal y con su lenguaje", () => {
    expect(blocks[5]).toEqual({
      type: "code",
      lang: "bat",
      value: 'cd "C:\\Program Files\\MESAPAY"\nmesapay-print-agent.exe install',
    });
  });

  it("avisos de consejo y de advertencia", () => {
    expect(blocks[6]).toMatchObject({ type: "callout", tone: "tip" });
    expect(blocks[7]).toEqual({
      type: "callout",
      tone: "warning",
      children: [{ type: "text", value: "No muevas el archivo." }],
    });
  });

  it("ids de subtítulos sin tildes y sin repetirse", () => {
    expect(helpHeadings(blocks)).toEqual([
      { id: "antes-de-empezar", text: "Antes de empezar", level: 2 },
      { id: "pasos", text: "Pasos", level: 3 },
      { id: "antes-de-empezar-2", text: "Antes de empezar", level: 2 },
    ]);
    expect(slugifyHeading("¿Qué pasa si no imprime?")).toBe("que-pasa-si-no-imprime");
  });

  it("texto plano para el buscador, sin subtítulos", () => {
    const plain = helpPlainText(blocks);
    expect(plain).toContain("Sirve para imprimir comandas.");
    expect(plain).toContain("mesapay-print-agent.exe install");
    expect(plain).not.toContain("Antes de empezar");
  });

  it("lista los enlaces internos", () => {
    expect(
      helpLinks(parseHelpMarkdown("Ve a [Usuarios](/operator/settings/usuarios) o [afuera](https://x.y).\n\n- **[Mesas](/operator/tables)**")),
    ).toEqual(["/operator/settings/usuarios", "/operator/tables"]);
  });
});

describe("validateHelpMarkdown", () => {
  it("un artículo bien escrito no tiene problemas", () => {
    expect(validateHelpMarkdown("Para qué sirve.\n\n## Pasos\n1. Uno\n2. Dos")).toEqual([]);
  });
  it("marca lo que no es del formato", () => {
    const problems = validateHelpMarkdown(
      [
        "# Título",
        "* viñeta",
        "#### chico",
        "<b>html</b>",
        "**sin cerrar",
        "[afuera](https://x.y)",
        "```",
        "sin cerrar",
      ].join("\n"),
    );
    expect(problems.join("\n")).toMatch(/nivel 1/);
    expect(problems.join("\n")).toMatch(/viñetas/);
    expect(problems.join("\n")).toMatch(/nivel 4/);
    expect(problems.join("\n")).toMatch(/HTML/);
    expect(problems.join("\n")).toMatch(/negrita/);
    expect(problems.join("\n")).toMatch(/no interno/);
    expect(problems.join("\n")).toMatch(/sin cerrar \(```\)/);
    expect(problems.join("\n")).toMatch(/arrancar con un párrafo/);
  });
  it("un cuerpo vacío es un problema", () => {
    expect(validateHelpMarkdown("  \n ")).toEqual(["el cuerpo está vacío"]);
  });
});

describe("HelpMarkdown (renderizado)", () => {
  it("nunca inyecta HTML: las etiquetas salen escapadas", () => {
    const html = render(
      [
        "Hola <script>alert(1)</script> y <img src=x onerror=alert(1)>",
        "",
        "## <i>título</i>",
        "",
        "- **<b>negrita</b>**",
        "",
        "```",
        "</code></pre><script>alert(2)</script>",
        "```",
        "",
        "> <iframe src=x></iframe>",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<script|<img|<iframe|<i>|<b>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("los enlaces peligrosos o externos no se pintan como enlace", () => {
    const html = render(
      "[a](javascript:alert(1)) [b](https://evil.example) [c](//evil.example) [d](/operator/ayuda)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toContain('href="/operator/ayuda"');
  });

  it("allowHref deja como texto los enlaces que no corresponden", () => {
    const html = render("[panel](/operator/tables) y [app](/mesero/salon)", (h) =>
      h.startsWith("/mesero"),
    );
    expect(html).not.toContain('href="/operator/tables"');
    expect(html).toContain("panel");
    expect(html).toContain('href="/mesero/salon"');
  });

  it("pinta subtítulos con ancla, pasos numerados, código y avisos", () => {
    const html = render(
      "Intro.\n\n## Cómo se hace\n\n3. Tres\n4. Cuatro\n\n```\nsc.exe query X\n```\n\n> ⚠ Ojo",
    );
    expect(html).toContain('<h2 id="como-se-hace"');
    expect(html).toContain('<ol start="3"');
    expect(html).toContain("<code>sc.exe query X</code>");
    expect(html).toContain('role="note" aria-label="Atención"');
    expect(html).toContain(">Copiar<");
  });
});
