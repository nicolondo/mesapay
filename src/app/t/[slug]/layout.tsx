import { notFound } from "next/navigation";
import { db } from "@/lib/db";

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
