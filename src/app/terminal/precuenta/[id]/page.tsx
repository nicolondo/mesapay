// Precuenta imprimible vista desde el DATÁFONO — la misma página del
// operador, servida bajo /terminal/ porque el layout del operador rebota al
// rol Datáfono. Mismo patrón que /mesero/precuenta/[id]. Es la vista que
// imprime «Este dispositivo» en el Smart POS (ver TerminalPrintActions).
export { default, generateMetadata } from "../../../operator/orders/[id]/precuenta/page";
export const dynamic = "force-dynamic";
