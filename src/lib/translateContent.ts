import "server-only";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { defaultLocale, type Locale } from "@/i18n/config";

/**
 * Traducción de CONTENIDO cargado por el restaurante (nombres/descripciones
 * de platos, categorías, etiquetas). A diferencia de la UI — que sale de
 * catálogos estáticos — este texto es único por comercio y está en español,
 * así que lo traducimos con IA y lo cacheamos en la tabla Translation.
 *
 * Diseño:
 *   - Cache-first: si ya hay traducción vigente (mismo sourceHash) se usa.
 *   - Batch: todo lo faltante se traduce en UNA sola llamada a Anthropic.
 *   - A prueba de fallos: sin ANTHROPIC_API_KEY o ante cualquier error,
 *     devuelve el texto ORIGINAL (la app nunca se rompe por traducir).
 *   - locale === "es" (default) → no-op, devuelve originales.
 *
 * Wiring al menú del diner = fase siguiente; este es el primitivo base.
 */

export type TranslatableItem = {
  entityType: string; // "MenuItem" | "Category" | ...
  entityId: string;
  field: string; // "name" | "description" | "label"
  text: string; // texto original en español
};

const LANG_NAME: Record<Exclude<Locale, "es">, string> = {
  en: "English",
  pt: "Brazilian Portuguese",
};

function key(i: { entityType: string; entityId: string; field: string }): string {
  return `${i.entityType}:${i.entityId}:${i.field}`;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** Mismo hash que usa la cache — para guardar overrides manuales con el
 * sourceHash correcto (así no se re-traducen mientras el original no cambie). */
export function contentSourceHash(text: string): string {
  return hash(text);
}

let _client: Anthropic | null = null;
function client(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Traduce un lote de strings al `locale` pedido. Devuelve un Map
 * keyed por `${entityType}:${entityId}:${field}` con el texto traducido
 * (o el original como fallback).
 */
export async function getContentTranslations(
  locale: Locale,
  items: TranslatableItem[],
  // generateMissing: si falta una traducción, ¿la generamos con IA AHORA
  // (bloqueante) o devolvemos el original? Default FALSE = solo-caché, para
  // que el render del menú (y el cambio de idioma) sea instantáneo. La
  // generación en lote se hace desde el panel ("Traducir carta con IA").
  opts: { generateMissing?: boolean } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Español es el idioma original: no se traduce.
  if (locale === defaultLocale || items.length === 0) {
    for (const it of items) out.set(key(it), it.text);
    return out;
  }

  // 1) Cargar cache vigente.
  const cached = await db.translation.findMany({
    where: {
      locale,
      OR: items.map((it) => ({
        entityType: it.entityType,
        entityId: it.entityId,
        field: it.field,
      })),
    },
  });
  const cacheByKey = new Map(
    cached.map((c) => [`${c.entityType}:${c.entityId}:${c.field}`, c]),
  );

  const missing: TranslatableItem[] = [];
  for (const it of items) {
    const hit = cacheByKey.get(key(it));
    if (hit && hit.sourceHash === hash(it.text)) {
      out.set(key(it), hit.value);
    } else {
      out.set(key(it), it.text); // fallback provisional
      missing.push(it);
    }
  }

  if (missing.length === 0) return out;

  // Solo-caché (default): NO llamamos a la IA en el render. Devolvemos lo
  // cacheado + originales para lo faltante. Evita el freeze al cambiar de
  // idioma. La generación corre en lote desde el panel.
  if (!opts.generateMissing) return out;

  // 2) Traducir lo faltante con IA (sólo cuando generateMissing=true, ej.
  //    el botón "Traducir carta con IA" — y en chunks, no 347 de una).
  const anthropic = client();
  if (!anthropic) return out; // sin API key: quedan los originales

  try {
    const targetLang = LANG_NAME[locale as Exclude<Locale, "es">];
    const prompt =
      `You are translating a restaurant menu from Spanish to ${targetLang}. ` +
      `Translate EVERY "text" naturally and concisely for a menu — INCLUDING ` +
      `section/category names and descriptive phrases (e.g. "Fuertes" → main ` +
      `dishes, "Manos a la Tortilla", "Mexicano al Centro"). ` +
      `Keep a word unchanged ONLY if it is a true proper name (a brand, a ` +
      `person, the restaurant name) or an international dish loanword that is ` +
      `identical in ${targetLang} (e.g. Taco, Quesadilla, Burrito, Molcajete, ` +
      `Malbec, Tartar, WOK). Never leave a descriptive Spanish phrase ` +
      `untranslated. You MUST return one entry for EVERY input index. ` +
      `Do NOT add notes or explanations. ` +
      `Return ONLY a JSON array of {"i": number, "t": string}, no prose.\n\n`;

    // Llama a la IA con un lote y devuelve el array {i,t} parseado (o []).
    async function callAI(
      batch: TranslatableItem[],
    ): Promise<{ i: number; t: string }[]> {
      const payload = batch.map((m, i) => ({ i, text: m.text }));
      const msg = await anthropic!.messages.create({
        // Mismo modelo que el resto de la app (env default Haiku 4.5).
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
        // 8192 para que un lote de descripciones largas no se trunque (antes
        // 4096 cortaba el array y la cola quedaba sin traducir).
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

    const writes = [];
    // El modelo a veces corta el array antes de tiempo y deja ítems sin
    // traducir. Reintentamos SOLO los que faltan (hasta 2 pasadas); lo que
    // igual no vuelva queda en el original (cache-fallback).
    let pending = missing;
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      const translated = await callAI(pending);
      const got = new Set<number>();
      for (const { i, t } of translated) {
        const it = pending[i];
        if (!it || typeof t !== "string" || !t.trim()) continue;
        got.add(i);
        out.set(key(it), t);
        writes.push(
          db.translation.upsert({
            where: {
              entityType_entityId_field_locale: {
                entityType: it.entityType,
                entityId: it.entityId,
                field: it.field,
                locale,
              },
            },
            create: {
              entityType: it.entityType,
              entityId: it.entityId,
              field: it.field,
              locale,
              value: t,
              source: "machine",
              sourceHash: hash(it.text),
            },
            update: { value: t, source: "machine", sourceHash: hash(it.text) },
          }),
        );
      }
      pending = pending.filter((_, idx) => !got.has(idx));
    }
    if (writes.length) await db.$transaction(writes);
  } catch (err) {
    console.error("[translateContent] fallo, uso originales", err);
  }

  return out;
}
