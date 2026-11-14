import type { ThermalReport } from "@/lib/escpos/report";
import { receiptSidePaddingMm } from "@/lib/print/printDestination";

/**
 * Un REPORTE térmico (hoy, el cierre de turno) dibujado como tirilla en el
 * navegador: el MISMO documento que sale por ESC/POS (`renderReport`), al
 * ancho del papel (58 u 80 mm, o el del equipo), en blanco y negro y monoespaciada, como la
 * factura y la precuenta imprimibles.
 *
 * Marca `data-print-document` y `data-print-width-mm`: así lo imprime el
 * iframe oculto de «Este dispositivo» (o el respaldo sin agente) en UNA
 * sola página del alto del documento (`fitPageToContent`). Mide lo mismo
 * en pantalla que en papel.
 *
 * Sin textos propios: todo viene resuelto en `doc`.
 */
export function ThermalReportReceipt({
  doc,
  paperMm,
  kind,
}: {
  doc: ThermalReport;
  /** Ancho del papel en mm (58/80 del comercio, o el del equipo). */
  paperMm: number;
  /** Valor de `data-print-document` ("cierre"). */
  kind: string;
}) {
  return (
    <article
      className="receipt thermal-report"
      data-print-document={kind}
      data-print-width-mm={paperMm}
      style={{ width: `${paperMm}mm`, paddingInline: `${receiptSidePaddingMm(paperMm)}mm` }}
    >
      <div className="biz-name">{doc.businessName}</div>
      {doc.businessLines.length > 0 && <div className="meta">{doc.businessLines.join(" · ")}</div>}
      <hr className="dashed" />
      <div className="title">{doc.title}</div>
      <div className="rows">
        {doc.metaRows.map((row, i) => (
          <div className="row" key={i}>
            <span>{row.label}</span>
            <span className="right">{row.value}</span>
          </div>
        ))}
      </div>
      {doc.sections.map((section, i) => (
        <section key={i}>
          <hr className="dashed" />
          <div className="section-title">{section.title}</div>
          {section.rows.map((row, j) => (
            <div className={row.strong ? "row grand" : "row"} key={j}>
              <span>{row.label}</span>
              <span className="right">{row.value}</span>
            </div>
          ))}
          {section.notes.map((note, j) => (
            <p className="note" key={j}>
              {note}
            </p>
          ))}
        </section>
      ))}
      {doc.footerLines.length > 0 && (
        <>
          <hr className="dashed" />
          <div className="footer">
            {doc.footerLines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

/**
 * Estilos de la tirilla del reporte (van en el `<style>` de la página que
 * la muestra). Mismo tamaño de letra que la factura y la precuenta: 12 px
 * el cuerpo, 13–14 px lo fuerte, nada por debajo de 10 px, para que en
 * la térmica de 55–58 mm del datáfono se lea sin lupa.
 */
export const THERMAL_REPORT_STYLES = `
  .thermal-report {
    background: #fff;
    color: #000;
    max-width: 100%;
    padding: 3mm 4mm 2mm;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Droid Sans Mono", monospace;
    font-size: 12px;
    line-height: 1.25;
    box-shadow: 0 6px 24px rgba(0,0,0,0.08);
    box-sizing: border-box;
  }
  .thermal-report *, .thermal-report *::before, .thermal-report *::after { box-sizing: border-box; }
  .thermal-report .biz-name { text-align: center; font-weight: 700; font-size: 13px; text-transform: uppercase; }
  .thermal-report .meta { text-align: center; font-size: 10px; line-height: 1.2; }
  .thermal-report hr.dashed { border: none; border-top: 1px dashed #000; margin: 3px 0; }
  .thermal-report .title { text-align: center; font-weight: 700; font-size: 15px; letter-spacing: 0.06em; margin-bottom: 2px; }
  .thermal-report .section-title { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  .thermal-report .row { display: flex; flex-wrap: wrap; justify-content: space-between; column-gap: 6px; }
  .thermal-report .row .right { margin-left: auto; white-space: nowrap; text-align: right; }
  .thermal-report .row.grand { font-weight: 700; font-size: 14px; margin-top: 2px; padding-top: 2px; border-top: 1px solid #000; }
  .thermal-report .note { font-size: 10px; line-height: 1.25; margin: 2px 0 0; overflow-wrap: anywhere; }
  .thermal-report .footer { text-align: center; font-size: 10px; line-height: 1.25; }
  @media print {
    .thermal-report { box-shadow: none; }
  }
`;
