import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Factura pública (enlace del correo / QR de la tirilla): el HTML lleva sólo
 * los textos que usan sus Client Components.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.factura).
 */
export default function InvoiceSurfaceLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="factura">{children}</SurfaceIntlProvider>;
}
