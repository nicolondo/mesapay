import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `POST /api/print-agent/printers` — el agente publica su set de
 * impresoras. Lo que hay que blindar:
 *
 *   1. es un UPSERT por localKey (reinstalar el agente o cambiarle la IP
 *      a la impresora NO puede duplicar filas, porque cada fila duplicada
 *      es una comanda de más saliendo por una impresora fantasma);
 *   2. es un REEMPLAZO del set: lo que no viene se apaga, no se borra
 *      (hay PrintJob colgando y ese historial es lo único que contesta
 *      "¿esta comanda salió?");
 *   3. las validaciones se hacen ANTES de escribir; y
 *   4. un token no puede tocar las impresoras de otro comercio.
 *
 * La DB es un doble en memoria: lo que se prueba es la lógica de la ruta,
 * no Prisma.
 */

type Row = {
  id: string;
  restaurantId: string;
  agentId: string | null;
  localKey: string | null;
  label: string;
  host: string;
  port: number;
  kind: string;
  station: string | null;
  barSubStation: string | null;
  paperWidthMm: number | null;
  active: boolean;
};

const h = vi.hoisted(() => {
  const state = {
    printers: [] as Row[],
    seq: 0,
    // Restaurante → sub-estaciones de barra definidas.
    subStations: new Map<string, string[]>(),
    // Token → identidad del agente.
    agents: new Map<
      string,
      { agentId: string; restaurantId: string; label: string }
    >(),
  };

  const printer = {
    upsert: vi.fn(
      async (args: {
        where: { agentId_localKey: { agentId: string; localKey: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { agentId, localKey } = args.where.agentId_localKey;
        const found = state.printers.find(
          (p) => p.agentId === agentId && p.localKey === localKey,
        );
        if (found) {
          Object.assign(found, args.update);
          return { ...found };
        }
        const row = {
          id: `printer-${++state.seq}`,
          ...(args.create as unknown as Omit<Row, "id">),
        } as Row;
        state.printers.push(row);
        return { ...row };
      },
    ),
    updateMany: vi.fn(
      async (args: {
        where: {
          agentId: string;
          restaurantId: string;
          active?: boolean;
          localKey?: { notIn: string[] };
        };
        data: Partial<Row>;
      }) => {
        const notIn = args.where.localKey?.notIn ?? null;
        let count = 0;
        for (const p of state.printers) {
          if (p.agentId !== args.where.agentId) continue;
          if (p.restaurantId !== args.where.restaurantId) continue;
          if (args.where.active !== undefined && p.active !== args.where.active) {
            continue;
          }
          // `NULL NOT IN (…)` no matchea en SQL: las filas sin localKey
          // quedan fuera, igual que en Postgres.
          if (notIn && (p.localKey === null || notIn.includes(p.localKey))) {
            continue;
          }
          Object.assign(p, args.data);
          count++;
        }
        return { count };
      },
    ),
  };

  const db = {
    printer,
    restaurant: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const subs = state.subStations.get(args.where.id);
        return subs ? { barSubStations: subs } : null;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ printer }),
    ),
  };

  const authenticatePrintAgent = vi.fn(async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] ?? "";
    return state.agents.get(token) ?? null;
  });

  return { state, db, authenticatePrintAgent };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/print/agentAuth", () => ({
  authenticatePrintAgent: h.authenticatePrintAgent,
  touchPrintAgent: vi.fn(async () => {}),
  clientIp: vi.fn(() => "190.0.0.1"),
}));

const TOKEN_A = "mpa_aaaa";
const TOKEN_B = "mpa_bbbb";

const basePrinter = {
  localKey: "cocina",
  label: "Cocina",
  host: "192.168.1.50",
  port: 9100,
  station: "kitchen",
  barSubStation: null,
  paperWidthMm: 80,
  active: true,
};

