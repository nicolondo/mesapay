import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";

// El menú del comensal SIEMPRE se abre en el navegador (se escanea el QR),
// nunca como PWA standalone. Por eso acá NO usamos viewport-fit=cover (que sí
// necesita la PWA del operador para el notch/home-indicator): con "cover" en
// Safari el contenido se mete DEBAJO de la barra de URL superior y tapaba el
// header sticky y la parte de arriba del sheet de producto al scrollear /
// abrir un producto. Con "auto" Safari mantiene el contenido por debajo de su
// barra, sin taparlo. Override por-ruta: solo afecta a /t/[slug]/*.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "auto",
  themeColor: "#000000",
};

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return notFound();
  return (
    <div className="flex flex-1 flex-col bg-bone text-ink">{children}</div>
  );
}
