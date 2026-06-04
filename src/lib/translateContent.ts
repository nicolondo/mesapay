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

  // 2) Traducir lo faltante con IA (una sola llamada).
  const anthropic = client();
  if (!anthropic) return out; // sin API key: quedan los originales

  try {
    const targetLang = LANG_NAME[locale as Exclude<Locale, "es">];
    const payload = missing.map((m, i) => ({ i, text: m.text }));
    const msg = await anthropic.messages.create({
      // Mismo modelo que el resto de la app (env default Haiku 4.5). El alias
      // viejo "claude-3-5-haiku-latest" quedó retirado → las traducciones
      // fallaban en silencio y caían al español (0 filas en Translation).
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content:
            `You translate restaurant menu content from Spanish to ${targetLang}. ` +
            `Translate the "text" of each item naturally and concisely for a menu. ` +
            `Keep brand/proper names as-is. Do NOT add notes. ` +
            `Return ONLY a JSON array of {"i": number, "t": string}, no prose.\n\n` +
            JSON.stringify(payload),
        },
      ],
    });
    const raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
    const translated: { i: number; t: string }[] = JSON.parse(json);

    const writes = [];
    for (const { i, t } of translated) {
      const it = missing[i];
      if (!it || typeof t !== "string" || !t.trim()) continue;
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
    if (writes.length) await db.$transaction(writes);
  } catch (err) {
    console.error("[translateContent] fallo, uso originales", err);
  }

  return out;
}
