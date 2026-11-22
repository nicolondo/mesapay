import { describe, expect, it, vi } from "vitest";

// `terminalCommands` importa los helpers de `kushki/cloudPrint`, que a su
// vez carga el transporte cifrado (env). Acá no se habla con Kushki.
vi.mock("@/lib/env", () => ({ env: { KUSHKI_BP_BUSINESS_CODE: undefined, KUSHKI_CLOUD_TERMINAL_PATH: undefined } }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));

import type { ThermalInvoice } from "@/lib/escpos/invoice";
import type { ThermalPrebill } from "@/lib/escpos/prebill";
import type { ThermalReport } from "@/lib/escpos/report";
import {
  invoiceToTerminalCommands,
  prebillToTerminalCommands,
  reportToTerminalCommands,
} from "./terminalCommands";
import type { PrintCommand } from "@/lib/payments/kushki/cloudPrint";

/**
 * El armador de «Este dispositivo» del datáfono (Sunmi P3, cloud print de
 * Kushki). Es el camino que imprimió la factura FESM8525 con el layout
 * VIEJO después del PR #634 — este armador se había quedado por fuera del
 * rediseño y mandaba los textos CRUDOS: el terminal envuelve partiendo en
 * el ancho exacto («FACTURA ELECTRÓNICA DE V/ENTA», «SUGE/RIDA»), el
 * nombre largo se entreveraba con el precio en `columns` y el CUFE salía
 * en bloque. Estos tests FALLAN contra ese armador y protegen el nuevo:
 * todo texto pre-envuelto por palabra, CUFE en grupos y la sección
 * «Pagos» del documento.
 */

const CUFE = "0123456789abcdef".repeat(6);

/** El caso de la foto (datos de muestra): FESM, 58 mm. */
function fotoDoc(): ThermalInvoice {
  return {
    paperWidthMm: 58,
    businessName: "SON Y MELONA S.A.S.",
    businessLines: [
      "NIT 901.234.567-8",
      "Carrera 43A # 1-50, local 102",
      "Envigado",
      "Tel: 604 444 5566",
    ],
    documentLabel: "FACTURA ELECTRÓNICA DE VENTA",
    documentNumber: "FESM8525",
    metaRows: [
      { label: "Fecha", value: "20/11/26, 1:39 p. m." },
      { label: "Mesa 4", value: "002A77" },
    ],
    customerLines: ["Cliente: Consumidor final"],
    items: [
      {
        qty: 1,
        name: "Plato del Día (Casero Del Dia)",
        amount: "$ 33,900",
        modifiers: [
          "Opción de sopa: Fríjoles",
          "Opción de proteína: Pollo a la parrilla",
          "Bebida: Limonada natural",
        ],
      },
    ],
    totals: [
      { label: "Subtotal", amount: "$ 33,900" },
      { label: "Base gravable", amount: "$ 31,389" },
      { label: "Incl. impoconsumo 8%", amount: "$ 2,511" },
      { label: "Total factura", amount: "$ 33,900" },
      { label: "Propina voluntaria", amount: "$ 3,139" },
      { label: "TOTAL A PAGAR", amount: "$ 37,039", strong: true },
    ],
    paymentTitle: null,
    paymentRows: [],
    paymentsSection: {
      title: "Pagos",
      blocks: [
        {
          label: "Tarjeta · datáfono",
          amount: "$ 37,039",
          lines: ["VISA · ····4242 · Aprob. 123456", "Incluye propina $ 3,139"],
        },
      ],
      totalLabel: "TOTAL PAGADO",
      totalAmount: "$ 37,039",
      breakdown: "Cuenta $ 33,900 · Propinas $ 3,139",
      pending: null,
    },
    footerLines: [
      "Resolución DIAN: 18764000012345 · Numeración del 1 al 100000 · Fecha de resolución 14/01/26",
      "ADVERTENCIA DE PROPINA",
      "POR DISPOSICION DE LA SUPERINTENDENCIA DE INDUSTRIA Y COMERCIO SE INFORMA QUE LA PROPINA ES SUGERIDA AL CONSUMIDOR LA CUAL PODRA SER ACEPTADA, RECHAZADA O MODIFICADA POR USTED, DE ACUERDO CON SU VALORACION DEL SERVICIO PRESTADO.",
      "¡Gracias por tu visita!",
    ],
    fiscal: {
      cufeLabel: "CUFE",
      cufe: CUFE,
      verifyUrl:
        "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=" + CUFE,
      qr: true,
      verifyLabel: "Consulta esta factura en la DIAN:",
      noticeLines: ["Representación impresa de la factura electrónica de venta"],
    },
  };
}

