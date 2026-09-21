// Sugerencia de UNA cuenta nueva con IA ("Sugerir con IA" en el formulario
// de Nueva cuenta). Portado de zenith (apps/web/src/lib/puc-ai.ts,
// suggestAccountFromDescription): tool-use forzado para salida estructurada
// y validación SIEMPRE en código (código único, prefijo de la madre, tipo
// de la madre). Nunca inserta nada: el usuario revisa y confirma en el
// formulario, que pasa por createAccount como cualquier alta.
//
// TODO(plan-ia): zenith además tiene "Armar plan con IA" (perfil del
// negocio → visibilidad por actividad + filtro CIIU + subcuentas propias,
// informe zenith-contabilidad.md §3.2 y §3.3). Queda fuera de este PR.
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "@/lib/anthropic";
import { env } from "@/lib/env";
import {
  normalizeCode,
  parentCodeFor,
  validateNewAccount,
  type PlanAccount,
} from "./chart";
import { loadChartOfAccounts } from "./ledger";
import type { PucNature, PucType } from "./pucNiif";

export type AiAccountSuggestion = {
  parentCode: string;
  parentName: string;
  code: string;
  name: string;
  /** Heredados de la madre (la IA no manda acá). */
  type: PucType;
  nature: PucNature;
  /** Una frase de la IA explicando por qué esa ubicación. */
  note: string | null;
};

export type AiSuggestWarning =
  /** La IA propuso otro tipo; se usa el de la madre. */
  | "type_mismatch"
  /** La madre propuesta era una antecesora lejana; se usó la inmediata. */
  | "parent_replaced"
  /** La madre hoy recibe movimientos: al crear la auxiliar se trasladan. */
  | "parent_postable";

export type AiSuggestError = "ai_unavailable" | "ai_invalid" | "empty_chart";

export type AiSuggestResult =
  | { ok: true; suggestion: AiAccountSuggestion; warnings: AiSuggestWarning[] }
  | { ok: false; error: AiSuggestError; detail?: string };

const TOOL_NAME = "sugerir_cuenta";
const TYPES: readonly PucType[] = [
  "activo",
  "pasivo",
  "patrimonio",
  "ingreso",
  "gasto",
  "costo",
];

/** Prompt de zenith (§3.1 del informe), adaptado de "empresa" a comercio. */
export function buildSuggestPrompt(args: {
  description: string;
  plan: readonly PlanAccount[];
  parentCodeHint?: string | null;
  country?: string | null;
}): string {
  const where =
    !args.country || args.country === "CO"
      ? "colombiano"
      : `(país ${args.country})`;
  const list = args.plan
    .map((a) => `${a.code} · ${a.name}${a.postable ? " · imputable" : ""}`)
    .join("\n");
  const hint = args.parentCodeHint
    ? `\n\nEl administrador ya eligió la cuenta madre ${args.parentCodeHint}: la cuenta nueva debe colgar DIRECTAMENTE de ella (parentCode = ${args.parentCodeHint}).`
    : "";
  return `El administrador de un comercio (restaurante) ${where} necesita crear una cuenta contable nueva:

"${args.description}"

Plan de cuentas ACTUAL del comercio (PUC: código · nombre · si es imputable — TODOS estos códigos ya están ocupados):
${list}

Propón UNA cuenta nueva:
- parentCode: el código de la cuenta EXISTENTE bajo la cual debe colgar (normalmente la cuenta de 4 dígitos del concepto, o una subcuenta de 6 si se está detallando una).
- code: un código NUEVO (no puede estar en la lista) que extienda parentCode con exactamente 2 dígitos (p. ej. bajo 5135 → 5135XX libre; bajo 513505 → 513505XX). Sigue la numeración de las hermanas: usa el siguiente múltiplo de 5 libre o el consecutivo natural.
- name: nombre corto, con el estilo de las cuentas vecinas (primera letra en mayúscula, sin siglas raras).
- type: activo, pasivo, patrimonio, ingreso, gasto o costo — coherente con la clase del código.
- note: UNA frase explicando por qué esa ubicación.${hint}`;
}

