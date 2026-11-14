import { describe, expect, it, vi } from "vitest";
vi.mock("./payments/kushki/cloudTerminal", () => ({}));
import {
  embeddedTaxOf,
  formatInvoiceNumber,
  frozenSalesTax,
  invoicePayableOf,
  payableRows,
  renderInvoiceEmail,
  summaryRows,
  taxRows,
  type InvoiceSnapshot,
  type SummaryRowLabels,
  type TaxRowLabels,
} from "./invoice";
import { getEmailTranslator } from "./emailIntl";
import { buildThermalInvoice } from "./print/invoiceDoc";
import { renderInvoice } from "./escpos/invoice";
import { columnsForWidth } from "./escpos/commands";
import { readPaper, rowCapacity } from "./escpos/testPaper";
import { buildInvoiceCommands } from "./payments/kushki/cloudPrint";

const LABELS: TaxRowLabels = {
  inc: "Impoconsumo",
  iva: "IVA",
  other: "Impuestos",
  base: "Base gravable",
  incIncluded: (pct) => `Incl. impoconsumo ${pct}%`,
  ivaIncluded: (pct) => `Incl. IVA ${pct}%`,
};

// Bandeja de $30,000 con INC 8% embebido, repartida como el XML:
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
    // El papel tal cual (comandos ESC/POS fuera, CP850 decodificado). El
    // pie va en fuente B desde el formato compacto: cada renglón se mide
    // contra el ancho de SU letra (A 48/32, B 64/42).
    const paper = readPaper(renderInvoice(doc));
    expect(paper.text.replace(/\s+/g, " ")).toContain(tipNoticeTitle + " " + tipNoticeBody);
    for (const row of paper.rows) {
      expect(row.text.length).toBeLessThanOrEqual(rowCapacity(row, paperWidthMm));
    }
    expect(columnsForWidth(paperWidthMm)).toBe(paperWidthMm === 80 ? 48 : 32);
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
    // Lo que el dueño reclamó: el XML aceptado dice "INC 8%: $2,222" y el
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
      "Total factura",
    ]);
    expect(labels(snap({ subtotalCents: 3_000_000 }))).toEqual(["Subtotal", "Total factura"]);
  });

  it("datáfono sin traductor cae al catálogo en español, como siempre", () => {
    const labels = buildInvoiceCommands(snap({ ...INC_8, tipCents: 10_000 }), 1, invoiceUrl)
      .flatMap((c) => (c.type === "columns" ? [c.columns[0].text] : []));
    expect(labels).toEqual(["Subtotal", "Base gravable", "Incl. impoconsumo 8%", "Total factura", "Propina voluntaria"]);
  });

  it("datáfono: el TOTAL A PAGAR = factura + propina, en negrita y más grande, al final", () => {
    // Emitida al cobrar: el total del snapshot ya incluye la propina.
    const commands = buildInvoiceCommands(
      snap({ subtotalCents: 12_000_000, tipCents: 1_200_000, totalCents: 13_200_000 }),
      1,
      invoiceUrl,
    );
    const texts = commands.flatMap((c) => (c.type === "text" ? [c] : []));
    const label = texts.findIndex((c) => c.text === "TOTAL A PAGAR\n");
    expect(label).toBeGreaterThan(-1);
    expect(texts[label]).toMatchObject({ bold: true, size: 28 });
    expect(texts[label + 1]).toMatchObject({ text: "$ 132,000\n", bold: true, size: 32, align: "RIGHT" });
    const rows = commands.flatMap((c) => (c.type === "columns" ? [`${c.columns[0].text} ${c.columns[1].text}`] : []));
    expect(rows).toContain("Total factura $ 120,000");
    expect(rows).toContain("Propina voluntaria $ 12,000");
  });

  it("datáfono, factura emitida ANTES de cobrar y ya cobrada: la propina REAL de la orden", () => {
    const pre = snap({ subtotalCents: 12_000_000, tipCents: 0, totalCents: 12_000_000, issuedBeforePayment: true });
    const totalToPay = (order?: { tipCents: number }) => {
      const texts = buildInvoiceCommands(pre, 1, invoiceUrl, undefined, order).flatMap((c) =>
        c.type === "text" ? [c.text] : [],
      );
      return texts[texts.indexOf("TOTAL A PAGAR\n") + 1];
    };
    expect(totalToPay({ tipCents: 1_200_000 })).toBe("$ 132,000\n");
    expect(totalToPay()).toBe("$ 120,000\n");
  });
});

