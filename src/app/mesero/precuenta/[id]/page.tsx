// Precuenta imprimible vista por el mesero — la misma página del operador,
// servida bajo /mesero/ para quedar dentro del scope del PWA instalado
// (el layout del operador rebota al rol mesero). Mismo patrón que
// /mesero/mesas.
export { default, generateMetadata } from "../../../operator/orders/[id]/precuenta/page";
export const dynamic = "force-dynamic";
