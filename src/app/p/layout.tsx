import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Pedidos para llevar (carta y estado del pedido): el comensal entra desde un
 * enlace, con datos móviles; el HTML lleva sólo los textos que usan sus Client Components.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.p).
 */
export default function PickupSurfaceLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="p">{children}</SurfaceIntlProvider>;
}
