import { describe, expect, it, vi } from "vitest";
vi.mock("./payments/kushki/cloudTerminal", () => ({}));
import {
  embeddedTaxOf,
  formatInvoiceNumber,
  frozenSalesTax,
  renderInvoiceEmail,
  taxRows,
  type InvoiceSnapshot,
  type TaxRowLabels,
} from "./invoice";
import { getEmailTranslator } from "./emailIntl";
import { buildThermalInvoice } from "./print/invoiceDoc";
import { renderInvoice } from "./escpos/invoice";
import { columnsForWidth } from "./escpos/commands";
import { buildInvoiceCommands } from "./payments/kushki/cloudPrint";

const LABELS: TaxRowLabels = {
  inc: "Impoconsumo",
  iva: "IVA",
  other: "Impuestos",
  base: "Base gravable",
  incIncluded: (pct) => `Incl. impoconsumo ${pct}%`,
  ivaIncluded: (pct) => `Incl. IVA ${pct}%`,
};

// Bandeja de $30.000 con INC 8% embebido, repartida como el XML:
// base 27.777,78 + impuesto 2.222,22.
const INC_8 = {
  salesTaxKind: "inc" as const,
  salesTaxPct: 8,
  embeddedTaxCents: 222_222,
  embeddedBaseCents: 2_777_778,
  subtotalCents: 3_000_000,
  totalCents: 3_000_000,
};

/** Snapshot mínimo: `taxRows` sólo mira los campos de impuesto. */
function snap(tax: Partial<InvoiceSnapshot>): InvoiceSnapshot {
  return {
    restaurantName: "Test",
    logoUrl: null,
    legalName: null,
    taxId: null,
    legalAddress: null,
    legalPhone: null,
    dianResolution: null,
    dianResolutionFrom: null,
    dianResolutionTo: null,
    dianResolutionDate: null,
    invoicePrefix: null,
    shortCode: "T-1000",
    tableLabel: "Mesa 1",
    paidAtIso: "2026-01-01T00:00:00.000Z",
    items: [],
    subtotalCents: 0,
    tipCents: 0,
    totalCents: 0,
    ...tax,
  };
}

// Datos reales de Son & Melona: prefijo FESM, rango 1..10000, consecutivo
// 6482. El número se armaba como "FESM-06482" y la DIAN devolvía DOS
// rechazos por el mismo bug — FAD05a (guión) y FAD05b (le quita el
// prefijo declarado y "-06482" no le cabe en 1..10000).
describe("formatInvoiceNumber", () => {
  const sonYMelona = {
    invoicePrefix: "FESM",
    dianResolutionFrom: 1,
    dianResolutionTo: 10000,
  } as const;

  it("el caso real: prefijo y consecutivo pegados, sin guión ni relleno", () => {
    expect(formatInvoiceNumber(snap(sonYMelona), 6482)).toBe("FESM6482");
  });

  it("FAD05a: ningún guión, espacio ni caracter de más", () => {
    const n = formatInvoiceNumber(snap(sonYMelona), 6482);
    expect(n).toMatch(/^[A-Z0-9]+$/);
    expect(n).not.toContain("-");
  });

  it("FAD05b: quitando el prefijo queda un consecutivo dentro del rango", () => {
    const n = formatInvoiceNumber(snap(sonYMelona), 6482);
    const consecutivo = Number(n.slice("FESM".length));
    expect(consecutivo).toBe(6482);
    expect(consecutivo).toBeGreaterThanOrEqual(1);
    expect(consecutivo).toBeLessThanOrEqual(10000);
  });

  it("sin prefijo es el consecutivo pelado", () => {
    expect(
      formatInvoiceNumber(snap({ dianResolutionTo: 10000 }), 6482),
    ).toBe("6482");
  });

  it("sin resolución cargada tampoco se rellena", () => {
    // Antes el ancho salía de dianResolutionTo; ya no se usa para nada.
    expect(formatInvoiceNumber(snap({ invoicePrefix: "FESM" }), 42)).toBe(
      "FESM42",
    );
    expect(formatInvoiceNumber(snap({}), 42)).toBe("42");
  });

  it("el rango no cambia el ancho del número", () => {
    for (const to of [null, 5000, 10000, 999_999_999]) {
      expect(
        formatInvoiceNumber(snap({ invoicePrefix: "FE", dianResolutionTo: to }), 42),
      ).toBe("FE42");
    }
  });
});

