import { db } from "@/lib/db";
import QRCode from "qrcode";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

/**
 * Página de impresión de QRs de mesa — formato compacto **30×30mm**
 * por tarjeta. Pensado para corte y pegado en mesas como sticker o
 * tarjeta laminada.
 *
 * Layout:
 *   - A4 (210×297mm) con 10mm de margen por @page
 *   - Grid `auto-fill` con columnas de 30mm + gap de 4mm — cuántos
 *     entran por fila depende del ancho de la hoja en el navegador
 *     pero el TAMAÑO FÍSICO de cada tarjeta es siempre 30×30mm
 *     (unidades mm garantizan medida real al imprimir)
 *   - Cada tarjeta:
 *       · Mesa N (top, 2.5mm)
 *       · QR ~22mm (centrado)
 *       · "Escanea" (bottom, 1.8mm)
 *   - Border solid 0.2mm a 50% gris — corta-líneas visibles sin
 *     dominar
 *
 * Vista en pantalla: misma medida en mm (renderizada a un zoom
 * cómodo para preview). El print queda 1:1 con la página A4.
 */
export default async function PrintTablesPage({
  searchParams,
}: {
  searchParams: Promise<{ pickup?: string }>;
}) {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  const { pickup } = await searchParams;
  const pickupOnly = pickup === "1";

  const allTables = await db.table.findMany({
    where: {
      restaurantId,
      number: pickupOnly ? -1 : { gte: 0 },
    },
    orderBy: { number: "asc" },
  });
  const tables =
    tenant.serviceMode === "counter" && !pickupOnly
      ? allTables.slice(0, 1)
      : allTables;

  const base = process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";

  // SVG QR — generamos con margin=1 (1 módulo de quiet zone, mínimo
  // legible) y width grande para que el escalado a 22mm via CSS
  // mantenga nitidez. Los módulos son vectoriales, no pixelados.
  const qrs = await Promise.all(
    tables.map(async (t) => {
      const url =
        t.number === -1
          ? `${base}/p/${tenant.slug}?t=${t.qrToken}`
          : `${base}/t/${tenant.slug}/menu?table=${t.qrToken}`;
      const svg = await QRCode.toString(url, {
        type: "svg",
        margin: 1,
        width: 400,
        color: { dark: "#1c1c1c", light: "#00000000" },
      });
      return { id: t.id, number: t.number, label: t.label, url, svg };
    }),
  );

  // Label de cada tarjeta — counter/pickup tienen casos especiales,
  // mesa normal es "Mesa N".
  const labelOf = (n: number) => {
    if (n === -1) return "Recogida";
    if (tenant.serviceMode === "counter") return "Mostrador";
    return `Mesa ${n}`;
  };

  return (
    <>
      <style>{`
        /* @page controla margen físico de la hoja al imprimir. 10mm
           da espacio para que ninguna tarjeta quede comida por el
           drum del impresora pero deja área útil generosa. */
        @page { size: A4; margin: 10mm; }
        @media print {
          /* Background blanco forzado — algunos navegadores meten
             un fondo gris al imprimir sin esta declaración. */
          html, body { background: #ffffff !important; }
          .no-print { display: none !important; }
          .qr-card { break-inside: avoid; }
        }
        .qr-card {
          width: 30mm;
          height: 30mm;
          border: 0.2mm solid #999;
          /* Esquinas redondeadas tipo sticker / tag físico. 1.73mm
             es un radio suave que se nota pero no se come el área
             útil del QR. */
          border-radius: 1.73mm;
          padding: 1.5mm;
          display: flex;
          flex-direction: column;
          align-items: center;
          /* Sin "Escanea" abajo, el contenido (label + QR) queda
             centrado verticalmente — mejor balance visual que
             space-between con sólo 2 items. */
          justify-content: center;
          gap: 1.2mm;
          background: #ffffff;
          /* En pantalla queremos verlos centrados y limpios pero a
             escala real. mm es unidad física — Chrome lo respeta. */
        }
        .qr-label {
          font-size: 2.6mm;
          line-height: 1;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: #1c1c1c;
        }
        .qr-svg-wrap {
          width: 22mm;
          height: 22mm;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .qr-svg-wrap svg {
          width: 100%;
          height: 100%;
          display: block;
        }
        .qr-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, 30mm);
          gap: 4mm;
          justify-content: start;
        }
      `}</style>

      <div className="p-6 bg-white text-ink print:p-0">
        <div className="no-print mb-5 max-w-5xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-display text-3xl">QRs para imprimir</div>
            <p className="text-sm text-op-muted mt-1">
              Tarjetas de <strong>30×30mm</strong> en hoja A4 — entran
              ~50 por hoja. Imprime, corta por las líneas y coloca un
              QR en cada mesa.
            </p>
          </div>
          <PrintButton />
        </div>

        {/* Header de hoja: nombre del restaurante (sólo se imprime
            una vez arriba). En cards de 30mm no entra el nombre por
            cada tarjeta. */}
        <div className="max-w-5xl mx-auto mb-3 print:max-w-none">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
            {tenant.name}
          </div>
        </div>

        <div className="qr-grid max-w-5xl mx-auto print:max-w-none">
          {qrs.map((q) => (
            <div key={q.id} className="qr-card">
              <div className="qr-label">{labelOf(q.number)}</div>
              <div
                className="qr-svg-wrap"
                dangerouslySetInnerHTML={{ __html: q.svg }}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