async function post(token: string | null, body: unknown) {
  const { POST } = await import("./route");
  const res = await POST(
    new Request("http://localhost/api/print-agent/printers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: (await res.json()) as Record<string, never> };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.printers = [];
  h.state.seq = 0;
  h.state.subStations = new Map([
    ["rest-1", ["cócteles", "cerveza"]],
    ["rest-2", []],
  ]);
  h.state.agents = new Map([
    [TOKEN_A, { agentId: "agent-a", restaurantId: "rest-1", label: "PC cocina" }],
    [TOKEN_B, { agentId: "agent-b", restaurantId: "rest-2", label: "PC vecino" }],
  ]);
});

describe("POST /api/print-agent/printers — autenticación", () => {
  it("sin token no escribe nada", async () => {
    const { res } = await post(null, { printers: [basePrinter] });
    expect(res.status).toBe(401);
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.state.printers).toHaveLength(0);
  });

  it("con un token desconocido tampoco", async () => {
    const { res } = await post("mpa_no-existe", { printers: [basePrinter] });
    expect(res.status).toBe(401);
    expect(h.state.printers).toHaveLength(0);
  });
});

describe("POST /api/print-agent/printers — upsert por localKey", () => {
  it("crea la impresora colgada del agente y del restaurante del token", async () => {
    const { res, json } = await post(TOKEN_A, { printers: [basePrinter] });
    expect(res.status).toBe(200);
    expect((json as unknown as { printers: Row[] }).printers).toHaveLength(1);
    expect(h.state.printers).toHaveLength(1);
    expect(h.state.printers[0]).toMatchObject({
      restaurantId: "rest-1",
      agentId: "agent-a",
      localKey: "cocina",
      host: "192.168.1.50",
      port: 9100,
      station: "kitchen",
    });
  });

  it("el mismo localKey ACTUALIZA la fila: cambiar la IP no duplica", async () => {
    await post(TOKEN_A, { printers: [basePrinter] });
    const firstId = h.state.printers[0].id;

    await post(TOKEN_A, {
      printers: [{ ...basePrinter, host: "192.168.1.77", label: "Cocina 2" }],
    });

    expect(h.state.printers).toHaveLength(1);
    expect(h.state.printers[0].id).toBe(firstId);
    expect(h.state.printers[0].host).toBe("192.168.1.77");
    expect(h.state.printers[0].label).toBe("Cocina 2");
  });

  it("dos localKey distintos son dos impresoras", async () => {
    await post(TOKEN_A, {
      printers: [
        basePrinter,
        {
          ...basePrinter,
          localKey: "barra",
          label: "Barra",
          station: "bar",
          barSubStation: "cócteles",
          host: "192.168.1.51",
        },
      ],
    });
    expect(h.state.printers).toHaveLength(2);
    expect(h.state.printers.map((p) => p.localKey)).toEqual([
      "cocina",
      "barra",
    ]);
  });
});

describe("POST /api/print-agent/printers — reemplazo declarativo del set", () => {
  it("lo que no viene queda apagado, NO borrado (hay PrintJob colgando)", async () => {
    await post(TOKEN_A, {
      printers: [
        basePrinter,
        { ...basePrinter, localKey: "barra", label: "Barra", host: "192.168.1.51" },
      ],
    });
    expect(h.state.printers).toHaveLength(2);

    const { json } = await post(TOKEN_A, { printers: [basePrinter] });

    expect(h.state.printers).toHaveLength(2);
    expect(h.state.printers.find((p) => p.localKey === "cocina")!.active).toBe(
      true,
    );
    expect(h.state.printers.find((p) => p.localKey === "barra")!.active).toBe(
      false,
    );
    expect((json as unknown as { deactivated: number }).deactivated).toBe(1);
  });

  it("un set vacío apaga todas las del agente", async () => {
    await post(TOKEN_A, { printers: [basePrinter] });
    await post(TOKEN_A, { printers: [] });
    expect(h.state.printers).toHaveLength(1);
    expect(h.state.printers[0].active).toBe(false);
  });

  it("el agente puede volver a encender una impresora que había apagado", async () => {
    await post(TOKEN_A, { printers: [basePrinter] });
    await post(TOKEN_A, { printers: [] });
    await post(TOKEN_A, { printers: [basePrinter] });
    expect(h.state.printers).toHaveLength(1);
    expect(h.state.printers[0].active).toBe(true);
  });

  it("`active: false` explícito se respeta", async () => {
    await post(TOKEN_A, { printers: [{ ...basePrinter, active: false }] });
    expect(h.state.printers[0].active).toBe(false);
  });
});

