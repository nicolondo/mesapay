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
  // Categoría del producto (la hoja: p.ej. la cepa "Cabernet Sauvignon").
  categoryLabel: string;
  // Categoría PADRE/grupo si el producto está en una subcategoría (p.ej. el
  // color "Vino Tinto"). Da contexto a la IA: una "Cabernet Sauvignon" bajo
  // "Vino Tinto" es un vino, no un plato.
  parentCategoryLabel?: string | null;
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
    `Sos un copywriter de menús de restaurante. Para CADA ítem te paso su ` +
    `nombre, su categoría y, si aplica, el grupo (categoría principal) al que ` +
    `pertenece. USÁ AMBOS para entender qué es: por ejemplo "Cabernet ` +
    `Sauvignon" dentro del grupo "Vino Tinto" es un VINO (describilo como vino: ` +
    `cuerpo, notas, con qué marida), no como un plato. Escribí una descripción ` +
    `breve, apetitosa y en ESPAÑOL (máximo 180 caracteres, sin punto final ` +
    `obligatorio). Reglas: no inventes datos que no estén implícitos en el ` +
    `nombre/categoría/grupo; no repitas el nombre tal cual; nada de emojis ni ` +
    `comillas. Devolvé SOLO un arreglo JSON de {"i": number, "t": string}, ` +
    `con UNA entrada por CADA índice de entrada.\n\n`;

  async function callAI(
    batch: DescribeInput[],
  ): Promise<{ i: number; t: string }[]> {
    const payload = batch.map((m, i) => ({
      i,
      name: m.name,
      category: m.categoryLabel,
      // Solo cuando el ítem está en una subcategoría (tiene grupo padre).
      ...(m.parentCategoryLabel ? { group: m.parentCategoryLabel } : {}),
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
