import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { parseCsv } from "@/lib/crm/csv";
import { normalizePhone } from "@/lib/crm/phone";
import { normalizeLeadName } from "@/lib/crm/dupes";
import type { Prisma } from "@prisma/client";

const bodySchema = z.object({
  csv: z.string().min(1),
  country: z.string().length(2).toUpperCase().optional(),
});

// Expected CSV columns (tolerate missing ones).
// nombre, ciudad, telefono, email, zona, prioridad, notas

export async function POST(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const countryParam = searchParams.get("country")?.toUpperCase() ?? undefined;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Determine country code.
  let countryCode: string | null = null;
  if (ctx.countryCode) {
    countryCode = ctx.countryCode;
  } else if (countryParam) {
    countryCode = countryParam;
  } else if (parsed.data.country) {
    countryCode = parsed.data.country;
  }

  if (!countryCode) {
    return NextResponse.json({ error: "missing_country" }, { status: 400 });
  }

  const { rows } = parseCsv(parsed.data.csv);
  // Cap at 500 rows.
  const dataRows = rows.slice(0, 500);

  // Build scope filter for duplicate detection.
  const scopeFilter: Prisma.CrmLeadWhereInput =
    ctx.visibleUserIds !== null
      ? { assignedToUserId: { in: ctx.visibleUserIds } }
      : {};

  // Fetch all existing lead names + contact phones in scope (for dedup).
  const existingLeads = await db.crmLead.findMany({
    where: scopeFilter,
    select: {
      id: true,
      name: true,
      contacts: { select: { phone: true } },
    },
  });

  const existingNormalizedNames = new Set(
    existingLeads.map((l) => normalizeLeadName(l.name)),
  );
  const existingPhones = new Set(
    existingLeads.flatMap((l) => l.contacts.map((c) => c.phone)).filter(Boolean),
  );

  // City lookup cache.
  const cityCache = new Map<string, string>(); // name → id

  async function lookupCity(name: string): Promise<string | null> {
    if (!name.trim()) return null;
    const key = name.trim().toLowerCase();
    if (cityCache.has(key)) return cityCache.get(key) ?? null;
    const city = await db.crmCity.findFirst({
      where: {
        countryCode: countryCode!,
        name: { equals: name.trim(), mode: "insensitive" },
      },
      select: { id: true },
    });
    const id = city?.id ?? null;
    cityCache.set(key, id ?? "");
    return id;
  }

  let created = 0;
  let skipped = 0;
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2; // 1-based, +1 for header

    const rawName = row["nombre"] ?? "";
    if (!rawName.trim()) {
      errors.push({ row: rowNum, message: "missing_nombre" });
      continue;
    }

    const normalizedName = normalizeLeadName(rawName);
    const rawPhone = row["telefono"] ?? "";
    const phone = rawPhone.trim()
      ? normalizePhone(rawPhone.trim(), countryCode!)
      : null;

    // Check for duplicates.
    if (existingNormalizedNames.has(normalizedName)) {
      skipped++;
      continue;
    }
    if (phone && existingPhones.has(phone)) {
      skipped++;
      continue;
    }

    // Parse priority.
    const rawPriority = row["prioridad"]?.trim().toLowerCase();
    const priority =
      rawPriority === "a" || rawPriority === "b" || rawPriority === "c"
        ? rawPriority
        : "b";

    // City lookup.
    const cityId = await lookupCity(row["ciudad"] ?? "");

    try {
      await db.crmLead.create({
        data: {
          name: rawName.trim(),
          countryCode: countryCode!,
          cityId,
          zone: row["zona"]?.trim() || null,
          notes: row["notas"]?.trim() || null,
          priority,
          source: "csv",
          assignedToUserId: ctx.userId,
          createdByUserId: ctx.userId,
          // Create primary contact if we have phone or email.
          contacts:
            phone || row["email"]?.trim()
              ? {
                  create: {
                    name: rawName.trim(),
                    phone,
                    email: row["email"]?.trim() || null,
                    isPrimary: true,
                  },
                }
              : undefined,
        },
      });

      // Update local dedup sets.
      existingNormalizedNames.add(normalizedName);
      if (phone) existingPhones.add(phone);
      created++;
    } catch (err) {
      errors.push({
        row: rowNum,
        message: err instanceof Error ? err.message : "unknown_error",
      });
    }
  }

  return NextResponse.json({ created, skipped, errors });
}