// Factura con el descuento del cliente DENTRO de las líneas: el XML declara
// cada línea neta, así que el snapshot congela base e impuesto netos y TODAS
// las superficies ponen el descuento antes de ellos. Cifras: subtotal
// $113,400 con INC 8 %, descuento 20 % = $22.680, propina $9.072.
const DISCOUNTED: Partial<InvoiceSnapshot> = {
  salesTaxKind: "inc",
  salesTaxPct: 8,
  subtotalCents: 11_340_000,
  discountCents: 2_268_000,
  discountPct: 20,
  embeddedTaxCents: 672_000,
  embeddedBaseCents: 8_400_000,
  discountInLines: { allowanceCents: 2_100_000 },
  tipCents: 907_200,
  totalCents: 9_979_200,
};
const SUMMARY_LABELS: SummaryRowLabels = {
  ...LABELS,
  discount: "Descuento",
  discountPct: (pct) => `Descuento ${pct}%`,
};

describe("summaryRows — el descuento del cliente y el impuesto, en el orden de la factura", () => {
  it("con el descuento en las líneas: primero el descuento, después la base y el impuesto netos", () => {
    expect(summaryRows(snap(DISCOUNTED), SUMMARY_LABELS)).toEqual([
      { label: "Descuento 20%", cents: 2_268_000, negative: true },
      { label: "Base gravable", cents: 8_400_000 },
      { label: "Incl. impoconsumo 8%", cents: 672_000 },
    ]);
  });

  it("una factura vieja (sin la marca) conserva su orden: impuesto de lista y después el descuento", () => {
    const old = { ...DISCOUNTED, discountInLines: undefined, embeddedTaxCents: 840_000, embeddedBaseCents: 10_500_000 };
    expect(summaryRows(snap(old), SUMMARY_LABELS).map((r) => r.label)).toEqual([
      "Base gravable",
      "Incl. impoconsumo 8%",
      "Descuento 20%",
    ]);
  });

  it("sin descuento son las filas de impuesto de siempre", () => {
    expect(summaryRows(snap(INC_8), SUMMARY_LABELS)).toEqual(taxRows(snap(INC_8), LABELS));
  });

  it("correo: el descuento ahora aparece (antes el total no cuadraba a la vista) y la base es la neta", async () => {
    const email = await renderInvoiceEmail({ snapshot: snap(DISCOUNTED), invoiceNumber: 1, invoiceUrl, locale: "es" });
    const lines = email.text.split("\n");
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    expect(lines[at("Descuento 20%")]).toBe("Descuento 20%: -$22,680");
    expect(lines[at("Base gravable")]).toBe("Base gravable: $84,000");
    expect(at("Descuento 20%")).toBeLessThan(at("Base gravable"));
    expect(email.html).toContain("Descuento 20%");
    expect(email.html).toContain("-$22,680");
  });

  it("datáfono: subtotal, descuento, base e impuesto netos, propina y total", async () => {
    const { t } = await getEmailTranslator("es", "emailInvoice");
    const rows = buildInvoiceCommands(snap(DISCOUNTED), 1, invoiceUrl, t).flatMap((c) =>
      c.type === "columns" ? [`${c.columns[0].text} ${c.columns[1].text}`] : [],
    );
    expect(rows.map((r) => r.split(" $")[0]!.split(" -$")[0])).toEqual([
      "Subtotal",
      "Descuento 20%",
      "Base gravable",
      "Incl. impoconsumo 8%",
      "Total factura",
      "Propina voluntaria",
    ]);
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
      "2× Bretaña  $12,000",
      "1× Hamburguesa  $28,000",
      "   - Término: Medio",
      "1× Hamburguesa  $28,000",
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
    expect(rows[0]).toContain("$12,000");
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
      .map((l) => Number(l.split("$")[1].replace(/,/g, "")) * 100);
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
    expect(text).toContain("3× Limonada de coco  $36,000");
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
      "2x Bretaña | $ 12,000",
      "1x Hamburguesa | $ 28,000",
      "   - Término: Medio\n",
      "1x Hamburguesa | $ 28,000",
      "   - Término: Bien asado\n",
      '   "Sin cebolla"\n',
    ]);
  });
});