describe("POST /api/print-agent/printers — validaciones antes de escribir", () => {
  it("rechaza un host que no es IP ni hostname", async () => {
    const { res, json } = await post(TOKEN_A, {
      printers: [{ ...basePrinter, host: "192.168.1.50:9100" }],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_body");
    expect(h.state.printers).toHaveLength(0);
  });

  it("rechaza un puerto fuera de rango", async () => {
    const { res } = await post(TOKEN_A, {
      printers: [{ ...basePrinter, port: 70000 }],
    });
    expect(res.status).toBe(400);
    expect(h.state.printers).toHaveLength(0);
  });

  it("rechaza una estación que no está en PrepStation", async () => {
    const { res } = await post(TOKEN_A, {
      printers: [{ ...basePrinter, station: "postres" }],
    });
    expect(res.status).toBe(400);
    expect(h.state.printers).toHaveLength(0);
  });

  it("rechaza localKey repetido dentro del mismo body", async () => {
    const { res, json } = await post(TOKEN_A, {
      printers: [basePrinter, { ...basePrinter, host: "192.168.1.99" }],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("duplicate_local_key");
    expect(h.state.printers).toHaveLength(0);
  });

  it("rechaza una sub-estación que el comercio no definió", async () => {
    const { res, json } = await post(TOKEN_A, {
      printers: [
        { ...basePrinter, station: "bar", barSubStation: "jugos" },
      ],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("unknown_bar_sub_station");
    expect(h.state.printers).toHaveLength(0);
  });

  it("acepta una sub-estación que sí existe", async () => {
    const { res } = await post(TOKEN_A, {
      printers: [
        { ...basePrinter, station: "bar", barSubStation: "cócteles" },
      ],
    });
    expect(res.status).toBe(200);
    expect(h.state.printers[0].barSubStation).toBe("cócteles");
  });

  it("un body que no es JSON no escribe nada", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://localhost/api/print-agent/printers", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN_A}` },
        body: "esto no es json",
      }),
    );
    expect(res.status).toBe(400);
    expect(h.state.printers).toHaveLength(0);
  });
});

describe("POST /api/print-agent/printers — qué imprime cada impresora", () => {
  const facturaPrinter = {
    localKey: "caja",
    label: "Caja",
    host: "192.168.1.60",
    port: 9100,
    kind: "factura",
    paperWidthMm: 80,
    active: true,
  };

  it("sin `kind` queda como comanda: el agente que YA está instalado no manda ese campo", async () => {
    const { res } = await post(TOKEN_A, { printers: [basePrinter] });
    expect(res.status).toBe(200);
    expect(h.state.printers[0].kind).toBe("comanda");
    expect(h.state.printers[0].station).toBe("kitchen");
  });

  it("registra la impresora de facturas SIN estación", async () => {
    const { res } = await post(TOKEN_A, { printers: [facturaPrinter] });
    expect(res.status).toBe(200);
    expect(h.state.printers[0]).toMatchObject({
      kind: "factura",
      station: null,
      localKey: "caja",
    });
  });

  it("rechaza una de comanda SIN estación: no recibiría nunca un trabajo", async () => {
    const { res, json } = await post(TOKEN_A, {
      printers: [{ ...basePrinter, station: null }],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_station_for_kind");
    expect(
      (json as unknown as { printers: Array<{ problem: string }> }).printers[0]
        .problem,
    ).toBe("station_required");
    expect(h.state.printers).toHaveLength(0);
  });

  it("rechaza una de factura CON estación: no prepara nada", async () => {
    const { res, json } = await post(TOKEN_A, {
      printers: [{ ...facturaPrinter, station: "kitchen" }],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_station_for_kind");
    expect(
      (json as unknown as { printers: Array<{ problem: string }> }).printers[0]
        .problem,
    ).toBe("station_not_allowed");
    expect(h.state.printers).toHaveLength(0);
  });

  it("rechaza un tipo inventado", async () => {
    const { res, json } = await post(TOKEN_A, {
      printers: [{ ...basePrinter, kind: "etiquetas" }],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_body");
    expect(h.state.printers).toHaveLength(0);
  });

  it("una de factura tampoco puede apuntar a una sub-estación de barra", async () => {
    const { res, json } = await post(TOKEN_A, {
      printers: [{ ...facturaPrinter, barSubStation: "cócteles" }],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("unknown_bar_sub_station");
    expect(h.state.printers).toHaveLength(0);
  });

  it("tres de cocina, una de barra y una de caja conviven en el mismo set", async () => {
    const { res } = await post(TOKEN_A, {
      printers: [
        { ...basePrinter, localKey: "cocina1", host: "192.168.1.51" },
        { ...basePrinter, localKey: "cocina2", host: "192.168.1.52" },
        { ...basePrinter, localKey: "cocina3", host: "192.168.1.53" },
        {
          ...basePrinter,
          localKey: "barra",
          station: "bar",
          barSubStation: "cócteles",
          host: "192.168.1.54",
        },
        facturaPrinter,
      ],
    });
    expect(res.status).toBe(200);
    expect(h.state.printers).toHaveLength(5);
    expect(h.state.printers.filter((p) => p.kind === "comanda")).toHaveLength(4);
    expect(h.state.printers.filter((p) => p.kind === "factura")).toHaveLength(1);
  });
});

describe("POST /api/print-agent/printers — aislamiento multi-tenant", () => {
  it("el token del vecino no toca las impresoras del otro comercio", async () => {
    await post(TOKEN_A, { printers: [basePrinter] });
    // Mismo localKey, otro token: es OTRA impresora, de otro comercio.
    await post(TOKEN_B, {
      printers: [{ ...basePrinter, label: "Cocina vecina", host: "10.0.0.9" }],
    });

    expect(h.state.printers).toHaveLength(2);
    const mine = h.state.printers.find((p) => p.restaurantId === "rest-1")!;
    const theirs = h.state.printers.find((p) => p.restaurantId === "rest-2")!;
    expect(mine.agentId).toBe("agent-a");
    expect(mine.label).toBe("Cocina");
    expect(mine.host).toBe("192.168.1.50");
    expect(theirs.agentId).toBe("agent-b");
    expect(theirs.label).toBe("Cocina vecina");
  });

  it("el reemplazo del set del vecino NO apaga las del otro comercio", async () => {
    await post(TOKEN_A, { printers: [basePrinter] });
    await post(TOKEN_B, { printers: [basePrinter] });

    // El vecino se queda sin impresoras.
    await post(TOKEN_B, { printers: [] });

    expect(
      h.state.printers.find((p) => p.restaurantId === "rest-1")!.active,
    ).toBe(true);
    expect(
      h.state.printers.find((p) => p.restaurantId === "rest-2")!.active,
    ).toBe(false);
  });

  it("el `updateMany` de apagado siempre lleva restaurantId y agentId", async () => {
    await post(TOKEN_A, { printers: [basePrinter] });
    const call = h.db.printer.updateMany.mock.calls.at(-1)![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({
      agentId: "agent-a",
      restaurantId: "rest-1",
    });
  });

  it("las sub-estaciones se validan contra el restaurante del TOKEN", async () => {
    // rest-2 no tiene sub-estaciones definidas: "cócteles" es válido
    // para el vecino y no para éste.
    const { res, json } = await post(TOKEN_B, {
      printers: [
        { ...basePrinter, station: "bar", barSubStation: "cócteles" },
      ],
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe("unknown_bar_sub_station");
  });
});
