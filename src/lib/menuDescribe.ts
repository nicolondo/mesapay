import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "@/lib/anthropic";
import { env } from "@/lib/env";

/**
 * Generación de descripciones de platos con IA (acción masiva del editor de
 * carta). El contenido del restaurante es en ESPAÑOL (fuente de la verdad);
 * las traducciones a en/pt se generan aparte vía translateContent. Por eso acá
 * generamos siempre en español.
 *
 * Diseño calcado de translateContent: lotes de 25, reintento de los índices
 * que el modelo deja caer (hasta 2 pasadas), y si todo falla queda vacío (el
 * llamador simplemente no propone descripción para ese plato).
 */

export type DescribeInput = {
  id: string;
  name: string;
  categoryLabel: string;
};

const CHUNK = 25;
const MAX_DESC = 180;

export async function generateMenuDescriptions(
  items: DescribeInput[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (items.length === 0) return out;
  const c = getClient();

  const prompt =
    `Sos un copywriter de menús de restaurante. Para CADA plato te paso su ` +
    `nombre y su categoría. Escribí una descripción breve, apetitosa y en ` +
    `ESPAÑOL (máximo 180 caracteres, sin punto final obligatorio). Reglas: ` +
    `no inventes ingredientes ni preparaciones que no estén implícitos en el ` +
    `nombre; no repitas el nombre tal cual; nada de emojis ni comillas. ` +
    `Devolvé SOLO un arreglo JSON de {"i": number, "t": string}, con UNA ` +
    `entrada por CADA índice de entrada.\n\n`;

  async function callAI(
    batch: DescribeInput[],
  ): Promise<{ i: number; t: string }[]> {
    const payload = batch.map((m, i) => ({
      i,
      name: m.name,
      category: m.categoryLabel,
    }));
    const msg = await c.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt + JSON.stringify(payload) }],
    });
    const raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
      const arr = JSON.parse(json);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  for (let start = 0; start < items.length; start += CHUNK) {
    let pending = items.slice(start, start + CHUNK);
    // El modelo a veces corta el array; reintentamos SOLO lo que falta.
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      const got = new Set<number>();
      const res = await callAI(pending);
      for (const { i, t } of res) {
        const it = pending[i];
        if (!it || typeof t !== "string" || !t.trim()) continue;
        got.add(i);
        out.set(it.id, t.trim().slice(0, MAX_DESC));
      }
      pending = pending.filter((_, idx) => !got.has(idx));
    }
  }

  return out;
}
