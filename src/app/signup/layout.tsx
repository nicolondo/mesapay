import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Registro de restaurantes (se abre desde enlaces de WhatsApp): el HTML lleva
 * sólo los textos que usan sus Client Components.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.signup).
 */
export default function SignUpLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="signup">{children}</SurfaceIntlProvider>;
}