describe("invoice payment time", () => {
  it("shows the Colombian payment date and time rather than the server timezone", async () => {
    const result = await renderInvoiceEmail({ snapshot: snap({ paidAtIso: "2026-09-29T01:30:00.000Z" }), invoiceNumber: 1, invoiceUrl: "https://mesapay.co/factura/test", locale: "es" });
    expect(result.text).toContain("28/09/26 · 20:30");
    expect(result.html).toContain("28/09/26 · 20:30");
  });
});


// El caso del dueño: consumo $ 120,000 con impoconsumo incluido y $ 12,000
// de propina; el cliente pagó $ 132,000 y la factura decía TOTAL
// $ 120.000. Desde ahora: «Total factura» (la venta, lo del XML), «Propina
// voluntaria» y el TOTAL A PAGAR destacado = factura + propina cobrada.
describe("invoicePayableOf — total factura + propina = TOTAL A PAGAR", () => {
  it("emitida al cobrar: la propina del snapshot; la venta es el total sin ella", () => {
    expect(invoicePayableOf({ totalCents: 13_200_000, tipCents: 1_200_000 })).toEqual({
      invoiceTotalCents: 12_000_000,
      tipCents: 1_200_000,
      totalToPayCents: 13_200_000,
    });
    // La orden no se mira: la del snapshot ya es la final.
    expect(invoicePayableOf({ totalCents: 13_200_000, tipCents: 1_200_000 }, { tipCents: 1 }).tipCents).toBe(1_200_000);
  });

  it("sin propina, el TOTAL A PAGAR es el total de la factura", () => {
    expect(invoicePayableOf({ totalCents: 5_000_000, tipCents: 0 })).toEqual({
      invoiceTotalCents: 5_000_000,
      tipCents: 0,
      totalToPayCents: 5_000_000,
    });
  });

  it("emitida ANTES de cobrar: la propina REAL de la orden, no la del snapshot (0)", () => {
    const pre = { totalCents: 12_000_000, tipCents: 0, issuedBeforePayment: true };
    expect(invoicePayableOf(pre, { tipCents: 1_200_000 })).toEqual({
      invoiceTotalCents: 12_000_000,
      tipCents: 1_200_000,
      totalToPayCents: 13_200_000,
    });
    // Sin cobrar (o sin la orden): nada que sumar; la sugerida va aparte.
    expect(invoicePayableOf(pre, { tipCents: 0 }).totalToPayCents).toBe(12_000_000);
    expect(invoicePayableOf(pre, null).totalToPayCents).toBe(12_000_000);
    expect(invoicePayableOf(pre).totalToPayCents).toBe(12_000_000);
  });

  it("payableRows: total, propina sólo si hay, y el TOTAL A PAGAR como único renglón fuerte", () => {
    const labels = { invoiceTotal: "Total factura", tip: "Propina voluntaria", totalToPay: "TOTAL A PAGAR" };
    expect(payableRows({ invoiceTotalCents: 100, tipCents: 10, totalToPayCents: 110 }, labels)).toEqual([
      { label: "Total factura", cents: 100 },
      { label: "Propina voluntaria", cents: 10 },
      { label: "TOTAL A PAGAR", cents: 110, strong: true },
    ]);
    expect(payableRows({ invoiceTotalCents: 100, tipCents: 0, totalToPayCents: 100 }, labels)).toEqual([
      { label: "Total factura", cents: 100 },
      { label: "TOTAL A PAGAR", cents: 100, strong: true },
    ]);
  });
});

