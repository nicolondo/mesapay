import type { Metadata } from "next";

/**
 * Override del root metadata para el kiosko de asistencia. Cuando se
 * instala en una tablet ("Add to Home Screen"), el icono queda como
 * "MP Asistencia" apuntando al manifest propio — diferenciado del PWA
 * del comercio / mesero. El layout solo aporta el metadata; el gate y la
 * UI viven en la página.
 */
export const metadata: Metadata = {
  title: "MP Asistencia",
  applicationName: "MP Asistencia",
  manifest: "/api/manifest/asistencia",
  appleWebApp: {
    capable: true,
    title: "MP Asistencia",
    statusBarStyle: "black-translucent",
  },
};

export default function KioskoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
