#!/usr/bin/env node
/**
 * Migración Kommo → CRM MESAPAY
 * ================================
 * Lee leads del pipeline de Kommo (infomesapayco.kommo.com) y los inserta
 * directamente en la DB de MESAPAY con @prisma/client.
 *
 * CONFIGURACIÓN:
 *   - Crea el archivo ~/.config/kommo/.env con:
 *       KOMMO_SUBDOMAIN=infomesapayco
 *       KOMMO_TOKEN=<long-lived-token-o-refresh>
 *       DATABASE_URL=<postgres-url-de-mesapay>
 *   - Exporta las vars o pásalas como env:
 *       KOMMO_SUBDOMAIN=infomesapayco KOMMO_TOKEN=xxx DATABASE_URL=... \
 *         node scripts/crm_migrate_kommo.mjs
 *
 * USO:
 *   node scripts/crm_migrate_kommo.mjs [--dry-run] [--assign-to=email]
 *
 *   --dry-run        Imprime conteos sin insertar nada.
 *   --assign-to=x    Email del usuario MESAPAY al que asignar leads sin
 *                    "Comercial asignado" en Kommo. Default: primer platform_admin.
 *
 * IDEMPOTENCIA:
 *   Salta leads cuyo nombre normalizado (normalizeLeadName) ya existe en CRM.
 *
 * ⚠️  NO ejecutar contra DB de producción sin hacer backup primero.
 *     Este script es destructivo en el sentido de que inserta datos reales.
 *
 * MAPEO DE STAGES (Kommo status_id → CrmStage):
 *   107329767  Lead nuevo        → nuevo
 *   107138579  Calificado        → contactado
 *   107329447  Demo agendada     → demo_agendada
 *   107329519  Demo realizada    → demo_realizada
 *   107138583  Propuesta enviada → propuesta_enviada
 *   107138587  En negociación    → negociacion
 *   107138591  Acuerdo verbal    → negociacion
 *   142        Logrado           → ganado
 *   143        Venta Perdido     → perdido
 *   (other)                      → nuevo
 *
 * CAMPOS CUSTOM KOMMO:
 *   502120 → countryCode (País: CO / MX)
 *   528746 → cityName    (Ciudad — field_id encontrado en dump)
 *   502122 → planProposed
 *   tags prioridad-a / prioridad-b / prioridad-c → priority
 *   502132 → assignedUserEmail (Comercial asignado — texto libre)
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const require = createRequire(import.meta.url);

// ── Load env from ~/.config/kommo/.env if exists ─────────────────────────────
const envFile = join(homedir(), ".config", "kommo", ".env");
if (existsSync(envFile)) {
  const lines = readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN ?? "infomesapayco";
const TOKEN = process.env.KOMMO_TOKEN ?? "";
const BASE_URL = `https://${SUBDOMAIN}.kommo.com/api/v4`;

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const assignToArg = args.find((a) => a.startsWith("--assign-to="))?.split("=")[1] ?? null;

if (!TOKEN) {
  console.error("ERROR: KOMMO_TOKEN no está configurado.");
  process.exit(1);
}

// ── Prisma client (runtime require) ──────────────────────────────────────────
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

// ── Stage map ─────────────────────────────────────────────────────────────────
/** @type {Record<number, string>} */
const STAGE_MAP = {
  107329767: "nuevo",
  107138579: "contactado",
  107329447: "demo_agendada",
  107329519: "demo_realizada",
  107138583: "propuesta_enviada",
  107138587: "negociacion",
  107138591: "negociacion",
  142: "ganado",
  143: "perdido",
};

// ── Kommo custom field IDs ────────────────────────────────────────────────────
const CF_PAIS = 502120;
const CF_PLAN = 502122;
const CF_CIUDAD = 528746;
const CF_COMERCIAL = 502132;
// enum value IDs for País (PAIS_CO is the default — explicit for clarity)
// const PAIS_CO = 377612;
const PAIS_MX = 377614;

// ── Name normalization (mirrors src/lib/crm/dupes.ts) ────────────────────────
/**
 * @param {string} s
 * @returns {string}
 */
