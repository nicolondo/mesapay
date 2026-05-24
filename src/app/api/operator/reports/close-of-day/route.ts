import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { bogotaDayRange, bogotaTodayIso, fmtBogotaDateTime } from "@/lib/bogota";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const METHOD_LABEL: Record<string, string> = {
  demo_card: "Tarjeta (demo)",
  demo_cash: "Efectivo",
  wompi_card: "Tarjeta",
  wompi_pse: "PSE",
  wompi_nequi: "Nequi",
  kushki_apple_pay: "Apple Pay",
  kushki_card_terminal: "Datáfono",
};

function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 400 });
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true, serviceMode: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }
  const counterMode = tenant.serviceMode === "counter";

  const url = new URL(req.url);
  const raw = url.searchParams.get("date") ?? "";
  const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : bogotaTodayIso();
  const { start, end } = bogotaDayRange(dateIso);

  const payments = await db.payment.findMany({
    where: {
      status: "approved",
      createdAt: { gte: start, lt: end },
      order: { restaurantId },
    },
    include: {
      order: {
        select: {
          shortCode: true,
          tipCents: true,
          subtotalCents: true,
          totalCents: true,
          table: { select: { number: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const headers = [
    "fecha",
    "hora",
    "pedido",
    counterMode ? "canal" : "mesa",
    "metodo",
    "monto_cop",
    "orden_subtotal_cop",
    "orden_propina_cop",
    "orden_total_cop",
    "ref_proveedor",
  ];

  const rows = payments.map((p) => {
    const bt = fmtBogotaDateTime(p.createdAt);
    return [
      bt.date,
      bt.time,
      csvField(p.order.shortCode),
      counterMode ? csvField("Mostrador") : p.order.table.number,
      csvField(METHOD_LABEL[p.method] ?? p.method),
      p.amountCents,
      p.order.subtotalCents,
      p.order.tipCents,
      p.order.totalCents,
      csvField(p.providerRef),
    ].join(",");
  });

  const totalSum = payments.reduce((s, p) => s + p.amountCents, 0);
  const totalRow = [
    dateIso,
    "",
    csvField("TOTAL"),
    "",
    "",
    totalSum,
    "",
    "",
    "",
    "",
  ].join(",");

  // UTF-8 BOM so Excel opens accented chars correctly.
  const csv = "\uFEFF" + [headers.join(","), ...rows, totalRow].join("\r\n");
  const filename = `cierre-${tenant.slug}-${dateIso}.csv`;

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
