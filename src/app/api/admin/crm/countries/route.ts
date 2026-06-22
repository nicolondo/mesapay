import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import coData from "@/data/cities/co.json";
import mxData from "@/data/cities/mx.json";
import arData from "@/data/cities/ar.json";
import brData from "@/data/cities/br.json";
import clData from "@/data/cities/cl.json";
import peData from "@/data/cities/pe.json";
import ecData from "@/data/cities/ec.json";
import paData from "@/data/cities/pa.json";
import crData from "@/data/cities/cr.json";
import esData from "@/data/cities/es.json";

// ── Static dataset registry ──────────────────────────────────────────────────

interface CityDataset {
  country: string;
  name: string;
  main: string[];
  cities: string[];
}

const DATASETS: Record<string, CityDataset> = {
  CO: coData as CityDataset,
  MX: mxData as CityDataset,
  AR: arData as CityDataset,
  BR: brData as CityDataset,
  CL: clData as CityDataset,
  PE: peData as CityDataset,
  EC: ecData as CityDataset,
  PA: paData as CityDataset,
  CR: crData as CityDataset,
  ES: esData as CityDataset,
};

const VALID_CODES = Object.keys(DATASETS) as [string, ...string[]];

// ── GET /api/admin/crm/countries ─────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (session?.user?.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Fetch existing DB records for enabled + currency state.
  const dbCountries = await db.crmCountry.findMany({
    select: { code: true, enabled: true, currency: true },
  });
  const dbMap = new Map(dbCountries.map((c) => [c.code, c]));

  // Count seeded cities per country.
  const cityCounts = await db.crmCity.groupBy({
    by: ["countryCode"],
    _count: { id: true },
  });
  const countMap = new Map(cityCounts.map((c) => [c.countryCode, c._count.id]));

  const countries = Object.entries(DATASETS).map(([code, ds]) => ({
    code,
    name: ds.name,
    enabled: dbMap.get(code)?.enabled ?? false,
    currency: dbMap.get(code)?.currency ?? defaultCurrencyFor(code),
    cityCount: countMap.get(code) ?? 0,
    datasetSize: ds.cities.length,
  }));

  return NextResponse.json({ countries });
}

/** Moneda por defecto sugerida por país (editable por el admin). */
function defaultCurrencyFor(code: string): string {
  return code === "MX" ? "MXN" : "COP";
}

// ── POST /api/admin/crm/countries ────────────────────────────────────────────

const schema = z.object({
  code: z.enum(VALID_CODES as [string, ...string[]]),
  enabled: z.boolean(),
  // Moneda de cobro del país (suscripción + pagos de comensales).
  currency: z.enum(["COP", "MXN"]).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { code, enabled } = parsed.data;
  const ds = DATASETS[code];
  if (!ds) {
    return NextResponse.json({ error: "unknown_country" }, { status: 400 });
  }
  const currency = parsed.data.currency ?? defaultCurrencyFor(code);

  // Upsert CrmCountry (incluye moneda de cobro).
  await db.crmCountry.upsert({
    where: { code },
    create: { code, name: ds.name, enabled, currency },
    update: { name: ds.name, enabled, currency },
  });

  let seeded = 0;

  if (enabled) {
    // Seed cities from dataset, deduplicated.
    // CrmCity has @@unique([countryCode, name]) so we can use createMany skipDuplicates.
    const existingNames = await db.crmCity
      .findMany({
        where: { countryCode: code },
        select: { name: true },
      })
      .then((rows) => new Set(rows.map((r) => r.name)));

    const mainSet = new Set(ds.main);
    const toCreate = ds.cities
      .filter((name) => !existingNames.has(name))
      .map((name) => ({
        countryCode: code,
        name,
        isMain: mainSet.has(name),
      }));

    if (toCreate.length > 0) {
      const result = await db.crmCity.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      seeded = result.count;
    }
  }

  await recordAuditEvent({
    kind: "crm.country.toggle",
    summary: `${enabled ? "Habilitó" : "Deshabilitó"} país: ${code} (${ds.name}) · moneda ${currency}${enabled && seeded > 0 ? ` · sembradas ${seeded} ciudades` : ""}`,
  });

  return NextResponse.json({ ok: true, seeded });
}
