import { describe, expect, it } from "vitest";
import { CP850_HIGH } from "./codepage";
import { columnsForWidth, wrap } from "./commands";
import {
  TICKET_PAYLOAD_VERSION,
  parseTicketPayload,
  renderTicket,
  type ThermalTicket,
} from "./ticket";

/**
 * Los snapshots guardan el HEX de la comanda completa. No son bonitos de
 * leer, y esa es la idea: es la única forma de enterarse de que alguien
 * movió un comando ESC/POS sin querer. Cuando un snapshot cambia hay que
 * mirar el diff y decidir a conciencia, porque del otro lado hay una
 * impresora en una cocina que no podemos depurar.
 */
function hex(t: ThermalTicket): string {
  return renderTicket(t).toString("hex");
}

/**
 * Decodifica la comanda como la vería el papel: saca los comandos
 * ESC/POS conocidos y pasa el resto por CP850. Si aparece un comando que
 * este decoder no conoce, revienta — así un comando nuevo no se cuela sin
 * que alguien lo mire.
 */
function readable(t: ThermalTicket): string {
  const b = renderTicket(t);
  let out = "";
  let i = 0;
  while (i < b.length) {
    const byte = b[i];
    if (byte === 0x1b) {
      const op = b[i + 1];
      if (op === 0x40) {
        i += 2;
        continue;
      }
      if (op === 0x74 || op === 0x61 || op === 0x45 || op === 0x64) {
        i += 3;
        continue;
      }
      throw new Error(`comando ESC desconocido: 0x${op.toString(16)}`);
    }
    if (byte === 0x1d) {
      const op = b[i + 1];
      if (op === 0x21) {
        i += 3;
        continue;
      }
      if (op === 0x56) {
        i += 4;
        continue;
      }
      throw new Error(`comando GS desconocido: 0x${op.toString(16)}`);
    }
    if (byte === 0x0a) {
      out += "\n";
      i += 1;
      continue;
    }
    out += byte <= 0x7e ? String.fromCharCode(byte) : CP850_HIGH[byte - 0x80];
    i += 1;
  }
  return out;
}

const base: ThermalTicket = {
  paperWidthMm: 80,
  stationLine: "COCINA",
  destinationLine: "MESA 7",
  metaLine: "A4F2 · R2 · 19:41",
  noticeLine: null,
  items: [{ qty: 1, name: "Bandeja paisa", modifiers: [], notes: null, guestName: null }],
  orderNote: null,
  footer: "Donde Chucho",
};

describe("renderTicket — ticket mínimo", () => {
  it("abre con reset + code page CP850 y cierra con corte", () => {
    const bytes = renderTicket(base);
    // ESC @  (reset)  +  ESC t 2 (PC850)
    expect(bytes.subarray(0, 5).toString("hex")).toBe("1b401b7402");
    // ESC d 4  +  GS V 66 4 (corte parcial)  +  LF
    expect(bytes.subarray(-8).toString("hex")).toBe("1b64041d5642040a");
  });

  it("snapshot de bytes", () => {
    expect(hex(base)).toMatchSnapshot();
  });

  it("el separador ocupa las 48 columnas de 80mm", () => {
    expect(readable(base)).toContain("-".repeat(48));
    expect(readable(base)).not.toContain("-".repeat(49));
  });
});

describe("renderTicket — modificadores, notas y comensal", () => {
  const rico: ThermalTicket = {
    ...base,
    metaLine: "B7K1 · R3 · 20:05",
    noticeLine: "FUERTES JUNTOS",
    items: [
      {
        qty: 2,
        name: "Hamburguesa doble",
        modifiers: ["Término: Medio", "Sin: cebolla, tomate"],
        notes: "que salga primero",
        guestName: "Ana",
      },
      {
        qty: 1,
        name: "Limonada de coco",
        modifiers: [],
        notes: null,
        guestName: null,
      },
    ],
    orderNote: "Mesa: la cuenta va separada",
  };

  it("imprime cantidad, modificadores colgados, nota entre comillas y comensal en mayúsculas", () => {
    const text = readable(rico);
    expect(text).toContain("2x Hamburguesa doble");
    expect(text).toContain("   - Término: Medio");
    expect(text).toContain("   - Sin: cebolla, tomate");
    expect(text).toContain('   "que salga primero"');
    expect(text).toContain("   ANA");
    expect(text).toContain("FUERTES JUNTOS");
    expect(text).toContain("Mesa: la cuenta va separada");
  });

  it("snapshot de bytes", () => {
    expect(hex(rico)).toMatchSnapshot();
  });
});

