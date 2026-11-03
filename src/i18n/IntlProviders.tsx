import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { pickMessages, surfaceNamespaces, type Surface } from "./clientMessages";

/**
 * Provider de una superficie pública: sus Client Components reciben sólo los
 * namespaces de `CLIENT_NAMESPACES[surface]` (+ los globales). Va en el
 * layout.tsx de primer nivel de la superficie y envuelve todo su contenido.
 * Ver src/i18n/clientMessages.ts.
 */
export async function SurfaceIntlProvider({
  surface,
  children,
}: {
  surface: Surface;
  children: ReactNode;
}) {
  const messages = await getMessages();
  return (
    <NextIntlClientProvider messages={pickMessages(messages, surfaceNamespaces(surface))}>
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * Provider de un área con sesión del equipo (operador, mesero, admin…): sus
 * Client Components reciben el catálogo completo, como antes del recorte.
 * Debe envolver TODO lo que pinta el layout (menús, avisos, banners), no
 * sólo `children`.
 */
export async function FullIntlProvider({ children }: { children: ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
