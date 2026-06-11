#!/usr/bin/env node
/**
 * Backfill de contactos desde Kommo para leads ya migrados al CRM.
 *
 * El script de migración original leía los contactos EMBEBIDOS del lead,
 * pero Kommo solo embebe stubs ({id, is_main}) — sin nombre/teléfono/email.
 * Este backfill hace GET /contacts/{id} por cada stub, y para cada CrmLead
 * (match por nombre normalizado):
 *   1. borra los contactos placeholder que dejó el bug (sin phone, sin email,
 *      con name == nombre del lead),
 *   2. inserta los contactos reales (tel normalizado E.164, cargo, principal).
 * Idempotente: no duplica si el teléfono o email ya existe en ese lead.
 *
 * Uso (en el VPS, desde /opt/mesapay/current con el env de prod cargado):
 *   KOMMO_SUBDOMAIN=infomesapayco KOMMO_TOKEN=xxx node scripts/crm_backfill_kommo_contacts.mjs [--dry-run]
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const DRY_RUN = process.argv.includes("--dry-run");
const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const TOKEN = process.env.KOMMO_TOKEN;
if (!SUBDOMAIN || !TOKEN) {
  console.error("Faltan KOMMO_SUBDOMAIN / KOMMO_TOKEN");
  process.exit(1);
}
const BASE = `https://${SUBDOMAIN}.kommo.com/api/v4`;
const db = new PrismaClient();

async function kommoGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Kommo ${res.status} en ${path}`);
  return res.json();
}

function normName(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(restaurante|restaurant|sas|sa|ltda|grupo)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CODES = { CO: "57", MX: "52", AR: "54", BR: "55", CL: "56", PE: "51", EC: "593", PA: "507", CR: "506", ES: "34" };
function normalizePhone(raw, countryCode) {
  const code = CODES[countryCode] ?? "57";
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length < 7) return null;
  if (!(d.startsWith(code) && d.length >= code.length + 7)) d = code + d;
  return "+" + d;
}

function contactFields(c) {
  const out = { phone: null, email: null, role: null };
  for (const f of c.custom_fields_values ?? []) {
    const code = f.field_code;
    const v = f.values?.[0]?.value;
    if (!v) continue;
    if (code === "PHONE" && !out.phone) out.phone = String(v);
    if (code === "EMAIL" && !out.email) out.email = String(v);
    if (code === "POSITION" && !out.role) out.role = String(v);
  }
  return out;
}

async function main() {
  // 1) Leads de Kommo con stubs de contactos
  const kommoLeads = [];
  for (let page = 1; ; page++) {
    const data = await kommoGet(`/leads?with=contacts&page=${page}&limit=250&filter[pipeline_id]=13884563`);
    const batch = data?._embedded?.leads ?? [];
    if (!batch.length) break;
    kommoLeads.push(...batch);
    if (batch.length < 250) break;
  }
  console.log(`Kommo: ${kommoLeads.length} leads`);

  // 2) CrmLeads por nombre normalizado
  const crmLeads = await db.crmLead.findMany({
    select: { id: true, name: true, countryCode: true, contacts: { select: { id: true, name: true, phone: true, email: true } } },
  });
  const byName = new Map(crmLeads.map((l) => [normName(l.name), l]));

  let backfilled = 0, cleaned = 0, skipped = 0, errors = 0;
  const contactCache = new Map();

  for (const kl of kommoLeads) {
    const lead = byName.get(normName(kl.name ?? ""));
    if (!lead) { skipped++; continue; }
    const stubs = kl._embedded?.contacts ?? [];
    if (!stubs.length) continue;

    for (const stub of stubs) {
      try {
        let c = contactCache.get(stub.id);
        if (!c) {
          c = await kommoGet(`/contacts/${stub.id}`);
          contactCache.set(stub.id, c);
        }
        if (!c) continue;
        const { phone, email, role } = contactFields(c);
        const cName = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || (c.name ?? "").trim();
        if (!cName && !phone && !email) continue;
        const e164 = phone ? normalizePhone(phone, lead.countryCode) : null;

        const dup = lead.contacts.find(
          (x) => (e164 && x.phone === e164) || (email && x.email === email),
        );
        if (dup) continue;

        if (DRY_RUN) {
          console.log(`[DRY] "${lead.name}" ← contacto "${cName || "Contacto"}" tel=${e164 ?? "—"} email=${email ?? "—"}`);
          backfilled++;
          continue;
        }
        await db.crmContact.create({
          data: {
            leadId: lead.id,
            name: cName || "Contacto",
            role,
            phone: e164,
            email,
            isPrimary: stub.is_main ?? false,
          },
        });
        backfilled++;
      } catch (err) {
        console.error(`ERROR contacto de "${kl.name}":`, err.message ?? err);
        errors++;
      }
    }

    // 3) limpiar placeholders del bug (sin datos, nombre == lead)
    if (!DRY_RUN) {
      const res = await db.crmContact.deleteMany({
        where: { leadId: lead.id, phone: null, email: null, name: lead.name },
      });
      cleaned += res.count;
    }
  }

  console.log(`\n=== Resultado ===`);
  console.log(`Contactos creados: ${backfilled}`);
  console.log(`Placeholders eliminados: ${cleaned}`);
  console.log(`Leads sin match: ${skipped}`);
  console.log(`Errores: ${errors}`);
  await db.$disconnect();
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
