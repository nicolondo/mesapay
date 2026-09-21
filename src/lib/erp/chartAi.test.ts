// "Sugerir con IA": la propuesta del modelo se valida SIEMPRE en código —
// una sugerencia válida pasa con la madre y el tipo heredados; una con
// código que no empieza por la madre propuesta se rechaza.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  env: { ANTHROPIC_API_KEY: "test-key" as string | undefined, ANTHROPIC_MODEL: "claude-test" },
}));
vi.mock("@/lib/anthropic", () => ({
  getClient: () => ({ messages: { create: m.create } }),
}));
vi.mock("@/lib/env", () => ({ env: m.env }));
vi.mock("./ledger", () => ({
  loadChartOfAccounts: async () => [
    { code: "1", name: "Activo", type: "activo", nature: "debito", level: 1, parentCode: null, postable: false, active: true },
    { code: "11", name: "Efectivo", type: "activo", nature: "debito", level: 2, parentCode: "1", postable: false, active: true },
    { code: "1110", name: "Bancos", type: "activo", nature: "debito", level: 4, parentCode: "11", postable: false, active: true },
    { code: "111005", name: "Bancos nacionales", type: "activo", nature: "debito", level: 6, parentCode: "1110", postable: true, active: true },
    { code: "2380", name: "Acreedores varios", type: "pasivo", nature: "credito", level: 4, parentCode: "23", postable: false, active: true },
    { code: "238030", name: "Propinas por pagar", type: "pasivo", nature: "credito", level: 6, parentCode: "2380", postable: true, active: true },
  ],
}));

import { suggestAccountWithAi, validateSuggestion } from "./chartAi";

const toolReply = (input: Record<string, unknown>) => ({
  content: [{ type: "tool_use", id: "t1", name: "sugerir_cuenta", input }],
});

beforeEach(() => {
  vi.clearAllMocks();
  m.env.ANTHROPIC_API_KEY = "test-key";
});

describe("suggestAccountWithAi", () => {
  it("una sugerencia válida pasa, con tipo/naturaleza de la madre y aviso de traslado", async () => {
    m.create.mockResolvedValue(
      toolReply({
        parentCode: "111005",
        code: "11100501",
        name: "Bancolombia ahorros",
        type: "activo",
        note: "Detalla la cuenta de bancos por entidad.",
      }),
    );
    const r = await suggestAccountWithAi({
      restaurantId: "r1",
      description: "cuenta de ahorros Bancolombia",
      country: "CO",
    });
    expect(r).toEqual({
      ok: true,
      suggestion: {
        parentCode: "111005",
        parentName: "Bancos nacionales",
        code: "11100501",
        name: "Bancolombia ahorros",
        type: "activo",
        nature: "debito",
        note: "Detalla la cuenta de bancos por entidad.",
      },
      warnings: ["parent_postable"],
    });
    // Tool-use forzado, con el plan del comercio en el prompt.
    const call = m.create.mock.calls[0][0];
    expect(call.model).toBe("claude-test");
    expect(call.tool_choice).toEqual({ type: "tool", name: "sugerir_cuenta" });
    expect(call.messages[0].content).toContain("111005 · Bancos nacionales · imputable");
    expect(call.messages[0].content).toContain('"cuenta de ahorros Bancolombia"');
  });

  it("rechaza un código que no empieza por la madre propuesta", async () => {
    m.create.mockResolvedValue(
      toolReply({
        parentCode: "111005",
        code: "23803001",
        name: "Propinas meseros",
        type: "pasivo",
        note: "x",
      }),
    );
    const r = await suggestAccountWithAi({ restaurantId: "r1", description: "propinas por pagar a meseros" });
    expect(r).toEqual({ ok: false, error: "ai_invalid", detail: "bad_prefix" });
  });

  it("rechaza un código ya ocupado y uno con forma inválida", async () => {
    m.create.mockResolvedValue(
      toolReply({ parentCode: "1110", code: "111005", name: "Dup", type: "activo", note: "x" }),
    );
    expect(await suggestAccountWithAi({ restaurantId: "r1", description: "otra de bancos" })).toEqual({
      ok: false,
      error: "ai_invalid",
      detail: "code_taken",
    });
    m.create.mockResolvedValue(
      toolReply({ parentCode: "1110", code: "1110-5", name: "Rara", type: "activo", note: "x" }),
    );
    expect(await suggestAccountWithAi({ restaurantId: "r1", description: "otra de bancos" })).toEqual({
      ok: false,
      error: "ai_invalid",
      detail: "bad_code",
    });
  });

  it("si la madre propuesta es una antecesora lejana, usa la inmediata y avisa", async () => {
    m.create.mockResolvedValue(
      toolReply({ parentCode: "1110", code: "11100502", name: "Davivienda", type: "pasivo", note: "x" }),
    );
    const r = await suggestAccountWithAi({ restaurantId: "r1", description: "cuenta Davivienda" });
    expect(r).toMatchObject({
      ok: true,
      suggestion: { parentCode: "111005", code: "11100502", type: "activo" },
      warnings: expect.arrayContaining(["parent_replaced", "type_mismatch", "parent_postable"]),
    });
  });

  it("sin API key o con la API caída → ai_unavailable, sin tocar nada", async () => {
    m.env.ANTHROPIC_API_KEY = undefined;
    expect(await suggestAccountWithAi({ restaurantId: "r1", description: "lo que sea" })).toEqual({
      ok: false,
      error: "ai_unavailable",
    });
    expect(m.create).not.toHaveBeenCalled();

    m.env.ANTHROPIC_API_KEY = "test-key";
    m.create.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await suggestAccountWithAi({ restaurantId: "r1", description: "lo que sea" })).toEqual({
      ok: false,
      error: "ai_unavailable",
    });
    err.mockRestore();
  });

  it("la sugerencia respeta la madre elegida cuando se pasa parentCodeHint", async () => {
    m.create.mockResolvedValue(
      toolReply({ parentCode: "238030", code: "23803001", name: "Propinas meseros", type: "pasivo", note: "x" }),
    );
    await suggestAccountWithAi({ restaurantId: "r1", description: "propinas de meseros", parentCodeHint: "238030" });
    expect(m.create.mock.calls[0][0].messages[0].content).toContain("cuenta madre 238030");
  });
});

describe("validateSuggestion (puro)", () => {
  const plan = [
    { code: "5135", name: "Servicios", type: "gasto" as const, nature: "debito" as const, postable: false, active: true },
    { code: "513505", name: "Aseo y vigilancia", type: "gasto" as const, nature: "debito" as const, postable: true, active: true },
  ];
  it("valida nombre y madre inactiva con los mismos errores del alta", () => {
    expect(validateSuggestion({ parentCode: "5135", code: "513510", name: "A", type: "gasto" }, plan)).toEqual({
      ok: false,
      error: "ai_invalid",
      detail: "bad_name",
    });
    const inactivo = [plan[0]!, { ...plan[1]!, active: false }];
    expect(
      validateSuggestion({ parentCode: "513505", code: "51350501", name: "Vigilancia", type: "gasto" }, inactivo),
    ).toEqual({ ok: false, error: "ai_invalid", detail: "bad_parent" });
  });
});