describe("taxRows", () => {
  it("una cuenta sólo de menú no muestra ninguna fila", () => {
    // El impuesto de los platos va EMBEBIDO en el precio y ya está contado
    // dentro del subtotal: una fila aparte haría parecer que se cobra dos
    // veces.
    expect(taxRows(snap({}), LABELS)).toEqual([]);
    expect(
      taxRows(snap({ taxCents: 0, taxByKind: { inc: 0, iva: 0 } }), LABELS),
    ).toEqual([]);
  });

  it("un servicio con IVA encima sale como su propia fila", () => {
    const rows = taxRows(
      snap({ taxCents: 456_000_00, taxByKind: { inc: 0, iva: 456_000_00 } }),
      LABELS,
    );
    expect(rows).toEqual([{ label: "IVA", cents: 456_000_00 }]);
  });

  it("desglosa cuando la cuenta mezcla impoconsumo e IVA", () => {
    // El punto entero de las líneas libres: un restaurante que cobra
    // impoconsumo factura un servicio con IVA en la misma cuenta.
    const rows = taxRows(
      snap({ taxCents: 30_000, taxByKind: { inc: 8_000, iva: 22_000 } }),
      LABELS,
    );
    expect(rows).toEqual([
      { label: "Impoconsumo", cents: 8_000 },
      { label: "IVA", cents: 22_000 },
    ]);
  });

  it("una factura vieja sin desglose muestra el total en una fila genérica", () => {
    // Back-compat: snapshots emitidos antes del desglose sólo tienen el
    // total. Igual tiene que cuadrar subtotal + impuesto + propina = total.
    const rows = taxRows(snap({ taxCents: 19_000 }), LABELS);
    expect(rows).toEqual([{ label: "Impuestos", cents: 19_000 }]);
  });

  it("si el desglose no cubre el total, el resto va a la fila genérica", () => {
    const rows = taxRows(
      snap({ taxCents: 30_000, taxByKind: { inc: 0, iva: 22_000 } }),
      LABELS,
    );
    expect(rows).toEqual([
      { label: "IVA", cents: 22_000 },
      { label: "Impuestos", cents: 8_000 },
    ]);
  });
});


const tipNoticeTitle = "ADVERTENCIA DE PROPINA";
const tipNoticeBody = "POR DISPOSICION DE LA SUPERINTENDENCIA DE INDUSTRIA Y COMERCIO SE INFORMA QUE LA PROPINA ES SUGUERIDA AL CONSUMIDOR LA CUAL PODRA SER ACEPTADA, RECHAZADA O MODIFICADO POR USTED, DE ACUERDO CON SU VALORACION DEL SERVICIO PRESTADO.";
const invoiceUrl = "https://mesapay.co/factura/test";

