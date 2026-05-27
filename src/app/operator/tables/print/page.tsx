import { db } from "@/lib/db";
import QRCode from "qrcode";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { PrintButton } from "./PrintButton";
import { CopyLinkList } from "./CopyLinkList";

// Cuántas tarjetas por fila. A4 = 210mm. Con margenes de Chrome
// generosos (a veces el "Default" del navegador es ~10-20mm cada
// lado dependiendo del driver), el area imprimible puede bajar a
// ~170mm. 5 cards × 30mm = 150mm asegura que el contenido CABE en
// cualquier margen razonable sin que Chrome aplique scaling para
// "ajustar a area imprimible". Sacrificamos 1 columna (de 6 a 5)
// a cambio de garantizar las medidas reales de 30×30mm.
const COLS_PER_ROW = 5;

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
  // MAYÚSCULA porque va abajo del QR como rótulo discreto.
  const labelOf = (n: number) => {
    if (n === -1) return "RECOGIDA";
    if (tenant.serviceMode === "counter") return "MOSTRADOR";
    return `MESA ${n}`;
  };

  return (
    <>
      <style>{`
        /* CALIBRACIÓN PRAGMÁTICA: Chrome aplica un shrink-to-fit en
           print que dimensiona el contenido a ~93.3% en vez de
           respetar mm exacto — resultado: 30mm sale 28mm físicos.
           En vez de pelearle, compensamos con un scale up del
           30/28 = 1.0714 en el grid de cards. Al combinarse con el
           shrink de Chrome (30 × 1.0714 × 0.933), termina en 30mm
           físicos exactos.

           Si en tu impresora sale diferente, ajusta el factor:
             factor = tamaño_deseado_mm / tamaño_actual_mm
           Ej: si salen a 27mm en lugar de 28mm → 30/27 = 1.111. */
        @page { size: 210mm 297mm; margin: 5mm; }
        @media print {
          html, body {
            background: #ffffff !important;
            margin: 0 !important;
            padding: 0 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .no-print { display: none !important; }
          .qr-card { break-inside: avoid; }
          .print-sheet {
            padding: 0 !important;
            margin: 0 !important;
            width: auto !important;
            min-height: 0 !important;
          }
          /* CALIBRACIÓN: Chrome shrink-to-fit deja el contenido al
             ~93.3% del tamaño en mm. Para que las cards salgan a
             30mm físicos exactos, las dimensionamos en print a
             32.14mm (= 30 / 0.933). Al ser dimensiones REALES (no
             transform) Chrome las ve en el layout y aplica su
             shrink, dando 30mm físicos. transform: scale() no
             funcionaba porque sólo afecta render, no layout. */
          .qr-card {
            width: 32.14mm !important;
            height: 32.14mm !important;
            border-radius: 1.39mm !important;
            padding: 0.857mm !important;
          }
          .qr-svg-wrap {
            width: 26.79mm !important;
            height: 26.79mm !important;
          }
          .qr-label {
            font-size: 2.57mm !important;
          }
        }
        /* Cards FLUSH — sin gap. Para evitar bordes dobles entre
           cards adyacentes, cada card sólo dibuja right + bottom.
           El primer card de cada fila agrega left, la primera fila
           agrega top — clases qr-card-first-col / qr-row-first
           manejan esos casos. border-radius 0.73mm da una pizca de
           curva a cada card; con borders compartidos las curvas
           crean un patrón sutil tipo "tile" en las intersecciones. */
        .qr-card {
          width: 30mm;
          height: 30mm;
          border-right: 0.1mm solid #999;
          border-bottom: 0.1mm solid #999;
          border-radius: 1.3mm;
          padding: 0.8mm;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: space-between;
          background: #ffffff;
          box-sizing: border-box;
        }
        .qr-row-first .qr-card {
          border-top: 0.1mm solid #999;
        }
        .qr-card-first-col {
          border-left: 0.1mm solid #999;
        }
        /* QR grande — con label compacta al pie, dejamos al QR todo
           el espacio: 30mm - 0.8mm*2 padding - 2.6mm label - 0.5mm
           gap visual ≈ 25mm. */
        .qr-svg-wrap {
          width: 25mm;
          height: 25mm;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .qr-svg-wrap svg {
          width: 100%;
          height: 100%;
          display: block;
        }
        /* Label al pie. Mayúscula + tracking ancho para que se lea
           como un rótulo, no como un título. Compacta — 2.4mm de
           alto. */
        .qr-label {
          font-size: 2.4mm;
          line-height: 1;
          font-weight: 600;
          letter-spacing: 0.08em;
          color: #1c1c1c;
        }
        .qr-page {
          display: flex;
          flex-direction: column;
        }
        .qr-row {
          display: flex;
          gap: 0;
          justify-content: flex-start;
        }
      `}</style>

      <div className="print-sheet p-6 bg-white text-ink">
        <div className="no-print mb-5 max-w-5xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-display text-3xl">QRs para imprimir</div>
            <p className="text-sm text-op-muted mt-1">
              Tarjetas de <strong>30×30mm</strong> en hoja A4 — caben
              hasta <strong>45 por hoja</strong>. Cards flush con
              borde compartido: un solo corte por línea.
            </p>
          </div>
          <PrintButton />
        </div>


        {/* Lista de links — solo en pantalla, no en print. El operador
            puede copiar el URL de cada mesa para mandarlo por chat o
            pegarlo en otro lado sin tener que imprimir el QR físico. */}
        <div className="no-print max-w-5xl mx-auto mb-5">
          <CopyLinkList
            items={qrs.map((q) => ({
              id: q.id,
              label: labelOf(q.number),
              url: q.url,
            }))}
          />
        </div>

        {/* Header de hoja: nombre del restaurante (sólo se imprime
            una vez arriba). En cards de 30mm no entra el nombre por
            cada tarjeta. */}
        <div className="max-w-5xl mx-auto mb-3 print:max-w-none">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
            {tenant.name}
          </div>
        </div>

        {/* Chunkamos los QRs en filas de COLS_PER_ROW. Cards flush
            sin gap: cada border entre cards es UN solo trazo
            (compartido) que también funciona como línea de corte. */}
        <div className="qr-page max-w-5xl mx-auto print:max-w-none">
          {chunk(qrs, COLS_PER_ROW).map((row, idx) => (
            <div
              key={idx}
              className={"qr-row " + (idx === 0 ? "qr-row-first" : "")}
            >
              {row.map((q, j) => (
                <div
                  key={q.id}
                  className={
                    "qr-card " + (j === 0 ? "qr-card-first-col" : "")
                  }
                >
                  <div
                    className="qr-svg-wrap"
                    dangerouslySetInnerHTML={{ __html: q.svg }}
                  />
                  <div className="qr-label">{labelOf(q.number)}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Splittea un array en grupos de tamaño N. Para chunkar los QRs
 * en filas explícitas que aceptan cut-guides intercalados. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
