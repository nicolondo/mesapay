import { SurfaceIntlProvider } from "@/i18n/IntlProviders";

/**
 * Ingreso (y «olvidé mi contraseña»): el HTML lleva sólo los textos que usan
 * sus Client Components. Al entrar, el área con sesión monta el catálogo completo.
 * Lista en src/i18n/clientMessages.ts (CLIENT_NAMESPACES.signin).
 */
export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return <SurfaceIntlProvider surface="signin">{children}</SurfaceIntlProvider>;
}
