import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl: apunta al request config (modo sin routing por URL).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // ssh2/ssh2-sftp-client usan bindings nativos + requires dinámicos que el
  // bundler no puede empaquetar. Se dejan como require() de Node en el server.
  serverExternalPackages: ["ssh2", "ssh2-sftp-client", "sharp"],
};

export default withNextIntl(nextConfig);
