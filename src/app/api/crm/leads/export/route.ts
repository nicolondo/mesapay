import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { recordAuditEvent } from "@/lib/auditLog";

// ── GET /api/crm/leads/export ────────────────────────────────────────────────
// Returns a CSV file with all leads in the caller's scope (max 2000 rows).
// Columns: nombre, etapa, prioridad, ciudad, pais, telefono, email,
//          asignadoA, ultimaActividad, proximaAccion, creado

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

export async function GET() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const where: Record<string, unknown> = {};
  if (ctx.visibleUserIds !== null) {
    where.assignedToUserId = { in: ctx.visibleUserIds };
  }

  const leads = await db.crmLead.findMany({
    where,
    take: 2000,
    orderBy: { createdAt: "desc" },
    include: {
      city: { select: { name: true } },
      assignedTo: { select: { name: true, email: true } },
      contacts: {
        where: { isPrimary: true },
        select: { phone: true, email: true },
        take: 1,
      },
    },
  });

  const HEADER = [
    "nombre",
    "etapa",
    "prioridad",
    "ciudad",
    "pais",
    "telefono",
    "email",
    "asignadoA",
    "ultimaActividad",
    "proximaAccion",
    "creado",
  ];

  const rows: string[] = [HEADER.join(",")];

  for (const lead of leads) {
    const primaryContact = lead.contacts[0] ?? null;
    rows.push(
      csvRow([
        lead.name,
        lead.stage,
        lead.priority,
        lead.city?.name ?? "",
        lead.countryCode,
        primaryContact?.phone ?? "",
        primaryContact?.email ?? "",
        lead.assignedTo ? (lead.assignedTo.name ?? lead.assignedTo.email) : "",
        lead.lastActivityAt?.toISOString() ?? "",
        lead.nextActionAt?.toISOString() ?? "",
        lead.createdAt.toISOString(),
      ]),
    );
  }

  const csv = rows.join("\r\n");

  // Audit best-effort.
  recordAuditEvent({
    kind: "crm.export",
    summary: `Exportó ${leads.length} leads CRM`,
  }).catch(() => {});

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="crm-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
