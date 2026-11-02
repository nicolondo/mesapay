import { describe, expect, it } from "vitest";
import { chatInlineText, parseChatInline, parseChatMarkdown } from "./chat";

const text = (value: string) => ({ type: "text" as const, value });

describe("parseChatInline", () => {
  it("negrita, cursiva, negrita cursiva, tachado y código", () => {
    expect(parseChatInline("un **ticket** *alto* ***ya*** ~~no~~ `cod`")).toEqual([
      text("un "),
      { type: "strong", children: [text("ticket")] },
      text(" "),
      { type: "em", children: [text("alto")] },
      text(" "),
      { type: "strong", children: [{ type: "em", children: [text("ya")] }] },
      text(" "),
      { type: "del", children: [text("no")] },
      text(" "),
      { type: "code", value: "cod" },
    ]);
    expect(parseChatInline("__fuerte__ y _suave_")).toEqual([
      { type: "strong", children: [text("fuerte")] },
      text(" y "),
      { type: "em", children: [text("suave")] },
    ]);
  });

  it("negrita con emoji y signos pegados (lo que escribe el modelo)", () => {
    const nodes = parseChatInline("- **+15% ticket promedio** vía combos = +$37M");
    expect(nodes[1]).toEqual({ type: "strong", children: [text("+15% ticket promedio")] });
    expect(chatInlineText(parseChatInline("**🚀 Próximo paso:** ¿Quieres?"))).toBe("🚀 Próximo paso: ¿Quieres?");
  });

  it("lo que no cierra o no es énfasis queda como texto", () => {
    expect(parseChatInline("**sin cierre")).toEqual([text("**sin cierre")]);
    expect(parseChatInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
    expect(parseChatInline("snake_case_largo y a_b")).toEqual([text("snake_case_largo y a_b")]);
    expect(parseChatInline("** no ** negrita")).toEqual([text("** no ** negrita")]);
  });

  it("negrita anidada con cursiva y código adentro", () => {
    expect(parseChatInline("**ventas *netas* de `413505`**")).toEqual([
      {
        type: "strong",
        children: [text("ventas "), { type: "em", children: [text("netas")] }, text(" de "), { type: "code", value: "413505" }],
      },
    ]);
  });

  it("enlaces: internos y https activos; el resto, sólo texto", () => {
    expect(parseChatInline("[Mesas](/operator/tables)")).toEqual([
      { type: "link", href: "/operator/tables", external: false, children: [text("Mesas")] },
    ]);
    expect(parseChatInline("[Kushki](https://kushki.com/x)")).toEqual([
      { type: "link", href: "https://kushki.com/x", external: true, children: [text("Kushki")] },
    ]);
    expect(parseChatInline("[mal](javascript:alert(1))")).toEqual([text("mal")]);
    expect(parseChatInline("[doble](//evil.com)")).toEqual([text("doble")]);
  });

  it("los saltos de línea simples se conservan", () => {
    expect(parseChatInline("a\nb")).toEqual([text("a"), { type: "br" }, text("b")]);
  });
});

describe("parseChatMarkdown", () => {
  it("la respuesta típica de Pulso: título con emoji, viñetas en negrita, separador y cierre", () => {
    const src = [
      "---",
      "",
      "## 💰 **IMPACTO PROYECTADO (30 días)**",
      "",
      "Si ejecutas bien:",
      "- **+15% ticket promedio** vía combos/upselling = +$37M",
      "- **+30 órdenes** lunes–jueves noches = +$7.5M",
      "",
      "**Total potencial: +$60-65M/mes adicionales** (≈25% más que hoy)",
      "",
      "---",
      "",
      "**🚀 Próximo paso:** ¿Quieres que profundice?",
    ].join("\n");
    const blocks = parseChatMarkdown(src);
    expect(blocks.map((b) => b.type)).toEqual(["hr", "heading", "paragraph", "list", "paragraph", "hr", "paragraph"]);
    const heading = blocks[1];
    expect(heading.type === "heading" && heading.level).toBe(2);
    expect(heading.type === "heading" && chatInlineText(heading.children)).toBe("💰 IMPACTO PROYECTADO (30 días)");
    const list = blocks[3];
    expect(list.type === "list" && list.items.length).toBe(2);
    expect(list.type === "list" && list.items[0]!.children[0]).toEqual({
      type: "strong",
      children: [text("+15% ticket promedio")],
    });
    const last = blocks[6];
    expect(last.type === "paragraph" && last.children[0]).toEqual({
      type: "strong",
      children: [text("🚀 Próximo paso:")],
    });
  });

  it("títulos de # a ####### (tope 4), viñetas con * y +, numeradas con . y )", () => {
    const blocks = parseChatMarkdown("# Uno\n#### Cuatro\n###### Seis\n* a\n+ b\n3) c\n4. d");
    expect(blocks.map((b) => (b.type === "heading" ? `h${b.level}` : b.type))).toEqual([
      "h1",
      "h4",
      "h4",
      "list",
      "list",
    ]);
    const bullets = blocks[3];
    expect(bullets.type === "list" && !bullets.ordered && bullets.items.length).toBe(2);
    const numbered = blocks[4];
    expect(numbered.type === "list" && numbered.ordered && numbered.start).toBe(3);
    expect(numbered.type === "list" && numbered.items.length).toBe(2);
  });

  it("listas anidadas por sangría y continuación de un punto", () => {
    const blocks = parseChatMarkdown("- Bebidas\n  - Cerveza\n  - Vino\n- Postres\n  al 4 %");
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    if (list.type !== "list") throw new Error("lista");
    expect(list.items[0]!.sub?.items.map((i) => chatInlineText(i.children))).toEqual(["Cerveza", "Vino"]);
    expect(chatInlineText(list.items[1]!.children)).toBe("Postres al 4 %");
  });

  it("tablas con alineación", () => {
    const blocks = parseChatMarkdown("| Plato | Ventas |\n|:--|--:|\n| Atún | **$12M** |\n| Sopa | $8M |\n\nFin.");
    const table = blocks[0]!;
    if (table.type !== "table") throw new Error("tabla");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.header.map(chatInlineText)).toEqual(["Plato", "Ventas"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]![1]).toEqual([{ type: "strong", children: [text("$12M")] }]);
    expect(blocks[1]!.type).toBe("paragraph");
  });

  it("citas, código y un párrafo con saltos de línea", () => {
    const blocks = parseChatMarkdown("> ojo\n> con esto\n\n```sql\nselect 1\n```\nlínea 1\nlínea 2");
    expect(blocks[0]).toEqual({ type: "quote", children: [text("ojo"), { type: "br" }, text("con esto")] });
    expect(blocks[1]).toEqual({ type: "code", lang: "sql", value: "select 1" });
    expect(blocks[2]).toEqual({ type: "paragraph", children: [text("línea 1"), { type: "br" }, text("línea 2")] });
  });

  it("un bloque de código sin cierre no se traga el resto en silencio", () => {
    const blocks = parseChatMarkdown("```\nabierto");
    expect(blocks).toEqual([{ type: "code", lang: null, value: "abierto" }]);
  });
});