describe("advertencia de propina — documento completo", () => {
  it.each([0, 10_000])("con propina %i conserva el texto solicitado en ambos formatos del correo", async (tipCents) => {
    const email = await renderInvoiceEmail({
      snapshot: snap({ tipCents }), invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    for (const output of [email.html, email.text]) {
      expect(output).toContain(tipNoticeTitle);
      expect(output).toContain(tipNoticeBody);
      expect(output.split(tipNoticeTitle)).toHaveLength(2);
    }
  });

  it.each(["es", "en", "pt"])("correo y tirilla usan traducciones reales en %s", async (locale) => {
    const { t } = await getEmailTranslator(locale, "emailInvoice");
    const title = t("tipNoticeTitle");
    const body = t("tipNoticeBody");
    expect(title).not.toContain("tipNoticeTitle");
    expect(body).not.toContain("tipNoticeBody");
    expect(body.length).toBeGreaterThan(100);
    const email = await renderInvoiceEmail({ snapshot: snap({}), invoiceNumber: 1, invoiceUrl, locale });
    const doc = buildThermalInvoice({
      snapshot: snap({}), invoiceNumber: 1, paperWidthMm: 80,
      paidAtLabel: "01/01/26", dianResolutionDateLabel: null, payments: [], money: String, t,
    });
    const commands = buildInvoiceCommands(snap({}), 1, invoiceUrl, t);
    const cloudText = commands.flatMap((command) => command.type === "text" ? [command.text] : []).join("\n").replace(/\s+/g, " ");
    for (const output of [email.html, email.text, doc.footerLines.join("\n"), cloudText]) {
      expect(output).toContain(title);
      expect(output).toContain(body);
    }
  });

  it.each([58, 80])("la tirilla de %imm imprime todas las palabras, sin cortar líneas", async (paperWidthMm) => {
    const { t } = await getEmailTranslator("es", "emailInvoice");
    const doc = buildThermalInvoice({
      snapshot: snap({}), invoiceNumber: 1, paperWidthMm,
      paidAtLabel: "01/01/26", dianResolutionDateLabel: null, payments: [], money: String, t,
    });
    expect(doc.footerLines).toContain(tipNoticeTitle);
    expect(doc.footerLines).toContain(tipNoticeBody);
    // El aviso es ASCII: retiramos únicamente los comandos ESC/POS del papel.
    const paper = renderInvoice(doc).toString("latin1")
      .replace(/\x1b@/g, "")
      .replace(/\x1b[taEd][\s\S]/g, "")
      .replace(/\x1d![\s\S]/g, "")
      .replace(/\x1dV[\s\S]{2}/g, "");
    expect(paper.replace(/\s+/g, " ")).toContain(tipNoticeTitle + " " + tipNoticeBody);
    for (const line of paper.split("\n")) expect(line.length).toBeLessThanOrEqual(columnsForWidth(paperWidthMm));
  });

  it.each([0, 10_000])("el datáfono recibe el aviso completo incluso con propina %i", (tipCents) => {
    const commands = buildInvoiceCommands(snap({ tipCents }), 1, invoiceUrl);
    const text = commands.flatMap((command) => command.type === "text" ? [command.text] : []).join("\n");
    expect(text.replace(/\s+/g, " ")).toContain(tipNoticeTitle + " " + tipNoticeBody);
    expect(text.split(tipNoticeTitle)).toHaveLength(2);
    expect(commands.at(-1)?.type).toBe("cut");
  });
});

describe("taxRows — impuesto EMBEBIDO congelado en la factura", () => {
  it("una cuenta de menú con impoconsumo muestra la base y el impuesto incluido", () => {
    // Lo que el dueño reclamó: el XML aceptado dice "INC 8%: $2.222" y el
    // papel no decía nada. Ahora el papel lo discrimina, informativo (ya
    // está dentro del subtotal, no se suma al total).
    expect(taxRows(snap(INC_8), LABELS)).toEqual([
      { label: "Base gravable", cents: 2_777_778 },
      { label: "Incl. impoconsumo 8%", cents: 222_222 },
    ]);
  });

  it("primero el embebido y después el que suman encima las líneas libres", () => {
    const rows = taxRows(
      snap({ ...INC_8, taxCents: 190_000, taxByKind: { inc: 0, iva: 190_000 } }),
      LABELS,
    );
    expect(rows).toEqual([
      { label: "Base gravable", cents: 2_777_778 },
      { label: "Incl. impoconsumo 8%", cents: 222_222 },
      { label: "IVA", cents: 190_000 },
    ]);
  });

  it("un comercio con IVA embebido lo nombra con su tarifa", () => {
    const rows = taxRows(
      snap({
        salesTaxKind: "iva",
        salesTaxPct: 19,
        embeddedTaxCents: 159_664,
        embeddedBaseCents: 840_336,
      }),
      LABELS,
    );
    expect(rows).toEqual([
      { label: "Base gravable", cents: 840_336 },
      { label: "Incl. IVA 19%", cents: 159_664 },
    ]);
  });

  it("emitida con el comercio en 'none' ⇒ ninguna fila, aunque los campos existan", () => {
    expect(
      taxRows(
        snap({ salesTaxKind: "none", salesTaxPct: 0, embeddedTaxCents: 0, embeddedBaseCents: 3_000_000 }),
        LABELS,
      ),
    ).toEqual([]);
  });

  it("un snapshot anterior al congelado no muestra nada: byte a byte como antes", () => {
    expect(taxRows(snap({ subtotalCents: 3_000_000 }), LABELS)).toEqual([]);
    expect(embeddedTaxOf(snap({ subtotalCents: 3_000_000 }))).toBeNull();
  });
});

describe("frozenSalesTax — la tarifa que viaja a la DIAN sale del snapshot", () => {
  it("snapshot sin tarifa ⇒ none, NUNCA la tarifa actual del comercio", () => {
    expect(frozenSalesTax({})).toEqual({ kind: "none", pct: 0 });
  });

  it("snapshot con tarifa ⇒ esa tarifa, aunque el comercio la haya cambiado", () => {
    expect(frozenSalesTax({ salesTaxKind: "inc", salesTaxPct: 8 })).toEqual({ kind: "inc", pct: 8 });
    expect(frozenSalesTax({ salesTaxKind: "iva", salesTaxPct: 19 })).toEqual({ kind: "iva", pct: 19 });
  });

  it("'none' con un porcentaje suelto sigue siendo none/0", () => {
    expect(frozenSalesTax({ salesTaxKind: "none", salesTaxPct: 8 })).toEqual({ kind: "none", pct: 0 });
  });
});

describe("el impuesto embebido sale en TODAS las superficies del snapshot", () => {
  it("correo: HTML y texto plano discriminan el impoconsumo", async () => {
    const email = await renderInvoiceEmail({
      snapshot: snap(INC_8), invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    for (const output of [email.html, email.text]) {
      expect(output).toContain("Base gravable");
      expect(output).toContain("Incl. impoconsumo 8%");
    }
    const plain = await renderInvoiceEmail({
      snapshot: snap({ subtotalCents: 3_000_000 }), invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    expect(plain.html).not.toContain("Base gravable");
    expect(plain.text).not.toContain("impoconsumo");
  });

  it("datáfono: las filas van entre el subtotal y el total, en el idioma del comensal", async () => {
    const { t } = await getEmailTranslator("es", "emailInvoice");
    const labels = (s: InvoiceSnapshot) =>
      buildInvoiceCommands(s, 1, invoiceUrl, t)
        .flatMap((c) => (c.type === "columns" ? [c.columns[0].text] : []));
    expect(labels(snap(INC_8))).toEqual([
      "Subtotal",
      "Base gravable",
      "Incl. impoconsumo 8%",
      "TOTAL",
    ]);
    expect(labels(snap({ subtotalCents: 3_000_000 }))).toEqual(["Subtotal", "TOTAL"]);
  });

  it("datáfono sin traductor cae al catálogo en español, como siempre", () => {
    const labels = buildInvoiceCommands(snap({ ...INC_8, tipCents: 10_000 }), 1, invoiceUrl)
      .flatMap((c) => (c.type === "columns" ? [c.columns[0].text] : []));
    expect(labels).toEqual(["Subtotal", "Base gravable", "Incl. impoconsumo 8%", "Propina", "TOTAL"]);
  });
});

describe("artículos repetidos AGRUPADOS en el correo y el datáfono", () => {
  const bretana = {
    qty: 1,
    name: "Bretaña",
    priceCents: 600_000,
    menuItemId: "mi-bretana",
    taxKind: null,
    taxPct: null,
    modifiers: [],
    notes: null,
  };
  const hamburguesa = {
    ...bretana,
    name: "Hamburguesa",
    priceCents: 2_800_000,
    menuItemId: "mi-hamburguesa",
  };
  // Tres rondas: dos Bretañas sueltas y una hamburguesa en otro término.
  const repeated = snap({
    items: [
      bretana,
      { ...hamburguesa, modifiers: ["Término: Medio"] },
      { ...bretana },
      { ...hamburguesa, modifiers: ["Término: Bien asado"], notes: "Sin cebolla" },
    ],
    subtotalCents: 6_800_000,
    totalCents: 6_800_000,
  });
  /** Las filas de ítems del HTML (las que tienen la cantidad "N×"). */
  const itemRowsOf = (html: string) =>
    (html.match(/<tr>\s*<td[^>]*>\d+×<\/td>[\s\S]*?<\/tr>/g) ?? []).map((r) =>
      r.replace(/\s+/g, " ").trim(),
    );

  it("texto plano: '2× Bretaña' una vez, y cada hamburguesa con su término colgado", async () => {
    const { text } = await renderInvoiceEmail({
      snapshot: repeated, invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l.startsWith("2× Bretaña"));
    expect(lines.slice(start, start + 6)).toEqual([
      "2× Bretaña  $12.000",
      "1× Hamburguesa  $28.000",
      "   - Término: Medio",
      "1× Hamburguesa  $28.000",
      "   - Término: Bien asado",
      '   "Sin cebolla"',
    ]);
    expect(text).not.toContain("1× Bretaña");
  });

  it("HTML: una fila por artículo agrupado (snapshot)", async () => {
    const { html } = await renderInvoiceEmail({
      snapshot: repeated, invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    const rows = itemRowsOf(html);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(">2×</td>");
    expect(rows[0]).toContain("$12.000");
    expect(rows[2]).toContain("&quot;Sin cebolla&quot;");
    expect(rows).toMatchSnapshot();
  });

  it("los importes agrupados del correo suman el subtotal del snapshot al centavo", async () => {
    const { text } = await renderInvoiceEmail({
      snapshot: repeated, invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    const amounts = text
      .split("\n")
      .filter((l) => /^\d+× /.test(l))
      .map((l) => Number(l.split("$")[1].replace(/\./g, "")) * 100);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(repeated.subtotalCents);
  });

  it("un snapshot viejo (sólo qty, nombre y precio) también se agrupa, sin renglones colgados", async () => {
    const old = snap({
      items: [
        { qty: 1, name: "Limonada de coco", priceCents: 1_200_000 },
        { qty: 2, name: "Limonada de coco", priceCents: 1_200_000 },
      ],
    });
    const { text, html } = await renderInvoiceEmail({
      snapshot: old, invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    expect(text).toContain("3× Limonada de coco  $36.000");
    expect(itemRowsOf(html)).toHaveLength(1);
    expect(itemRowsOf(html)[0]).not.toContain("<div");
  });

  it("datáfono: una fila '2x Bretaña' y los términos como texto debajo de cada hamburguesa", () => {
    const commands = buildInvoiceCommands(repeated, 1, invoiceUrl);
    const start = commands.findIndex(
      (c) => c.type === "columns" && c.columns[0].text === "2x Bretaña",
    );
    const slice = commands.slice(start, start + 6).map((c) =>
      c.type === "columns"
        ? `${c.columns[0].text} | ${c.columns[1].text}`
        : c.type === "text"
          ? c.text
          : c.type,
    );
    expect(slice).toEqual([
      "2x Bretaña | $ 12.000",
      "1x Hamburguesa | $ 28.000",
      "   - Término: Medio\n",
      "1x Hamburguesa | $ 28.000",
      "   - Término: Bien asado\n",
      '   "Sin cebolla"\n',
    ]);
  });
});