type ToolInput = {
  parentCode?: unknown;
  code?: unknown;
  name?: unknown;
  type?: unknown;
  note?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "").trim();

/**
 * Valida la propuesta del modelo contra el plan. Es la parte que NO se
 * delega: código con forma válida y libre, madre existente de la que el
 * código sea hijo directo (si la IA nombró una antecesora más lejana pero
 * el código sí extiende esa rama, se corrige a la inmediata con aviso; si
 * el código no empieza por la madre propuesta, se rechaza), tipo y
 * naturaleza heredados de la madre.
 */
export function validateSuggestion(
  input: ToolInput,
  plan: readonly PlanAccount[],
): AiSuggestResult {
  const byCode = new Map(plan.map((a) => [a.code, a]));
  const code = normalizeCode(str(input.code));
  if (!/^\d{4,10}$/.test(code)) {
    return { ok: false, error: "ai_invalid", detail: "bad_code" };
  }
  if (byCode.has(code)) {
    return { ok: false, error: "ai_invalid", detail: "code_taken" };
  }
  const warnings: AiSuggestWarning[] = [];
  const proposedParent = normalizeCode(str(input.parentCode));
  if (!proposedParent || !code.startsWith(proposedParent) || code === proposedParent) {
    return { ok: false, error: "ai_invalid", detail: "bad_prefix" };
  }
  let parentCode = proposedParent;
  const immediate = parentCodeFor(code);
  if (immediate && immediate !== proposedParent && byCode.has(immediate)) {
    parentCode = immediate;
    warnings.push("parent_replaced");
  }
  const v = validateNewAccount({ code, name: str(input.name), parentCode }, byCode);
  if (!v.ok) return { ok: false, error: "ai_invalid", detail: v.error };

  const proposedType = str(input.type) as PucType;
  if (TYPES.includes(proposedType) && proposedType !== v.parent.type) {
    warnings.push("type_mismatch");
  }
  if (v.parent.postable) warnings.push("parent_postable");
  const note = str(input.note);
  return {
    ok: true,
    suggestion: {
      parentCode: v.parent.code,
      parentName: v.parent.name,
      code: v.code,
      name: v.name,
      type: v.parent.type,
      nature: v.parent.nature,
      note: note || null,
    },
    warnings,
  };
}

/**
 * Pide al modelo una cuenta nueva a partir de la descripción del operador
 * y del plan ACTIVO del comercio, y la valida en código. Devuelve la
 * sugerencia para el formulario o un error con código (la UI lo traduce).
 */
export async function suggestAccountWithAi(args: {
  restaurantId: string;
  description: string;
  parentCodeHint?: string | null;
  country?: string | null;
}): Promise<AiSuggestResult> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: "ai_unavailable" };
  const description = args.description.trim();
  const chart = await loadChartOfAccounts(args.restaurantId);
  const plan: PlanAccount[] = chart.map((a) => ({
    code: a.code,
    name: a.name,
    type: a.type as PucType,
    nature: a.nature as PucNature,
    postable: a.postable,
    active: a.active,
  }));
  if (plan.length === 0) return { ok: false, error: "empty_chart" };

  const prompt = buildSuggestPrompt({
    description,
    plan,
    parentCodeHint: args.parentCodeHint,
    country: args.country,
  });

  let input: ToolInput;
  try {
    const response = await getClient().messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
      tools: [
        {
          name: TOOL_NAME,
          description: "Registra la cuenta sugerida.",
          input_schema: {
            type: "object" as const,
            properties: {
              parentCode: { type: "string" as const },
              code: { type: "string" as const },
              name: { type: "string" as const },
              type: { type: "string" as const, enum: [...TYPES] },
              note: { type: "string" as const },
            },
            required: ["parentCode", "code", "name", "type", "note"],
          },
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content: prompt }],
    });
    const toolUse = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) return { ok: false, error: "ai_invalid", detail: "no_tool_use" };
    input = toolUse.input as ToolInput;
  } catch (e) {
    console.error("[chartAi] fallo al sugerir cuenta", e);
    return { ok: false, error: "ai_unavailable" };
  }
  return validateSuggestion(input, plan);
}
