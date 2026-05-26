import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

export const dynamic = "force-dynamic";

/**
 * Genera un PDF A4 con tarjetas QR de 30×30mm exactas.
 *
 * El print engine de Chrome aplica scaling inconsistente cuando se
 * imprime HTML (depende de margins, drivers, sticky settings, etc).
 * Un PDF con dimensiones físicas baked-in evita ese problema —
 * cuando el operador abre el PDF y lo imprime al 100%, las cards
 * salen 30mm clavados.
 *
 * Layout:
 *   - A4: 210×297mm = 595.28×841.89 puntos PDF
 *   - 5 columnas × 30mm = 150mm
 *   - Padding interno 5mm a cada lado de la hoja
 *   - QR de 25mm centrado en cada card
 *   - "MESA N" en mayúscula al pie de cada card
 *   - Borders compartidos entre cards (un trazo por línea = un
 *     corte para guillotina)
 */

const MM_TO_PT = 2.83464566929;
const A4_W_MM = 210;
const A4_H_MM = 297;
const A4_W_PT = A4_W_MM * MM_TO_PT;
const A4_H_PT = A4_H_MM * MM_TO_PT;

const SHEET_PADDING_MM = 5;
const CARD_MM = 30;
const QR_MM = 25;
const COLS_PER_ROW = 5;
const CARD_RADIUS_MM = 1.3;
const BORDER_W_MM = 0.25;
const LABEL_HEIGHT_MM = 2.4;

