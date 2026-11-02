import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl: apunta al request config (modo sin routing por URL).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // ssh2/ssh2-sftp-client usan bindings nativos + requires dinámicos que el
  // bundler no puede empaquetar. Se dejan como require() de Node en el server.
  // exceljs: librería grande con requires dinámicos; se deja como require de Node en el server.
  serverExternalPackages: ["ssh2", "ssh2-sftp-client", "sharp", "exceljs"],
  // Presentación comercial pública (mesapay.co/presentacion): un HTML
  // estático en public/presentacion/ con sus capturas. Next no sirve
  // index.html de una carpeta por su cuenta, así que la ruta sin archivo se
  // reescribe a él.
  async rewrites() {
    return [{ source: "/presentacion", destination: "/presentacion/index.html" }];
  },
};

export default withNextIntl(nextConfig);