describe("correo del comprobante — total, propina voluntaria y TOTAL A PAGAR", () => {
  const fesm = snap({ ...INC_8, subtotalCents: 12_000_000, tipCents: 1_200_000, totalCents: 13_200_000 });

  it.each([
    ["es", ["Total comprobante: $120,000", "Propina voluntaria: $12,000", "TOTAL A PAGAR: $132,000"]],
    ["en", ["Receipt total: $120,000", "Voluntary tip: $12,000", "TOTAL TO PAY: $132,000"]],
    ["pt", ["Total do comprovante: $120,000", "Gorjeta voluntária: $12,000", "TOTAL A PAGAR: $132,000"]],
  ])("%s: los tres renglones seguidos y el resumen de arriba con el total a pagar", async (locale, rows) => {
    const email = await renderInvoiceEmail({ snapshot: fesm, invoiceNumber: 77, invoiceUrl, locale });
    const lines = email.text.split("\n");
    const first = lines.indexOf(rows[0]!);
    expect(first).toBeGreaterThan(-1);
    expect(lines.slice(first, first + 3)).toEqual(rows);
    // En el HTML, el TOTAL A PAGAR va en negrita y a 16px (el resto a 12px).
    expect(email.html).toMatch(/font-size:16px;font-weight:700;[^"]*">[^<]*<\/td><td[^>]*font-size:16px;font-weight:700;[^>]*>\$132,000/);
    expect(email.html).not.toMatch(/>TOTAL<\/td>/);
  });

  it("emitida ANTES de cobrar: sin pagar dice «TOTAL A PAGAR» arriba; cobrada, «Total pagado» con la propina de la orden", async () => {
    const pre = snap({ ...INC_8, subtotalCents: 12_000_000, tipCents: 0, totalCents: 12_000_000, issuedBeforePayment: true });
    const unpaid = await renderInvoiceEmail({ snapshot: pre, invoiceNumber: 77, invoiceUrl, locale: "es", order: { tipCents: 0, paid: false } });
    expect(unpaid.text).toContain("TOTAL A PAGAR: $120,000");
    expect(unpaid.text).not.toContain("Propina voluntaria");
    expect(unpaid.html).not.toContain("Total pagado");
    const paid = await renderInvoiceEmail({ snapshot: pre, invoiceNumber: 77, invoiceUrl, locale: "es", order: { tipCents: 1_200_000, paid: true } });
    expect(paid.text).toContain("Propina voluntaria: $12,000");
    expect(paid.text).toContain("TOTAL A PAGAR: $132,000");
    expect(paid.html).toContain("Total pagado");
    expect(paid.html).toMatch(/Total pagado<\/div>\s*<div[^>]*>\$132,000/);
  });
});

describe("emitida con «Sin propina»: el datáfono tampoco sugiere propina", () => {
  it("sin cobrar, sólo Total factura y TOTAL A PAGAR = la factura", () => {
    const pre = snap({ subtotalCents: 12_000_000, tipCents: 0, totalCents: 12_000_000, issuedBeforePayment: true, suggestedTipPct: 0 });
    const texts = buildInvoiceCommands(pre, 1, invoiceUrl, undefined, { tipCents: 0 }).flatMap((c) =>
      c.type === "text" ? [c.text] : c.type === "columns" ? [c.columns.map((col) => col.text).join(" ")] : [],
    );
    expect(texts.join("\n")).not.toContain("Propina sugerida");
    expect(texts.join("\n")).not.toContain("Propina voluntaria");
    expect(texts[texts.indexOf("TOTAL A PAGAR\n") + 1]).toBe("$ 120,000\n");
  });
});
