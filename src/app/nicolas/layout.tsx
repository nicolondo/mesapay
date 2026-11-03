import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Tarjeta de contacto pública: el HTML lleva sólo los textos que usan sus
 * Client Components.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.nicolas).
 */
export default function CardSurfaceLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="nicolas">{children}</SurfaceIntlProvider>;
}
