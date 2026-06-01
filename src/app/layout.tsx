import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import "./globals.css";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "MESAPAY",
  description: "Ordena y paga desde tu mesa",
  applicationName: "MESAPAY",
  appleWebApp: {
    capable: true,
    title: "MESAPAY",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Idioma resuelto por next-intl (cookie MESAPAY_LOCALE → Accept-Language → es).
  const locale = await getLocale();
  return (
    <html lang={locale} className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/*
          Auto-recuperación del Service Worker. Va INLINE en el <head>
          a propósito: el HTML siempre llega fresco de la red (el SW
          viejo sólo interceptaba /_next/static), así que este script
          corre aunque los chunks de React estén stale/rotos — que es
          justo el escenario que rompía a usuarios con el SW malo de un
          deploy anterior (cacheaba chunks cache-first → "se queda
          pensando" en ventana normal, incógnito funcionaba).

          Qué hace:
          1. Si YA hay un SW registrado (sólo entonces), fuerza un
             update() para que el browser baje el /sw.js nuevo y bueno.
             El sw.js bueno hace skipWaiting + purga TODOS los caches +
             clients.claim en su activate.
          2. Cuando el SW nuevo toma control (controllerchange) recarga
             UNA vez para servir los chunks frescos desde red.

          No registra un SW nuevo en visitantes que nunca tuvieron uno
          (eso lo sigue haciendo PushSetup sólo para meseros), así que
          un diner cualquiera no termina con un SW de la nada.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  if (!('serviceWorker' in navigator)) return;
  try {
    var hadController = !!navigator.serviceWorker.controller;
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function(){
      // Sólo recargamos si ya había un controlador antes: así el claim
      // inicial de un primer registro (PushSetup) no dispara un reload.
      if (!hadController || refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.getRegistration().then(function(reg){
      if (reg) { try { reg.update(); } catch (e) {} }
    }).catch(function(){});
  } catch (e) {}
})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-bone text-ink">
        {/*
          NextIntlClientProvider sin props: hereda locale + mensajes del
          request config (src/i18n/request.ts) y los reenvía a los Client
          Components. Envuelve a Providers (SessionProvider) para que
          useTranslations funcione en toda la app.
        */}
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
