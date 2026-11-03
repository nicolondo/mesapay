import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Comensal que escanea el QR (carta, pedido, pago, cuenta): casi siempre con datos
 * móviles, así que el HTML lleva sólo los textos que usan sus Client Components.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.t).
 */
export default function DinerSurfaceLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="t">{children}</SurfaceIntlProvider>;
}
