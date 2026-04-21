import { auth } from "@/auth";
import { db } from "@/lib/db";
import QRCode from "qrcode";

export const dynamic = "force-dynamic";

export default async function PrintTablesPage() {
  const session = await auth();
  const restaurantId = session!.user!.restaurantId;
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  const tables = await db.table.findMany({
    where: { restaurantId },
    orderBy: { number: "asc" },
  });

  const base = process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";

  const qrs = await Promise.all(
    tables.map(async (t) => {
      const url = `${base}/t/${tenant.slug}/menu?table=${t.qrToken}`;
      const svg = await QRCode.toString(url, {
        type: "svg",
        margin: 1,
        width: 320,
        color: { dark: "#1c1c1c", light: "#00000000" },
      });
      return { id: t.id, number: t.number, label: t.label, url, svg };
    }),
  );

  return (
    <div className="p-8 bg-white text-ink print:p-0">
      <div className="print:hidden mb-6 max-w-5xl mx-auto flex items-center justify-between">
        <div>
          <div className="font-display text-3xl">QRs para imprimir</div>
          <p className="text-sm text-op-muted mt-1">
            Imprime esta página en papel tamaño carta. Corta por las líneas y
            coloca un QR en cada mesa.
          </p>
        </div>
        <form action="javascript:window.print()">
          <button
            type="submit"
            className="h-10 px-5 rounded-full bg-ink text-bone font-medium"
          >
            Imprimir
          </button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-6 max-w-5xl mx-auto print:gap-0 print:max-w-none">
        {qrs.map((q) => (
          <div
            key={q.id}
            className="border border-dashed border-hairline rounded-2xl p-8 flex flex-col items-center text-center break-inside-avoid print:rounded-none print:border-solid"
          >
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
              {tenant.name}
            </div>
            <div className="font-display text-4xl tracking-[-0.015em] mt-2">
              Mesa {q.number}
            </div>
            {q.label && (
              <div className="text-sm text-muted mt-1">{q.label}</div>
            )}
            <div
              className="mt-5 w-[260px] h-[260px]"
              dangerouslySetInnerHTML={{ __html: q.svg }}
            />
            <div className="mt-5 font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Escanea para ordenar
            </div>
            <div className="mt-1 text-[10px] text-muted-2 break-all max-w-[220px]">
              {q.url}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
