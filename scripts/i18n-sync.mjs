#!/usr/bin/env node
/**
 * Sincroniza los catálogos de traducción de la UI con IA.
 *
 * `messages/es.json` es la FUENTE DE VERDAD. Este script encuentra las
 * claves que faltan (o están vacías) en en.json / pt.json, las traduce
 * con Anthropic preservando los placeholders ICU ({name}, {count}, …) y
 * reescribe cada archivo respetando la estructura/orden del español.
 *
 * Las claves recién traducidas por máquina quedan listadas en
 * `messages/.machine.json` para que un humano las revise. Si editás una
 * traducción a mano, borrá su entrada de ese manifiesto.
 *
 * Uso:   ANTHROPIC_API_KEY=... node scripts/i18n-sync.mjs
 *        npm run i18n:sync
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MESSAGES_DIR = path.join(process.cwd(), "messages");
const SOURCE = "es";
const TARGETS = ["en", "pt"];
const LANG_NAME = { en: "English", pt: "Brazilian Portuguese" };
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest";

const readJson = (p) =>
  fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function setDeep(obj, dotKey, value) {
  const parts = dotKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null)
      cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

async function translateBatch(anthropic, targetLang, entries) {
  const payload = entries.map((e, i) => ({ i, text: e.text }));
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content:
          `You localize a restaurant SaaS UI from Spanish to ${targetLang}. ` +
          `Translate each "text" naturally and concisely (UI microcopy). ` +
          `CRITICAL: preserve ICU placeholders EXACTLY as written, e.g. {name}, {count}, ` +
          `and any markup tags. Do not translate text inside curly braces. ` +
          `Return ONLY a JSON array of {"i": number, "t": string}. No prose.\n\n` +
          JSON.stringify(payload),
      },
    ],
  });
  const raw = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  return JSON.parse(json);
}

async function main() {
  const es = readJson(path.join(MESSAGES_DIR, `${SOURCE}.json`));
  const esFlat = flatten(es);
  const esKeys = Object.keys(esFlat);
  const machineManifest = readJson(path.join(MESSAGES_DIR, ".machine.json"));

  let anthropic = null;

  for (const locale of TARGETS) {
    const targetPath = path.join(MESSAGES_DIR, `${locale}.json`);
    const existingFlat = flatten(readJson(targetPath));
    const missing = esKeys.filter(
      (k) => !(k in existingFlat) || existingFlat[k] === "",
    );

    if (missing.length === 0) {
      console.log(`✓ ${locale}: al día (${esKeys.length} claves)`);
      continue;
    }
    console.log(`… ${locale}: traduciendo ${missing.length} clave(s) nuevas`);

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "✗ Falta ANTHROPIC_API_KEY. Exportala y volvé a correr el script.",
      );
      process.exit(1);
    }
    anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const entries = missing.map((k) => ({ key: k, text: esFlat[k] }));
    const translated = await translateBatch(
      anthropic,
      LANG_NAME[locale],
      entries,
    );
    const byKey = {};
    for (const { i, t } of translated) {
      if (entries[i] && typeof t === "string" && t.trim())
        byKey[entries[i].key] = t;
    }

    // Reconstruir respetando estructura/orden del español.
    const result = {};
    const machineKeys = new Set(machineManifest[locale] ?? []);
    for (const k of esKeys) {
      const keep = k in existingFlat && existingFlat[k] !== "";
      const value = keep ? existingFlat[k] : (byKey[k] ?? esFlat[k]);
      if (!keep && byKey[k]) machineKeys.add(k);
      setDeep(result, k, value);
    }

    fs.writeFileSync(targetPath, JSON.stringify(result, null, 2) + "\n");
    machineManifest[locale] = [...machineKeys].sort();
    console.log(`  → ${locale}.json actualizado (${missing.length} nuevas)`);
  }

  fs.writeFileSync(
    path.join(MESSAGES_DIR, ".machine.json"),
    JSON.stringify(machineManifest, null, 2) + "\n",
  );
  console.log(
    "\nListo. Revisá messages/.machine.json: son traducciones por máquina pendientes de revisión humana.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
