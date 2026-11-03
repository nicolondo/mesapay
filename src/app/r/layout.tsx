import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Páginas públicas del restaurante (reservas, links de pago, estado de cuenta):
 * se abren desde WhatsApp; el HTML lleva sólo los textos que usan sus Client Components.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.r).
 */
export default function RestaurantPublicLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="r">{children}</SurfaceIntlProvider>;
}
