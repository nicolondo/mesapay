/**
 * El selector «Imprimir en» (variante `receipt`) en las vistas imprimibles
 * — la factura `/factura/[id]` y la precuenta —, que no usan los estilos
 * del panel sino su `<style>` propio en blanco y negro. Va dentro de esos
 * `<style>`; la barra de controles ya se esconde al imprimir.
 */
export const PRINT_DESTINATION_STYLES = `
  .print-destination {
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .print-destination > div {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .print-destination span {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .print-destination button.pd-chip {
    padding: 6px 12px;
    font-size: 11px;
    border-radius: 999px;
    border: 1px solid #000;
    letter-spacing: 0.02em;
  }
  .print-destination button.pd-off { background: #fff; color: #000; }
  .print-destination button.pd-on { background: #000; color: #fff; }
  .print-note a.print-help {
    all: unset;
    text-decoration: underline;
    cursor: pointer;
  }
`;
