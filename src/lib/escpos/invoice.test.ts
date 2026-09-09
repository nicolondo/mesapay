import { describe, expect, it } from "vitest";
import { CP850_HIGH } from "./codepage";
import { columnsForWidth, padRow } from "./commands";
import {
  INVOICE_PAYLOAD_VERSION,
  parseInvoicePayload,
  renderInvoice,
  type ThermalInvoice,
} from "./invoice";
import { renderPrintJobPayload } from "./job";
import { TICKET_PAYLOAD_VERSION, type ThermalTicket } from "./ticket";

/**
 * Igual que en `ticket.test.ts`: los snapshots guardan el HEX de la
 * tirilla completa. No son bonitos de leer y esa es la idea — es la única
 * forma de enterarse de que alguien movió un comando ESC/POS sin querer.
 * Del otro lado hay una impresora en una caja que no podemos depurar.
 */
function hex(inv: ThermalInvoice): string {
  return renderInvoice(inv).toString("hex");
}

/**
 * Decodifica la tirilla como la vería el papel: saca los comandos ESC/POS
 * conocidos y pasa el resto por CP850. Un comando que este decoder no
 * conoce revienta, así no se cuela uno nuevo sin que alguien lo mire.
 */
function readable(inv: ThermalInvoice): string {
  const b = renderInvoice(inv);
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

const base: ThermalInvoice = {
  paperWidthMm: 80,
  businessName: "DONDE CHUCHO S.A.S.",
  businessLines: ["NIT 900.123.456-7", "Calle 12 #4-56", "Medellín"],
  documentLabel: "Comprobante",
  documentNumber: "FE-0042",
  metaRows: [
    { label: "Fecha", value: "8/09/26, 19:41" },
    { label: "Mesa 7", value: "A4F2" },
  ],
  customerLines: [],
  items: [
    { qty: 2, name: "Bandeja paisa", amount: "$ 49.000" },
    { qty: 1, name: "Limonada de coco", amount: "$ 12.000" },
  ],
  totals: [
    { label: "Subtotal", amount: "$ 61.000" },
    { label: "TOTAL", amount: "$ 61.000", strong: true },
  ],
  paymentTitle: null,
  paymentRows: [],
  footerLines: ["¡Gracias por tu visita!"],
};

describe("renderInvoice — tirilla mínima", () => {
  it("abre con reset + code page CP850", () => {
    const bytes = renderInvoice(base);
    // ESC @  (reset)  +  ESC t 2 (PC850)
    expect(bytes.subarray(0, 5).toString("hex")).toBe("1b401b7402");
  });

  it("cierra con CORTE PARCIAL, no total", () => {
    const bytes = renderInvoice(base);
    // ESC d 4  +  GS V 66 4  +  LF. El 0x42 es el corte PARCIAL: deja la
    // pestañita que sostiene la tirilla hasta que el cajero la arranca.
    // Si algún día alguien lo cambia a 0x41 (total), este test lo canta.
    expect(bytes.subarray(-8).toString("hex")).toBe("1b64041d5642040a");
  });

  it("snapshot de bytes", () => {
    expect(hex(base)).toMatchSnapshot();
  });

  it("el separador ocupa las 48 columnas de 80mm", () => {
    expect(readable(base)).toContain("-".repeat(48));
    expect(readable(base)).not.toContain("-".repeat(49));
  });

  it("los montos quedan pegados al borde derecho", () => {
    for (const l of readable(base).split("\n")) {
      if (l.includes("$")) expect(l).toHaveLength(48);
    }
  });

  it("sin cliente no imprime el bloque del cliente", () => {
    expect(readable(base)).not.toContain("Cliente");
  });

  it("sin pagos no imprime el bloque de forma de pago", () => {
    const paper = readable(base);
    expect(paper).not.toContain("Forma de pago");
  });
});

describe("renderInvoice — factura nominativa, impuestos y pagos", () => {
  const completa: ThermalInvoice = {
    ...base,
    customerLines: [
      "Cliente: Inversiones Ñandú S.A.S.",
      "NIT 900.987.654-3",
      "Carrera 43A #1-50, Medellín",
    ],
    items: [
      { qty: 2, name: "Bandeja paisa con chicharrón", amount: "$ 49.000" },
      { qty: 1, name: "Ñoquis con champiñón", amount: "$ 18.000" },
      { qty: 3, name: "Limonada de coco", amount: "$ 27.000" },
    ],
    totals: [
      { label: "Subtotal", amount: "$ 94.000" },
      { label: "Impoconsumo", amount: "$ 7.520" },
      { label: "Descuento 10%", amount: "-$ 9.400" },
      { label: "Propina", amount: "$ 8.460" },
      { label: "TOTAL", amount: "$ 100.580", strong: true },
    ],
    paymentTitle: "Forma de pago",
    paymentRows: [{ label: "Efectivo", amount: "$ 100.580" }],
    footerLines: [
      "Resolución DIAN: 18764012345678",
      "Numeración del 1 al 5000",
      "¡Gracias por tu visita!",
    ],
  };

  it("snapshot de bytes", () => {
    expect(hex(completa)).toMatchSnapshot();
  });

  it("imprime los datos del cliente cuando la factura es nominativa", () => {
    const paper = readable(completa);
    expect(paper).toContain("Cliente: Inversiones Ñandú S.A.S.");
    expect(paper).toContain("NIT 900.987.654-3");
  });

  it("imprime impuesto, descuento, propina y total", () => {
    const paper = readable(completa);
    expect(paper).toContain("Impoconsumo");
    expect(paper).toContain("-$ 9.400");
    expect(paper).toContain("Propina");
    expect(paper).toContain("TOTAL");
    expect(paper).toContain("$ 100.580");
  });

  it("imprime la forma de pago y la resolución DIAN", () => {
    const paper = readable(completa);
    expect(paper).toContain("Forma de pago");
    expect(paper).toContain("Efectivo");
    expect(paper).toContain("Resolución DIAN: 18764012345678");
  });
});

describe("renderInvoice — acentos y ñ (CP850)", () => {
  const acentos: ThermalInvoice = {
    ...base,
    businessName: "CAFÉ PIÑÓN",
    businessLines: ["NIT 900.111.222-3", "Medellín · Antioquia"],
    items: [
      { qty: 1, name: "Ñoquis con champiñón", amount: "$ 32.000" },
      { qty: 2, name: "Pão de queijo com requeijão", amount: "$ 18.000" },
    ],
    footerLines: ["¡Gracias por tu visita!"],
  };

  it("snapshot de bytes", () => {
    expect(hex(acentos)).toMatchSnapshot();
  });

  it("ñ, tildes y las vocales del portugués sobreviven el viaje", () => {
    const paper = readable(acentos);
    expect(paper).toContain("CAFÉ PIÑÓN");
    expect(paper).toContain("Ñoquis con champiñón");
    expect(paper).toContain("Pão de queijo com requeijão");
    expect(paper).toContain("¡Gracias por tu visita!");
  });

  it("ningún byte queda como '?' — eso sería un carácter perdido", () => {
    expect(readable(acentos)).not.toContain("?");
  });
});

describe("renderInvoice — 58mm vs 80mm", () => {
  const largo: ThermalInvoice = {
    ...base,
    items: [
      {
        qty: 1,
        name: "Hamburguesa doble con tocineta y queso cheddar derretido",
        amount: "$ 45.000",
      },
    ],
  };

  it("snapshot de bytes 80mm", () => {
    expect(hex({ ...largo, paperWidthMm: 80 })).toMatchSnapshot();
  });

  it("snapshot de bytes 58mm", () => {
    expect(hex({ ...largo, paperWidthMm: 58 })).toMatchSnapshot();
  });

  it("en 58mm nada se pasa de 32 columnas (la térmica trunca, no envuelve)", () => {
    const paper = readable({ ...largo, paperWidthMm: 58 });
    for (const l of paper.split("\n")) expect(l.length).toBeLessThanOrEqual(32);
  });

  it("en 80mm un ítem corto entra completo en un renglón, con su monto", () => {
    const paper = readable(base);
    const l = paper.split("\n").find((x) => x.includes("Bandeja paisa"))!;
    expect(l.startsWith("2x Bandeja paisa")).toBe(true);
    expect(l.endsWith("$ 49.000")).toBe(true);
  });

  it("en 80mm el mismo nombre largo se parte en menos renglones que en 58mm", () => {
    const count = (mm: number) =>
      readable({ ...largo, paperWidthMm: mm })
        .split("\n")
        .filter((l) => l.includes("Hamburguesa") || l.includes("tocineta"))
        .length;
    expect(count(80)).toBeLessThan(count(58));
  });

  it("en 58mm el monto queda en el ÚLTIMO renglón del ítem", () => {
    const lines = readable({ ...largo, paperWidthMm: 58 }).split("\n");
    const first = lines.findIndex((x) => x.includes("Hamburguesa"));
    expect(lines[first]).not.toContain("$ 45.000");
    const withAmount = lines.slice(first).find((x) => x.includes("$ 45.000"))!;
    expect(withAmount.endsWith("$ 45.000")).toBe(true);
  });
});

describe("padRow", () => {
  it("pega el valor al borde derecho", () => {
    expect(padRow("Subtotal", "$ 61.000", 24)).toEqual([
      "Subtotal        $ 61.000",
    ]);
  });

  it("cuelga el texto largo y deja el valor en el último renglón", () => {
    const out = padRow("2x Hamburguesa doble con tocineta", "$ 45.000", 24, {
      cont: "   ",
    });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((l) => l.length <= 24)).toBe(true);
    expect(out[out.length - 1].endsWith("$ 45.000")).toBe(true);
  });

  it("un valor que no deja lugar al texto se baja a su propio renglón", () => {
    const out = padRow("TOTAL", "$ 1.234.567.890", 16);
    expect(out[out.length - 1]).toBe(" $ 1.234.567.890");
    expect(out.every((l) => l.length <= 16)).toBe(true);
  });
});

