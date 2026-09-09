import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  authenticatePrintAgent,
  clientIp,
  touchPrintAgent,
} from "@/lib/print/agentAuth";
import {
  duplicateLocalKeys,
  invalidKindStations,
  invalidSubStations,
  printersReportSchema,
} from "@/lib/print/printerConfig";

export const dynamic = "force-dynamic";

/**
 * POST /api/print-agent/printers
 * Authorization: Bearer mpa_…
 * body: { printers: [ { localKey, label, host, port, kind, station,
 *                       barSubStation, paperWidthMm, active } ] }
 *
 * `kind` ("comanda" | "factura") es OPCIONAL y por default "comanda": el
 * programa que corre hoy en los locales no lo manda, y tiene que poder
 * seguir publicando sus impresoras de cocina sin actualizarse. Una
 * impresora de factura declara `kind: "factura"` y NO manda `station`.
 *
 * El agente PUBLICA las impresoras que tiene configuradas. La IP se
 * escribe en el programa, no en la web: quien instala está parado frente
 * a la impresora y es el único que puede resolver un cambio de IP del
 * router. Esta ruta es cómo esa config local llega al servidor para que
 * (a) el ruteo de comandas sepa a dónde mandar cada estación y (b) el
 * dueño pueda VER desde su casa qué impresoras hay y probarlas.
 *
 * Es un REEMPLAZO DECLARATIVO del set: lo que no venga en el body queda
 * `active: false`. No se borra — hay PrintJob colgando de esas filas y
 * ese historial es la única forma de contestar "¿esta comanda salió?".
 *
 * `localKey` es la llave del upsert. El mismo localKey actualiza la fila
 * (la impresora cambió de IP), no crea otra; así los trabajos viejos
 * siguen apuntando a la misma impresora.
 */
async function POSTHandler(req: Request) {
  const agent = await authenticatePrintAgent(req);
  if (!agent) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = printersReportSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        // El instalador está parado en la cocina mirando la consola del
        // agente: decirle QUÉ campo está mal le ahorra un viaje.
        issues: parsed.error.issues.slice(0, 20).map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
      { status: 400 },
    );
  }
  const incoming = parsed.data.printers;

  const dupes = duplicateLocalKeys(incoming);
  if (dupes.length > 0) {
    return NextResponse.json(
      { error: "duplicate_local_key", localKeys: dupes },
      { status: 400 },
    );
  }

  // Una de comanda SIN estación no recibiría nunca un trabajo; una de
  // factura CON estación miente sobre lo que va a imprimir. Las dos se
  // ven bien en la pantalla y no imprimen: mejor rechazar el set entero
  // ahora, con el instalador todavía parado frente a la impresora.
  const badKinds = invalidKindStations(incoming);
  if (badKinds.length > 0) {
    return NextResponse.json(
      { error: "invalid_station_for_kind", printers: badKinds },
      { status: 400 },
    );
  }

  const restaurant = await db.restaurant.findUnique({
    where: { id: agent.restaurantId },
    select: { barSubStations: true },
  });
  if (!restaurant) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const badSubs = invalidSubStations(incoming, restaurant.barSubStations);
  if (badSubs.length > 0) {
    return NextResponse.json(
      {
        error: "unknown_bar_sub_station",
        barSubStations: badSubs,
        allowed: restaurant.barSubStations,
      },
      { status: 400 },
    );
  }

  await touchPrintAgent(agent.agentId, { ip: clientIp(req) });

  // Todo en una transacción: si el set queda a medio aplicar, la mitad
  // de las impresoras del local quedan apagadas y nadie se entera hasta
  // que falta media comanda.
  const saved = await db.$transaction(async (tx) => {
    const rows = [];
    for (const p of incoming) {
      const data = {
        restaurantId: agent.restaurantId,
        label: p.label,
        host: p.host,
        port: p.port,
        kind: p.kind,
        station: p.station ?? null,
        barSubStation: p.barSubStation ?? null,
        paperWidthMm: p.paperWidthMm ?? null,
        active: p.active,
      };
      rows.push(
        await tx.printer.upsert({
          where: {
            agentId_localKey: { agentId: agent.agentId, localKey: p.localKey },
          },
          create: { ...data, agentId: agent.agentId, localKey: p.localKey },
          update: data,
          select: {
            id: true,
            localKey: true,
            label: true,
            host: true,
            port: true,
            kind: true,
            station: true,
            barSubStation: true,
            paperWidthMm: true,
            active: true,
          },
        }),
      );
    }

    // Las que el agente ya no reporta: se apagan, no se borran.
    const deactivated = await tx.printer.updateMany({
      where: {
        agentId: agent.agentId,
        restaurantId: agent.restaurantId,
        active: true,
        localKey: { notIn: incoming.map((p) => p.localKey) },
      },
      data: { active: false },
    });

    return { rows, deactivated: deactivated.count };
  });

  return NextResponse.json({
    agent: { id: agent.agentId, label: agent.label },
    printers: saved.rows,
    deactivated: saved.deactivated,
  });
}

export const POST = secureApi(POSTHandler);