describe("renderTicket — 58mm vs 80mm", () => {
  const largo: ThermalTicket = {
    ...base,
    items: [
      {
        qty: 1,
        name: "Hamburguesa doble con tocineta y queso cheddar derretido",
        modifiers: [],
        notes: null,
        guestName: null,
      },
    ],
  };

  it("58mm son 32 columnas y 80mm son 48", () => {
    expect(columnsForWidth(58)).toBe(32);
    expect(columnsForWidth(80)).toBe(48);
  });

  it("el mismo plato se parte distinto según el papel", () => {
    const a80 = readable(largo);
    const a58 = readable({ ...largo, paperWidthMm: 58 });
    expect(a58).toContain("-".repeat(32));
    expect(a58).not.toContain("-".repeat(33));
    // A 58mm el nombre necesita más renglones que a 80mm.
    expect(a58.split("\n").length).toBeGreaterThan(a80.split("\n").length);
    // Ningún renglón de texto se pasa del ancho del papel.
    for (const l of a58.split("\n")) {
      expect(l.length).toBeLessThanOrEqual(32);
    }
  });

  it("snapshot de bytes 58mm", () => {
    expect(hex({ ...largo, paperWidthMm: 58 })).toMatchSnapshot();
  });

  it("snapshot de bytes 80mm", () => {
    expect(hex(largo)).toMatchSnapshot();
  });
});

describe("renderTicket — acentos y ñ", () => {
  const acentos: ThermalTicket = {
    ...base,
    stationLine: "BAR · CÓCTELES",
    destinationLine: "RECOGER · Iñaki",
    items: [
      {
        qty: 3,
        name: "Ñoquis con champiñón",
        modifiers: ["Guarnición: Plátano maduro"],
        notes: "sin ají, el niño es alérgico",
        guestName: "Muñoz",
      },
    ],
    footer: "Café Piñón",
  };

  it("no queda ni un byte de UTF-8 suelto: ñ es 0xA4, ó es 0xA2", () => {
    const bytes = renderTicket(acentos);
    expect(bytes.includes(0xa4)).toBe(true); // ñ
    expect(bytes.includes(0xa2)).toBe(true); // ó
    // 0xC3 es el primer byte de "Ã"/"Ã±" en UTF-8. En CP850 es "ã", que
    // no aparece en este ticket: si sale, es que se coló UTF-8 crudo.
    expect(bytes.includes(0xc3)).toBe(false);
  });

  it("snapshot de bytes", () => {
    expect(hex(acentos)).toMatchSnapshot();
  });
});

describe("wrap", () => {
  it("corta por espacios y cuelga la continuación con sangría", () => {
    expect(wrap("uno dos tres cuatro cinco", 12, { cont: "  " })).toEqual([
      "uno dos tres",
      "  cuatro",
      "  cinco",
    ]);
  });

  it("parte a lo bruto una palabra más larga que el renglón", () => {
    expect(wrap("supercalifragilistico", 10)).toEqual([
      "supercalif",
      "ragilistic",
      "o",
    ]);
  });

  it("un indent tan ancho como el renglón no cuelga el corte", () => {
    expect(wrap("abcdefgh", 4, { cont: "      " })).toEqual(["abcd", "efgh"]);
  });
});

describe("parseTicketPayload", () => {
  it("acepta lo que produce el encolado", () => {
    const parsed = parseTicketPayload({
      v: TICKET_PAYLOAD_VERSION,
      ticket: base,
    });
    expect(parsed?.destinationLine).toBe("MESA 7");
    expect(parsed?.items).toHaveLength(1);
  });

  it("rechaza basura sin tumbar nada", () => {
    expect(parseTicketPayload(null)).toBeNull();
    expect(parseTicketPayload({ v: 99, ticket: base })).toBeNull();
    expect(parseTicketPayload({ v: TICKET_PAYLOAD_VERSION })).toBeNull();
    expect(
      parseTicketPayload({
        v: TICKET_PAYLOAD_VERSION,
        ticket: { ...base, items: [{ qty: "dos", name: "x" }] },
      }),
    ).toBeNull();
  });
});