function normalizeLeadName(s) {
  const GENERIC = new Set([
    "restaurante", "restaurant", "sas", "sa", "ltda", "limitada",
    "y", "de", "del", "la", "el", "los", "las",
  ]);
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !GENERIC.has(w))
    .join(" ")
    .trim();
}

// ── Kommo fetch helper ────────────────────────────────────────────────────────
/**
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function kommoGet(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kommo ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Paginate through /api/v4/leads and return all leads from the Ventas pipeline.
 * @returns {Promise<unknown[]>}
 */
async function fetchAllLeads() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await kommoGet(
      `/leads?with=contacts,tags&page=${page}&limit=250&filter[pipeline_id]=13884563`,
    ).catch((e) => {
      if (e.message.includes("204")) return null; // no content = done
      throw e;
    });
    if (!data) break;
    const items = data?._embedded?.leads ?? [];
    if (!items.length) break;
    all.push(...items);
    const next = data?._links?.next;
    if (!next) break;
    page++;
  }
  return all;
}

/**
 * Fetch notes for a lead.
 * @param {number} leadId
 * @returns {Promise<unknown[]>}
 */
async function fetchNotes(leadId) {
  const data = await kommoGet(
    `/leads/${leadId}/notes?filter[note_type]=common&limit=50`,
  ).catch(() => null);
  return data?._embedded?.notes ?? [];
}

// ── Extract custom field value ────────────────────────────────────────────────
/**
 * @param {unknown[]} cfValues
 * @param {number} fieldId
 * @returns {unknown}
 */
function getCF(cfValues, fieldId) {
  if (!Array.isArray(cfValues)) return null;
  const field = cfValues.find((f) => f.field_id === fieldId);
  if (!field) return null;
  const v = field.values?.[0];
  return v?.value ?? null;
}

/**
 * @param {unknown[]} cfValues
 * @param {number} fieldId
 * @returns {number | null}
 */
function getCFEnumId(cfValues, fieldId) {
  if (!Array.isArray(cfValues)) return null;
  const field = cfValues.find((f) => f.field_id === fieldId);
  if (!field) return null;
  return field.values?.[0]?.enum_id ?? null;
}

// ── Phone normalization (simplified E.164) ────────────────────────────────────
/**
 * @param {string | null | undefined} raw
 * @param {string} countryCode
 * @returns {string | null}
 */
