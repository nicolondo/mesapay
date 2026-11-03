import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Restablecer contraseña (enlace del correo): el HTML lleva sólo los textos
 * que usan sus Client Components.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.restablecer).
 */
export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="restablecer">{children}</SurfaceIntlProvider>;
}