/** Los comandos dibujados a 32 columnas (tamaño 24), para LEER el diseño. */
function renderCommands(commands: PrintCommand[]): string {
  const out: string[] = [];
  for (const c of commands) {
    if (c.type === "text") out.push(...c.text.replace(/\n$/, "").split("\n"));
    else if (c.type === "columns") {
      const [l, r] = c.columns;
      out.push(l.text + " " + (r?.text ?? "").padStart(Math.max(0, 31 - l.text.length)));
    } else if (c.type === "divider") out.push("-".repeat(32));
    else if (c.type === "qr") out.push("[QR]");
  }
  return out.join("\n");
}

describe("invoiceToTerminalCommands — el diseño nuevo (regresión FESM8525)", () => {
  it("snapshot del diseño en texto (32 col)", () => {
    expect(renderCommands(invoiceToTerminalCommands(fotoDoc()))).toMatchSnapshot();
  });

  it("TODO texto va pre-envuelto: ninguna línea se pasa del ancho efectivo de su tamaño", () => {
    // Contra el armador viejo esto FALLA: mandaba el rótulo, el aviso SIC,
    // la resolución y el CUFE crudos y el terminal los partía por letra.
    for (const c of invoiceToTerminalCommands(fotoDoc())) {
      if (c.type !== "text") continue;
      const size = c.size ?? 24;
      const cols = Math.max(1, Math.floor((32 * 24) / size));
      for (const l of c.text.replace(/\n$/, "").split("\n")) {
        expect(l.length, `"${l}" a tamaño ${size}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("las palabras de la foto salen enteras en algún renglón", () => {
    const lines = renderCommands(invoiceToTerminalCommands(fotoDoc())).split("\n");
    for (const palabra of [
      "VENTA",
      "PAGAR",
      "Envigado",
      "Opción",
      "parrilla",
      "SUGERIDA",
      "MODIFICADA",
      "PRESTADO",
      "factura",
      "resolución",
    ]) {
      expect(
        lines.some((l) => l.includes(palabra)),
        palabra,
      ).toBe(true);
    }
  });

  it("el nombre largo nunca comparte columna con el precio (primera línea ≤ 20 col) y sigue abajo", () => {
    const commands = invoiceToTerminalCommands(fotoDoc());
    for (const c of commands) {
      if (c.type === "columns") expect(c.columns[0].text.length).toBeLessThanOrEqual(20);
    }
    expect(renderCommands(commands)).toContain("(Casero Del Dia)");
  });

  it("la fecha va entera en su propio renglón", () => {
    const lines = renderCommands(invoiceToTerminalCommands(fotoDoc())).split("\n");
    expect(lines).toContain("Fecha 20/11/26, 1:39 p. m.");
  });

  it("modificadores de a uno por renglón cuando no entran juntos, sangrados", () => {
    const lines = renderCommands(invoiceToTerminalCommands(fotoDoc())).split("\n");
    expect(lines).toContain("   Opción de sopa: Fríjoles");
    expect(lines).toContain("   Opción de proteína: Pollo a");
    expect(lines).toContain("   la parrilla");
    expect(lines).toContain("   Bebida: Limonada natural");
  });

  it("CUFE: rótulo en su renglón y grupos de 8 que no se parten", () => {
    const text = renderCommands(invoiceToTerminalCommands(fotoDoc()));
    expect(text).toContain("CUFE:\n");
    const groups = text
      .split("\n")
      .filter((l) => /^[0-9a-f]{8}( [0-9a-f]{8})*$/.test(l))
      .flatMap((l) => l.split(" "));
    expect(groups).toHaveLength(12);
    expect(groups.join("")).toBe(CUFE);
  });

  it("la sección «Pagos» del documento se imprime (y no el bloque viejo)", () => {
    const text = renderCommands(invoiceToTerminalCommands(fotoDoc()));
    expect(text).toContain("Pagos");
    expect(text).toContain("TOTAL PAGADO");
    expect(text.replace(/\n {3}/g, " ")).toContain("VISA · ····4242 · Aprob. 123456");
    expect(text).not.toContain("Forma de pago");
  });

  it("un documento VIEJO (sin sección, con Forma de pago) imprime su contenido de siempre, pero envuelto", () => {
    const legacy: ThermalInvoice = {
      ...fotoDoc(),
      paymentsSection: null,
      paymentTitle: "Forma de pago",
      paymentRows: [{ label: "Tarjeta · datáfono", amount: "$ 37,039" }],
    };
    const text = renderCommands(invoiceToTerminalCommands(legacy));
    // Compatibilidad en el CONTENIDO: el bloque viejo sigue saliendo…
    expect(text).toContain("Forma de pago");
    expect(text).not.toContain("TOTAL PAGADO");
    // …pero el DISEÑO es siempre el nuevo: nada parte palabras.
    for (const palabra of ["VENTA", "SUGERIDA", "PRESTADO"]) {
      expect(text.split("\n").some((l) => l.includes(palabra)), palabra).toBe(true);
    }
  });
});

describe("prebillToTerminalCommands — mismo diseño", () => {
  it("títulos y detalle envueltos por palabra; el unitario abre el detalle", () => {
    const doc: ThermalPrebill = {
      paperWidthMm: 58,
      businessName: "SON Y MELONA S.A.S.",
      businessLines: ["NIT 901.234.567-8"],
      title: "PRECUENTA",
      notInvoiceLine: "Este documento no es una factura electrónica de venta",
      metaRows: [{ label: "Fecha", value: "20/11/26, 1:39 p. m." }],
      items: [
        {
          qty: 2,
          name: "Churrasco a la parrilla con chimichurri",
          amount: "$ 116,000",
          unit: "$ 58,000",
          modifiers: ["Término: 3/4", "Guarniciones: Papas criollas"],
          notes: null,
        },
      ],
      totals: [{ label: "TOTAL CON PROPINA", amount: "$ 127,600", strong: true }],
      tipRows: [],
      tipNotice: null,
      footerLines: ["¡Gracias por tu visita!"],
    };
    const commands = prebillToTerminalCommands(doc);
    for (const c of commands) {
      if (c.type !== "text") continue;
      const size = c.size ?? 24;
      const cols = Math.max(1, Math.floor((32 * 24) / size));
      for (const l of c.text.replace(/\n$/, "").split("\n")) {
        expect(l.length, `"${l}"`).toBeLessThanOrEqual(cols);
      }
    }
    const text = renderCommands(commands);
    expect(text).toContain("2 x $ 58,000");
    expect(text.split("\n").some((l) => l.includes("electrónica"))).toBe(true);
  });
});

describe("separadores — nunca montados sobre el renglón anterior (fotos FESM8617/8618)", () => {
  /**
   * En el Sunmi el `divider` no avanza renglón: pegado a un `text` se
   * dibuja ENCIMA del último renglón, como un tachado. La regla: todo
   * separador que sigue a un `text` lleva antes un `space` de 24 px
   * (`spacedDividers`); tras `columns` no hace falta — la fila cierra su
   * renglón. Este test FALLA con la secuencia anterior (text → divider).
   */
  function assertDividerClearance(commands: PrintCommand[], label: string) {
    commands.forEach((c, i) => {
      if (c.type !== "divider") return;
      const prev = commands[i - 1];
      expect(
        prev?.type,
        `${label}: divider en ${i} pegado a un "${prev?.type}"`,
      ).not.toBe("text");
      if (prev?.type === "space") {
        expect(prev.pixels, `${label}: space antes del divider en ${i}`).toBe(24);
      }
    });
  }

  const reportDoc: ThermalReport = {
    paperWidthMm: 58,
    businessName: "SON Y MELONA S.A.S.",
    businessLines: ["NIT 901.234.567-8"],
    title: "CIERRE DE TURNO",
    metaRows: [{ label: "Apertura", value: "22/11/26, 8:00 a. m." }],
    sections: [
      {
        title: "POR MÉTODO DE PAGO",
        rows: [{ label: "Efectivo", value: "$ 120,000" }],
        notes: ["Una nota corrida debajo de las filas del cierre de turno."],
      },
    ],
    footerLines: ["Generado con MESAPAY"],
  };

  it("factura, precuenta y cierre: todo divider que sigue a texto lleva su space de 24 px", () => {
    assertDividerClearance(invoiceToTerminalCommands(fotoDoc()), "factura");
    assertDividerClearance(
      invoiceToTerminalCommands({
        ...fotoDoc(),
        paymentsSection: null,
        paymentTitle: "Forma de pago",
        paymentRows: [{ label: "Tarjeta · datáfono", amount: "$ 37,039" }],
      }),
      "factura legacy",
    );
    assertDividerClearance(reportToTerminalCommands(reportDoc), "cierre");
  });

  it("los casos de la foto: el separador tras «Cliente: Consumidor final» y tras la leyenda DIAN va con aire", () => {
    const commands = invoiceToTerminalCommands(fotoDoc());
    const after = (needle: string) => {
      const i = commands.findIndex((c) => c.type === "text" && c.text.includes(needle));
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return commands.slice(i + 1, i + 3).map((c) => c.type);
    };
    // text → space → divider, nunca text → divider.
    expect(after("Consumidor final")).toEqual(["space", "divider"]);
    expect(after("Representación impresa")).toEqual(["space", "divider"]);
  });

  it("la secuencia de TIPOS de la factura queda fija (snapshot)", () => {
    const seq = invoiceToTerminalCommands(fotoDoc()).map((c) =>
      c.type === "divider" ? `divider:${c.dividerType}` : c.type === "space" ? `space:${c.pixels}` : c.type,
    );
    expect(seq).toMatchSnapshot();
  });
});
