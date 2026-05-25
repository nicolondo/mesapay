import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getMeseroScope } from "@/lib/meseroScope";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  // Mesero-scoped users only see payments for orders on their tables.
  // Other roles see everything.
  const scope = await getMeseroScope();
  const tableFilter = scope.scoped
    ? { table: { number: { in: scope.tableNumbers ?? [] } } }
    : {};

  const [tenant, payments] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { serviceMode: true },
    }),
    db.payment.findMany({
      where: { order: { restaurantId, ...tableFilter } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { order: { include: { table: true } } },
    }),
  ]);
  const counterMode = tenant?.serviceMode === "counter";

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="font-display text-3xl mb-4">Cobros</div>
      <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-op-bg">
            <tr className="text-left">
              <Th>Fecha</Th>
              <Th>Orden</Th>
              <Th>{counterMode ? "Canal" : "Mesa"}</Th>
              <Th>Método</Th>
              <Th>Estado</Th>
              <Th className="text-right">Monto</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-op-border">
            {payments.map((p) => (
              <tr key={p.id}>
                <Td>{p.createdAt.toLocaleString("es-CO")}</Td>
                <Td className="font-mono">{p.order.shortCode}</Td>
                <Td>
                  {counterMode ? "Mostrador" : `Mesa ${p.order.table.number}`}
                </Td>
                <Td>{methodLabel(p.method)}</Td>
                <Td>
                  <span className={statusTint(p.status)}>{p.status}</span>
                </Td>
                <Td className="text-right font-mono tabular">
                  {fmtCOP(p.amountCents)}
                </Td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-op-muted text-center">
                  No hay cobros todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={
        "px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted " +
        className
      }
    >
      {children}
    </th>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={"px-4 py-2.5 " + className}>{children}</td>;
}
function methodLabel(m: string) {
  const map: Record<string, string> = {
    demo_card: "Tarjeta (demo)",
    demo_cash: "Efectivo",
    wompi_card: "Tarjeta",
    wompi_pse: "PSE",
    wompi_nequi: "Nequi",
  };
  return map[m] ?? m;
}
function statusTint(s: string) {
  switch (s) {
    case "approved":
      return "text-ok";
    case "declined":
      return "text-danger";
    case "refunded":
      return "text-op-muted";
    default:
      return "text-[#C98A2E]";
  }
}
