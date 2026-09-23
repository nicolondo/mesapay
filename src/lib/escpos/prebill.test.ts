import { describe, expect, it } from "vitest";
import { buildPrebillData, type PrebillData } from "@/lib/prebill";
import { CP850_HIGH } from "./codepage";
import { INVOICE_PAYLOAD_VERSION, type ThermalInvoice } from "./invoice";
import { renderPrintJobPayload } from "./job";
import {
  PREBILL_JOB_KIND,
  PREBILL_PAYLOAD_VERSION,
  buildPrebillTicket,
  parsePrebillPayload,
  renderPrebill,
  type ThermalPrebill,
} from "./prebill";

/**
 * Igual que en `invoice.test.ts`: los snapshots guardan el HEX de la
 * tirilla completa — es la única forma de enterarse de que alguien movió
 * un comando ESC/POS sin querer. Y `readable` decodifica el papel como se
 * vería impreso, sacando los comandos conocidos; uno desconocido revienta.
 */
function hex(doc: ThermalPrebill): string {
  return renderPrebill(doc).toString("hex");
}

function readable(doc: ThermalPrebill): string {
  const b = renderPrebill(doc);
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

// ── buildPrebillTicket: del dato puro al documento ─────────────────────

/** El traductor devuelve la clave (con sus valores): lo que se prueba es QUÉ filas salen. */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join("|")})` : key;
const money = (cents: number) => `$${Math.round(cents / 100)}`;

const data: PrebillData = {
  businessName: "Inversiones Chucho S.A.S.",
  taxId: "900.123.456-7",
  legalAddress: "Calle 12 #4-56",
  legalCity: "Medellín",
  legalPhone: "604 444 5566",
  shortCode: "A4F2",
  destination: { kind: "table", number: 7, label: "Terraza" },
  waiterName: "Carlos",
  issuedAt: new Date("2026-09-18T19:41:00.000Z"),
  lines: [
    {
      qty: 2,
      name: "Bandeja paisa",
      unitCents: 2_450_000,
      lineCents: 4_900_000,
      modifiers: ["Término: Medio"],
      notes: "sin cebolla",
      guestName: null,
    },
    {
      qty: 1,
      name: "Limonada de coco",
      unitCents: 1_200_000,
      lineCents: 1_200_000,
      modifiers: [],
      notes: null,
      guestName: null,
    },
  ],
  grossSubtotalCents: 6_100_000,
  discountPct: null,
  discountCents: 0,
  netSubtotalCents: 6_100_000,
  embeddedTax: { kind: "inc", pct: 8, taxCents: 451_852, baseCents: 5_648_148 },
  taxOnTop: { inc: 0, iva: 0 },
  taxOnTopCents: 0,
  totalCents: 6_100_000,
  paidCents: 0,
  outstandingCents: 6_100_000,
  suggestedTipPct: 10,
  suggestedTipCents: 610_000,
  totalWithTipCents: 6_710_000,
};

const build = (over: Partial<PrebillData> = {}, paperWidthMm = 80) =>
  buildPrebillTicket({
    data: { ...data, ...over },
    paperWidthMm,
    dateLabel: "18/09/26, 14:41",
    money,
    t,
  });

describe("buildPrebillTicket — encabezado", () => {
  it("rótulo y aviso salen del catálogo de la tirilla", () => {
    const doc = build();
    expect(doc.title).toBe("prebillTitle");
    expect(doc.notInvoiceLine).toBe("prebillNotInvoice");
    expect(doc.paperWidthMm).toBe(80);
  });

  it("identidad del comercio: sólo los renglones cargados", () => {
    expect(build().businessLines).toEqual([
      "taxId(900.123.456-7)",
      "Calle 12 #4-56",
      "Medellín",
      "phone(604 444 5566)",
    ]);
    expect(build({ taxId: null, legalPhone: null, legalCity: null }).businessLines).toEqual([
      "Calle 12 #4-56",
    ]);
  });

  it("fecha, mesa con etiqueta y código, y el mesero si se conoce", () => {
    expect(build().metaRows).toEqual([
      { label: "date", value: "18/09/26, 14:41" },
      { label: "prebillTable(7) · Terraza", value: "A4F2" },
      { label: "prebillWaiter", value: "Carlos" },
    ]);
    expect(build({ waiterName: null }).metaRows).toHaveLength(2);
  });

  it("recoger lleva el nombre; factura manual su etiqueta y nunca un número interno", () => {
    expect(build({ destination: { kind: "pickup", name: "Ana" } }).metaRows[1].label).toBe(
      "prebillPickup(Ana)",
    );
    expect(build({ destination: { kind: "pickup", name: null } }).metaRows[1].label).toBe(
      "prebillPickup(A4F2)",
    );
    expect(build({ destination: { kind: "manual", label: "Factura manual" } }).metaRows[1].label).toBe(
      "Factura manual",
    );
    expect(build({ destination: { kind: "manual", label: null } }).metaRows[1].label).toBe("A4F2");
  });

  it("el código de la cuenta va corto (primer grupo), como en la comanda y la factura", () => {
    const doc = build({ shortCode: "002A77-77C496-58E6EF-6C25C8" });
    expect(doc.metaRows[1].value).toBe("002A77");
    expect(
      build({ shortCode: "002A77-77C496-58E6EF-6C25C8", destination: { kind: "pickup", name: null } })
        .metaRows[1].label,
    ).toBe("prebillPickup(002A77)");
  });
});

describe("buildPrebillTicket — ítems", () => {
  it("importe de línea, unitario sólo con qty > 1, modificadores y nota", () => {
    expect(build().items).toEqual([
      {
        qty: 2,
        name: "Bandeja paisa",
        amount: "$49000",
        unit: "$24500",
        modifiers: ["Término: Medio"],
        notes: "sin cebolla",
      },
      {
        qty: 1,
        name: "Limonada de coco",
        amount: "$12000",
        unit: null,
        modifiers: [],
        notes: null,
      },
    ]);
  });
});

describe("buildPrebillTicket — totales", () => {
  it("subtotal, base + impuesto incluido y TOTAL, en ese orden y con el mismo texto que la factura", () => {
    expect(build().totals).toEqual([
      { label: "subtotal", amount: "$61000" },
      { label: "taxBase", amount: "$56481" },
      { label: "taxIncIncluded(8)", amount: "$4519" },
      { label: "total", amount: "$61000", strong: true },
    ]);
  });

  it("IVA embebido usa su propia etiqueta", () => {
    const doc = build({
      embeddedTax: { kind: "iva", pct: 19, taxCents: 1, baseCents: 1 },
    });
    expect(doc.totals.map((r) => r.label)).toContain("taxIvaIncluded(19)");
  });

  it("sin impuesto embebido: subtotal y TOTAL nada más", () => {
    expect(build({ embeddedTax: null }).totals.map((r) => r.label)).toEqual(["subtotal", "total"]);
  });

  it("el descuento va con signo menos, con % si lo hay", () => {
    const con = build({ discountPct: 10, discountCents: 610_000 });
    expect(con.totals).toContainEqual({ label: "discountRowPct(10)", amount: "-$6100" });
    const sin = build({ discountPct: null, discountCents: 300_000 });
    expect(sin.totals).toContainEqual({ label: "discountRow", amount: "-$3000" });
  });

  it("el impuesto sumado encima por las líneas libres sale por tipo", () => {
    const doc = build({ taxOnTop: { inc: 0, iva: 1_900_000 }, taxOnTopCents: 1_900_000 });
    expect(doc.totals).toContainEqual({ label: "taxIva", amount: "$19000" });
    expect(doc.totals.map((r) => r.label)).not.toContain("taxInc");
  });

  it("con pagos parciales: pagado con menos y PENDIENTE en grande, después del TOTAL", () => {
    const doc = build({ paidCents: 2_000_000, outstandingCents: 4_100_000 });
    const labels = doc.totals.map((r) => r.label);
    expect(labels.slice(-3)).toEqual(["total", "prebillPaid", "prebillOutstanding"]);
    expect(doc.totals).toContainEqual({ label: "prebillPaid", amount: "-$20000" });
    expect(doc.totals[doc.totals.length - 1]).toMatchObject({ amount: "$41000", strong: true });
  });

  it("sin pagos, el TOTAL es la única fila fuerte", () => {
    expect(build().totals.filter((r) => r.strong)).toHaveLength(1);
  });
});

describe("buildPrebillTicket — propina sugerida", () => {
  it("bloque aparte: sugerida, total con propina y el aviso de que es voluntaria", () => {
    const doc = build();
    expect(doc.tipRows).toEqual([
      { label: "prebillSuggestedTip(10)", amount: "$6100" },
      { label: "prebillTotalWithTip", amount: "$67100" },
    ]);
    expect(doc.tipNotice).toBe("prebillTipVoluntary");
  });

  it("cuenta cubierta ⇒ sin bloque de propina", () => {
    const doc = build({ outstandingCents: 0, suggestedTipCents: 0, totalWithTipCents: 0 });
    expect(doc.tipRows).toEqual([]);
    expect(doc.tipNotice).toBeNull();
  });

  it("el pie agradece y nada más", () => {
    expect(build().footerLines).toEqual(["thanks"]);
  });
});

// ── renderPrebill: del documento a los bytes ───────────────────────────

const base: ThermalPrebill = {
  paperWidthMm: 80,
  businessName: "DONDE CHUCHO S.A.S.",
  businessLines: ["NIT 900.123.456-7", "Calle 12 #4-56", "Medellín"],
  title: "PRECUENTA",
  notInvoiceLine: "Este documento no es una factura",
  metaRows: [
    { label: "Fecha", value: "18/09/26, 14:41" },
    { label: "Mesa 7", value: "A4F2" },
    { label: "Mesero", value: "Carlos" },
  ],
  items: [
    {
      qty: 2,
      name: "Bandeja paisa",
      amount: "$ 49.000",
      unit: "$ 24.500",
      modifiers: ["Término: Medio"],
      notes: "sin cebolla",
    },
    { qty: 1, name: "Limonada de coco", amount: "$ 12.000", unit: null, modifiers: [], notes: null },
  ],
  totals: [
    { label: "Subtotal", amount: "$ 61.000" },
    { label: "Base gravable", amount: "$ 56.481" },
    { label: "Incl. impoconsumo 8%", amount: "$ 4.519" },
    { label: "TOTAL", amount: "$ 61.000", strong: true },
  ],
  tipRows: [
    { label: "Propina sugerida 10%", amount: "$ 6.100" },
    { label: "Total con propina", amount: "$ 67.100" },
  ],
  tipNotice: "La propina es voluntaria: podés aceptarla, rechazarla o cambiarla.",
  footerLines: ["¡Gracias por tu visita!"],
};

describe("renderPrebill — bytes", () => {
  it("abre con reset + code page CP850", () => {
    expect(renderPrebill(base).subarray(0, 5).toString("hex")).toBe("1b401b7402");
  });

  it("cierra con CORTE PARCIAL, no total", () => {
    // ESC d 4 + GS V 66 4 + LF: el 0x42 es el corte parcial que deja la
    // pestañita; si alguien lo cambia a 0x41 (total), este test lo canta.
    expect(renderPrebill(base).subarray(-8).toString("hex")).toBe("1b64041d5642040a");
  });

  it("snapshot de bytes 80mm", () => {
    expect(hex(base)).toMatchSnapshot();
  });

  it("snapshot de bytes 58mm", () => {
    expect(hex({ ...base, paperWidthMm: 58 })).toMatchSnapshot();
  });
});

describe("renderPrebill — lo que se lee en el papel", () => {
  it("dice PRECUENTA y que no es una factura, y NO trae nada de la factura", () => {
    const paper = readable(base);
    expect(paper).toContain("PRECUENTA");
    expect(paper).toContain("Este documento no es una factura");
    expect(paper).not.toContain("Resolución");
    expect(paper).not.toContain("Forma de pago");
  });

  it("ítems con importe pegado a la derecha y los colgados con sangría", () => {
    const lines = readable(base).split("\n");
    const bandeja = lines.find((l) => l.startsWith("2x Bandeja paisa"))!;
    expect(bandeja).toHaveLength(48);
    expect(bandeja.endsWith("$ 49.000")).toBe(true);
    expect(lines).toContain("   2 x $ 24.500");
    expect(lines).toContain("   - Término: Medio");
    expect(lines).toContain('   "sin cebolla"');
    // Sin unitario cuando qty = 1.
    expect(lines.some((l) => l.includes("1 x $ 12.000"))).toBe(false);
  });

  it("totales y propina sugerida, separados", () => {
    const paper = readable(base);
    expect(paper).toContain("Incl. impoconsumo 8%");
    expect(paper).toContain("TOTAL");
    expect(paper).toContain("Propina sugerida 10%");
    expect(paper).toContain("Total con propina");
    expect(paper).toContain("voluntaria");
    expect(paper).toContain("¡Gracias por tu visita!");
    // Un separador entre el TOTAL y la propina: no están sumados.
    const i = paper.indexOf("TOTAL");
    const j = paper.indexOf("Propina sugerida");
    expect(paper.slice(i, j)).toContain("-".repeat(48));
  });

  it("los montos quedan pegados al borde derecho", () => {
    for (const l of readable(base).split("\n")) {
      // Los colgados con sangría (el unitario "2 x $ 24.500") van a la
      // izquierda a propósito: son detalle, no un monto de la columna.
      if (l.includes("$") && !l.startsWith("   ")) expect(l).toHaveLength(48);
    }
  });

  it("en 58mm nada se pasa de 32 columnas (la térmica trunca, no envuelve)", () => {
    for (const l of readable({ ...base, paperWidthMm: 58 }).split("\n")) {
      expect(l.length).toBeLessThanOrEqual(32);
    }
  });

  it("ñ y tildes sobreviven el viaje por CP850", () => {
    const paper = readable(base);
    expect(paper).toContain("Medellín");
    expect(paper).toContain("Término");
    expect(paper).not.toContain("?");
  });

  it("sin propina ni pie no imprime esos bloques", () => {
    const paper = readable({ ...base, tipRows: [], tipNotice: null, footerLines: [] });
    expect(paper).not.toContain("Propina");
    expect(paper).not.toContain("Gracias");
  });
});

describe("parsePrebillPayload", () => {
  const payload = { v: PREBILL_PAYLOAD_VERSION, prebill: base };

  it("acepta el sobre bien formado, ida y vuelta", () => {
    expect(parsePrebillPayload(payload)).toEqual(base);
    expect(PREBILL_JOB_KIND).toBe("prebill");
  });

  it("rechaza otra versión, basura y los sobres de comanda y factura", () => {
    expect(parsePrebillPayload({ v: 99, prebill: base })).toBeNull();
    expect(parsePrebillPayload(null)).toBeNull();
    expect(parsePrebillPayload("precuenta")).toBeNull();
    expect(parsePrebillPayload({ v: 1, ticket: {} })).toBeNull();
    expect(parsePrebillPayload({ v: 1, invoice: {} })).toBeNull();
  });

  it("rechaza un ítem sin monto: imprimir una precuenta coja es peor que no imprimir", () => {
    expect(
      parsePrebillPayload({
        v: PREBILL_PAYLOAD_VERSION,
        prebill: { ...base, items: [{ qty: 1, name: "Café" }] },
      }),
    ).toBeNull();
  });

  it("tolera los bloques opcionales ausentes", () => {
    const parsed = parsePrebillPayload({
      v: PREBILL_PAYLOAD_VERSION,
      prebill: {
        paperWidthMm: 58,
        businessName: "Café",
        title: "PRECUENTA",
        notInvoiceLine: "No es factura",
        items: [],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.totals).toEqual([]);
    expect(parsed!.tipRows).toEqual([]);
    expect(parsed!.tipNotice).toBeNull();
    expect(parsed!.footerLines).toEqual([]);
  });
});

describe("renderPrintJobPayload — la precuenta es el tercer documento", () => {
  it("una precuenta se renderiza como precuenta", () => {
    const bytes = renderPrintJobPayload({ v: PREBILL_PAYLOAD_VERSION, prebill: base })!;
    expect(bytes).not.toBeNull();
    expect(bytes.includes(Buffer.from("PRECUENTA"))).toBe(true);
  });

  it("una factura sigue siendo factura", () => {
    const invoice: ThermalInvoice = {
      paperWidthMm: 80,
      businessName: "X",
      businessLines: [],
      documentLabel: "Comprobante",
      documentNumber: "FE-0042",
      metaRows: [],
      customerLines: [],
      items: [],
      totals: [],
      paymentTitle: null,
      paymentRows: [],
      footerLines: [],
    };
    const bytes = renderPrintJobPayload({ v: INVOICE_PAYLOAD_VERSION, invoice })!;
    expect(bytes.includes(Buffer.from("FE-0042"))).toBe(true);
  });

  it("un payload corrupto sigue devolviendo null", () => {
    expect(renderPrintJobPayload({ v: 1, cosa: {} })).toBeNull();
  });
});

describe("precuenta con artículos repetidos — de la cuenta al papel, AGRUPADOS", () => {
  it("dos Bretañas de dos rondas salen como '2x Bretaña' con su unitario colgado", () => {
    const bretana = {
      qty: 1,
      menuItemId: "mi-bretana",
      nameSnapshot: "Bretaña",
      priceCentsSnapshot: 600_000,
      taxKind: null,
      taxPct: null,
      cancelledAt: null,
      round: { status: "placed" },
    };
    const d = buildPrebillData(
      {
        shortCode: "A4F2",
        orderType: "dineIn",
        discountPct: null,
        discountCents: 0,
        table: { number: 7, label: null, kind: "standard" },
        items: [bretana, { ...bretana }],
        payments: [],
      },
      {
        name: "Donde Chucho",
        legalName: null,
        taxId: null,
        legalAddress: null,
        legalCity: null,
        legalPhone: null,
        salesTaxKind: "none",
        salesTaxPct: 0,
      },
      { now: new Date("2026-09-18T19:41:00.000Z") },
    );
    const doc = buildPrebillTicket({
      data: d,
      paperWidthMm: 80,
      dateLabel: "18/09/26, 14:41",
      money,
      t,
    });
    const lines = readable(doc).split("\n");
    const bretanas = lines.filter((l) => l.includes("Bretaña"));
    expect(bretanas).toHaveLength(1);
    expect(bretanas[0]).toMatch(/^2x Bretaña +\$12000$/);
    expect(bretanas[0]).toHaveLength(48);
    expect(lines).toContain("   2 x $6000");
    expect(hex(doc)).toMatchSnapshot();
  });
});
