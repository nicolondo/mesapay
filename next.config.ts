import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl: apunta al request config (modo sin routing por URL).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  /* config options here */
};

export default withNextIntl(nextConfig);