describe("parseInvoicePayload", () => {
  const payload = { v: INVOICE_PAYLOAD_VERSION, invoice: base };

  it("acepta el sobre bien formado", () => {
    expect(parseInvoicePayload(payload)?.documentNumber).toBe("FE-0042");
  });

  it("rechaza otra versión, basura y el sobre de una comanda", () => {
    expect(parseInvoicePayload({ v: 99, invoice: base })).toBeNull();
    expect(parseInvoicePayload(null)).toBeNull();
    expect(parseInvoicePayload("factura")).toBeNull();
    expect(parseInvoicePayload({ v: 1, ticket: {} })).toBeNull();
  });

  it("rechaza un ítem sin monto: imprimir una tirilla coja es peor que no imprimir", () => {
    expect(
      parseInvoicePayload({
        v: INVOICE_PAYLOAD_VERSION,
        invoice: { ...base, items: [{ qty: 1, name: "Café" }] },
      }),
    ).toBeNull();
  });

  it("tolera los bloques opcionales ausentes", () => {
    const parsed = parseInvoicePayload({
      v: INVOICE_PAYLOAD_VERSION,
      invoice: {
        paperWidthMm: 58,
        businessName: "Café",
        documentLabel: "Comprobante",
        documentNumber: "1",
        items: [],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.customerLines).toEqual([]);
    expect(parsed!.totals).toEqual([]);
    expect(parsed!.paymentTitle).toBeNull();
  });
});

describe("renderPrintJobPayload — un trabajo, dos documentos", () => {
  const ticket: ThermalTicket = {
    paperWidthMm: 80,
    stationLine: "COCINA",
    destinationLine: "MESA 7",
    metaLine: "A4F2 · R2 · 19:41",
    noticeLine: null,
    items: [
      { qty: 1, name: "Bandeja paisa", modifiers: [], notes: null, guestName: null },
    ],
    orderNote: null,
    footer: "Donde Chucho",
  };

  it("una comanda se renderiza como comanda", () => {
    const bytes = renderPrintJobPayload({ v: TICKET_PAYLOAD_VERSION, ticket })!;
    expect(bytes).not.toBeNull();
    expect(bytes.includes(Buffer.from("MESA 7"))).toBe(true);
  });

  it("una factura se renderiza como factura", () => {
    const bytes = renderPrintJobPayload({
      v: INVOICE_PAYLOAD_VERSION,
      invoice: base,
    })!;
    expect(bytes).not.toBeNull();
    expect(bytes.includes(Buffer.from("FE-0042"))).toBe(true);
  });

  it("un payload corrupto devuelve null en vez de trabar la cola", () => {
    expect(renderPrintJobPayload({ v: 1, cosa: {} })).toBeNull();
    expect(renderPrintJobPayload(undefined)).toBeNull();
  });
});

describe("columnsForWidth — la factura usa el mismo ancho que la comanda", () => {
  it("80mm son 48 columnas y 58mm son 32", () => {
    expect(columnsForWidth(80)).toBe(48);
    expect(columnsForWidth(58)).toBe(32);
  });
});