function normalizePhone(raw, countryCode) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (raw.trimStart().startsWith("+")) return `+${digits}`;
  const prefix = countryCode === "MX" ? "52" : "57";
  return `+${prefix}${digits}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== CRM MESAPAY ← Kommo Migration ===`);
  console.log(`Subdomain: ${SUBDOMAIN}`);
  console.log(`Dry run: ${DRY_RUN}`);

  // 1. Find default assignee.
  let defaultUserId = null;
  if (!DRY_RUN) {
    if (assignToArg) {
      const u = await db.user.findUnique({
        where: { email: assignToArg },
        select: { id: true, role: true },
      });
      if (!u) {
        console.error(`ERROR: usuario "${assignToArg}" no encontrado.`);
        process.exit(1);
      }
      defaultUserId = u.id;
      console.log(`Asignando a: ${assignToArg} (${u.id})`);
    } else {
      const admin = await db.user.findFirst({
        where: { role: "platform_admin" },
        select: { id: true, email: true },
        orderBy: { createdAt: "asc" },
      });
      if (!admin) {
        console.error("ERROR: no hay platform_admin en la DB.");
        process.exit(1);
      }
      defaultUserId = admin.id;
      console.log(`Asignando a: ${admin.email} (default admin)`);
    }
  }

  // 2. Pre-load existing normalized lead names to skip duplicates.
  const existingRaw = await db.crmLead.findMany({ select: { name: true } });
  const existingNames = new Set(existingRaw.map((r) => normalizeLeadName(r.name)));
  console.log(`\nLeads ya en CRM: ${existingNames.size}`);

  // 3. Pre-load cities for city matching.
  const cities = await db.crmCity.findMany({ select: { id: true, name: true } });
  /**
   * @param {string | null} name
   * @returns {string | null}
   */
  function matchCity(name) {
    if (!name) return null;
    const norm = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const found = cities.find(
      (c) => c.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") === norm,
    );
    return found?.id ?? null;
  }

  // 4. Fetch Kommo leads.
  console.log("\nCargando leads de Kommo...");
  const kommoLeads = await fetchAllLeads();
  console.log(`Total leads en Kommo: ${kommoLeads.length}`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const kl of kommoLeads) {
    const name = (kl.name ?? "").trim();
    if (!name) { skipped++; continue; }

    const normName = normalizeLeadName(name);
    if (existingNames.has(normName)) {
      skipped++;
      continue;
    }

    const cfValues = kl.custom_fields_values ?? [];

    // Country
    const paisEnumId = getCFEnumId(cfValues, CF_PAIS);
    const countryCode = paisEnumId === PAIS_MX ? "MX" : "CO"; // default CO

    // City
    const cityName = getCF(cfValues, CF_CIUDAD);
    const cityId = matchCity(typeof cityName === "string" ? cityName : null);

    // Plan proposed
    const planRaw = getCF(cfValues, CF_PLAN);
    const planProposed = typeof planRaw === "string" ? planRaw : null;

    // Stage
    const stage = STAGE_MAP[kl.status_id] ?? "nuevo";

    // Priority from tags
    let priority = "b";
    const tags = kl._embedded?.tags ?? [];
    for (const tag of tags) {
      if (tag.name === "prioridad-a") { priority = "a"; break; }
      if (tag.name === "prioridad-c") { priority = "c"; break; }
    }

    // Contacts
    const kommoContacts = kl._embedded?.contacts ?? [];

    if (DRY_RUN) {
      console.log(`[DRY] Crearía: "${name}" (${stage}, ${countryCode})`);
      created++;
      existingNames.add(normName);
      continue;
    }

    // Find or use default assignee.
    let assignedToUserId = defaultUserId;
    const comercialRaw = getCF(cfValues, CF_COMERCIAL);
    if (typeof comercialRaw === "string" && comercialRaw.includes("@")) {
      const rep = await db.user.findUnique({
        where: { email: comercialRaw.toLowerCase().trim() },
        select: { id: true },
      }).catch(() => null);
      if (rep) assignedToUserId = rep.id;
    }

    if (!assignedToUserId) {
      console.warn(`SKIP "${name}": sin asignado.`);
      skipped++;
      continue;
    }

    try {
      const lead = await db.crmLead.create({
        data: {
          name,
          countryCode,
          cityId: cityId ?? undefined,
          planProposed,
          stage,
          priority,
          assignedToUserId,
          createdByUserId: assignedToUserId,
          createdAt: kl.created_at ? new Date(kl.created_at * 1000) : new Date(),
        },
      });

      // Contacts
      for (const kc of kommoContacts) {
        const cName = (kc.name ?? "").trim() || name;
        const phones = kc._embedded?.phones ?? kc.custom_fields_values
          ?.filter((f) => f.field_type === "phone")
          ?.flatMap((f) => f.values.map((v) => v.value)) ?? [];
        const emails = kc._embedded?.emails ?? kc.custom_fields_values
          ?.filter((f) => f.field_type === "email")
          ?.flatMap((f) => f.values.map((v) => v.value)) ?? [];

        await db.crmContact.create({
          data: {
            leadId: lead.id,
            name: cName,
            phone: phones[0] ? normalizePhone(phones[0], countryCode) : null,
            email: emails[0] ?? null,
            isPrimary: kc.is_main ?? false,
          },
        }).catch(() => {}); // ignore duplicates / invalid data
      }

      // Notes → CrmActivity
      const notes = await fetchNotes(kl.id);
      for (const note of notes) {
        const text = note.params?.text ?? note.text ?? "";
        if (!text) continue;
        await db.crmActivity.create({
          data: {
            leadId: lead.id,
            userId: assignedToUserId,
            type: "note",
            content: typeof text === "string" ? text.slice(0, 2000) : "",
            createdAt: note.created_at ? new Date(note.created_at * 1000) : new Date(),
          },
        }).catch(() => {});
      }

      created++;
      existingNames.add(normName);
    } catch (err) {
      console.error(`ERROR en "${name}":`, err.message ?? err);
      errors++;
    }
  }

  console.log(`\n=== Resultado ===`);
  console.log(`Creados:  ${created}`);
  console.log(`Saltados: ${skipped}`);
  console.log(`Errores:  ${errors}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
