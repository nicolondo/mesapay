import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { RegisterServiceWorker } from "./RegisterServiceWorker";

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
    <div className="flex flex-1 flex-col bg-bone text-ink">
      {/* Registra el SW para cachear chunks estáticos en sesiones
          posteriores. Mejora notablemente la 2da visita del diner. */}
      <RegisterServiceWorker />
      {children}
    </div>
  );
}