export async function GET(req: Request) {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
  });
  if (!tenant) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // `pickup=1` filtra solo las mesas de recogida (number === -1).
  // Mismo modelo que /operator/tables/print/page.tsx.
  const url = new URL(req.url);
  const pickupOnly = url.searchParams.get("pickup") === "1";

  const allTables = await db.table.findMany({
    where: {
      restaurantId,
      number: pickupOnly ? -1 : { gte: 0 },
    },
    orderBy: { number: "asc" },
  });
  const list =
    tenant.serviceMode === "counter" && !pickupOnly
      ? allTables.slice(0, 1)
      : allTables;

  const base = process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";

  // Genera el PNG de cada QR a alta resolución (600px) — pdf-lib lo
  // escala al tamaño físico (25mm) sin pérdida porque es raster
  // suficientemente denso a impresión normal.
  const qrPngs = await Promise.all(
    list.map(async (t) => {
      // Pickup tables usan /p/{slug}?t=..., mesas normales /t/{slug}/menu?table=...
      const qrUrl =
        t.number === -1
          ? `${base}/p/${tenant.slug}?t=${t.qrToken}`
          : `${base}/t/${tenant.slug}/menu?table=${t.qrToken}`;
      const buf = await QRCode.toBuffer(qrUrl, {
        type: "png",
        margin: 1,
        width: 600,
        color: { dark: "#1c1c1c", light: "#ffffff" },
      });
      return { number: t.number, png: buf };
    }),
  );

  const pdf = await PDFDocument.create();
  pdf.setTitle(`QRs ${tenant.name}`);
  pdf.setCreator("MESAPAY");

  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const borderColor = rgb(0.6, 0.6, 0.6);
  const labelColor = rgb(0.11, 0.11, 0.11);

  // Convierte mm → puntos PDF; el sistema de coordenadas de PDF tiene
  // (0,0) en la esquina inferior-izquierda, así que para "y desde el
  // top" hay que restar de A4_H_PT.
  const mm = (n: number) => n * MM_TO_PT;
  const yFromTopMm = (n: number) => A4_H_PT - n * MM_TO_PT;

  // Cuántas filas caben por hoja, dejando padding superior e inferior.
  const usableHeightMm = A4_H_MM - SHEET_PADDING_MM * 2;
  const rowsPerPage = Math.floor(usableHeightMm / CARD_MM);

  // Helper para dibujar el borde redondeado de una card. pdf-lib no
  // tiene drawRoundedRect nativo así que componemos con líneas +
  // cuartos de círculo (cubic-bezier). Aproximación estándar: c=0.5523.
  //
  // OJO: drawSvgPath usa coordenadas en SVG-space (origen default
  // (0, page.height), Y crece HACIA ABAJO). Antes pasaba coords PDF
  // (Y-up) y los bordes se dibujaban fuera de la página. Aquí todo
  // se construye en SVG-space directamente: yTop es la distancia
  // desde el top de la hoja, yBot = yTop + h.
  function drawRoundedRect(
    page: ReturnType<typeof pdf.addPage>,
    xMm: number,
    yTopMm: number,
    wMm: number,
    hMm: number,
    rMm: number,
  ) {
    const x = mm(xMm);
    const yTop = mm(yTopMm);
    const w = mm(wMm);
    const h = mm(hMm);
    const r = mm(rMm);
    const yBot = yTop + h;
    const c = 0.5522847498 * r;
    const path = [
      `M ${x + r} ${yTop}`,
      `L ${x + w - r} ${yTop}`,
      `C ${x + w - r + c} ${yTop} ${x + w} ${yTop + r - c} ${x + w} ${yTop + r}`,
      `L ${x + w} ${yBot - r}`,
      `C ${x + w} ${yBot - r + c} ${x + w - r + c} ${yBot} ${x + w - r} ${yBot}`,
      `L ${x + r} ${yBot}`,
      `C ${x + r - c} ${yBot} ${x} ${yBot - r + c} ${x} ${yBot - r}`,
      `L ${x} ${yTop + r}`,
      `C ${x} ${yTop + r - c} ${x + r - c} ${yTop} ${x + r} ${yTop}`,
      "Z",
    ].join(" ");
    page.drawSvgPath(path, {
      borderColor,
      borderWidth: mm(BORDER_W_MM),
    });
  }

  // Embed PNGs una sola vez por slot. Antes lo keyé por t.number pero
  // pickup mode (todas con number=-1) colisionaba. Ahora cada card
  // tiene su imagen ya embebida en el array.
  const cards: Array<{
    number: number;
    img: Awaited<ReturnType<typeof pdf.embedPng>>;
  }> = [];
  for (const q of qrPngs) {
    const img = await pdf.embedPng(q.png);
    cards.push({ number: q.number, img });
  }

  // Distribuye las cards en N páginas. Cada página tiene
  // rowsPerPage × COLS_PER_ROW slots.
  const slotsPerPage = rowsPerPage * COLS_PER_ROW;
  const numPages = Math.max(1, Math.ceil(cards.length / slotsPerPage));

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = pdf.addPage([A4_W_PT, A4_H_PT]);
    const startIdx = pageIdx * slotsPerPage;
    const pageCards = cards.slice(startIdx, startIdx + slotsPerPage);

    for (let i = 0; i < pageCards.length; i++) {
      const row = Math.floor(i / COLS_PER_ROW);
      const col = i % COLS_PER_ROW;
      const xMm = SHEET_PADDING_MM + col * CARD_MM;
      const yTopMm = SHEET_PADDING_MM + row * CARD_MM;

      // Card border
      drawRoundedRect(page, xMm, yTopMm, CARD_MM, CARD_MM, CARD_RADIUS_MM);

      // QR centrado horizontalmente, alineado hacia arriba con
      // espacio para la label al pie.
      const q = pageCards[i];
      const qrXMm = xMm + (CARD_MM - QR_MM) / 2;
      const qrYTopMm = yTopMm + (CARD_MM - QR_MM - LABEL_HEIGHT_MM - 1) / 2;
      page.drawImage(q.img, {
        x: mm(qrXMm),
        y: yFromTopMm(qrYTopMm + QR_MM),
        width: mm(QR_MM),
        height: mm(QR_MM),
      });

      // Label centrada al pie de la card. -1 → RECOGIDA,
      // counter o mesa 0 → MOSTRADOR, resto → MESA N.
      const label =
        q.number === -1
          ? "RECOGIDA"
          : tenant.serviceMode === "counter"
            ? "MOSTRADOR"
            : `MESA ${q.number}`;
      const labelSizePt = mm(LABEL_HEIGHT_MM) * 0.85;
      const labelWidthPt = font.widthOfTextAtSize(label, labelSizePt);
      const labelXMm = xMm + CARD_MM / 2 - labelWidthPt / MM_TO_PT / 2;
      const labelYTopMm = yTopMm + CARD_MM - 1.5;
      page.drawText(label, {
        x: mm(labelXMm),
        y: yFromTopMm(labelYTopMm),
        size: labelSizePt,
        font,
        color: labelColor,
      });
    }
  }

  const bytes = await pdf.save();

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="qrs-${tenant.slug}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
