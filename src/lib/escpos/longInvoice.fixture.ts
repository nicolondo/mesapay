/**
 * Fixture SÓLO para tests: una cuenta LARGA como la de la foto del dueño
 * (Son y Melona, factura electrónica, ~40 renglones de platos). Sirve para
 * medir cuánto papel gasta la tirilla y para que el formato compacto no
 * se degrade sin que un test lo cante.
 *
 * Mezcla lo que hace crecer una factura de verdad: nombres largos que no
 * entran al lado del precio, platos con término y guarnición, notas, y
 * repetidos (que `groupInvoiceLines` junta).
 */

import type { InvoiceSnapshot } from "@/lib/invoice";

type Item = InvoiceSnapshot["items"][number];

const MENU: Array<{ name: string; priceCents: number; modifiers?: string[]; notes?: string }> = [
  { name: "Hamburguesa Melona con tocineta y queso", priceCents: 3_600_000, modifiers: ["Término: 1/2", "Guarniciones: Ensalada fresca"] },
  { name: "Churrasco a la parrilla con chimichurri de la casa", priceCents: 5_800_000, modifiers: ["Término: 3/4", "Guarniciones: Papas criollas"] },
  { name: "Limonada de coco", priceCents: 1_200_000 },
  { name: "Cerveza Club Colombia dorada", priceCents: 900_000 },
  { name: "Patacón con hogao y guacamole", priceCents: 2_200_000 },
  { name: "Ensalada César con pollo a la plancha", priceCents: 3_100_000, notes: "Sin crutones" },
  { name: "Arepa de chócolo con quesito", priceCents: 1_500_000 },
  { name: "Punta de anca madurada 400 g", priceCents: 6_900_000, modifiers: ["Término: 1/2", "Guarniciones: Yuca frita"] },
  { name: "Jugo de mora en agua", priceCents: 900_000 },
  { name: "Brownie con helado de vainilla", priceCents: 1_800_000 },
  { name: "Salmón en salsa de maracuyá con arroz de coco", priceCents: 6_200_000, modifiers: ["Guarniciones: Ensalada fresca"] },
  { name: "Agua con gas", priceCents: 600_000 },
  { name: "Costillas BBQ ahumadas", priceCents: 5_400_000, modifiers: ["Guarniciones: Papas a la francesa"], notes: "Salsa aparte" },
  { name: "Mojito de maracuyá", priceCents: 2_400_000 },
  { name: "Tabla de quesos y carnes frías para compartir", priceCents: 7_500_000 },
  { name: "Sopa de tomate asado", priceCents: 1_900_000 },
  { name: "Café americano", priceCents: 500_000 },
  { name: "Pechuga gratinada con champiñones", priceCents: 4_300_000, modifiers: ["Guarniciones: Arroz blanco"] },
  { name: "Postre de natas", priceCents: 1_600_000 },
  { name: "Gaseosa", priceCents: 500_000 },
];

/** 40 platos distintos (el menú dos veces, con el precio de la 2.ª vuelta distinto). */
function items(): Item[] {
  const out: Item[] = [];
  for (let round = 0; round < 2; round++) {
    MENU.forEach((m, i) => {
      out.push({
        qty: (i % 3) + 1,
        name: round === 0 ? m.name : `${m.name} (2)`,
        priceCents: m.priceCents + round * 10_000,
        menuItemId: `mi-${round}-${i}`,
        taxKind: null,
        taxPct: null,
        modifiers: m.modifiers ?? [],
        notes: m.notes ?? null,
      });
    });
  }
  return out;
}

const ITEMS = items();
const SUBTOTAL = ITEMS.reduce((s, i) => s + i.qty * i.priceCents, 0);
/** Impoconsumo 8% embebido: base = bruto / 1,08. */
const BASE = Math.round(SUBTOTAL / 1.08);
const TIP = Math.round(SUBTOTAL * 0.1);

export const LONG_INVOICE_SNAPSHOT: InvoiceSnapshot = {
  restaurantName: "Son y Melona",
  logoUrl: null,
  legalName: "SON Y MELONA S.A.S.",
  taxId: "901.234.567-8",
  legalAddress: "Carrera 43A # 1-50, local 102",
  legalCity: "Medellín",
  legalPhone: "604 444 5566",
  dianResolution: "18764000012345",
  dianResolutionFrom: 1,
  dianResolutionTo: 100000,
  dianResolutionDate: "2026-01-15T00:00:00.000Z",
  invoicePrefix: "SM",
  shortCode: "002A77-77C496-58E6EF-6C25C8",
  tableLabel: "Mesa 12",
  paidAtIso: "2026-09-25T02:41:00.000Z",
  items: ITEMS,
  subtotalCents: SUBTOTAL,
  salesTaxKind: "inc",
  salesTaxPct: 8,
  embeddedTaxCents: SUBTOTAL - BASE,
  embeddedBaseCents: BASE,
  discountCents: 0,
  tipCents: TIP,
  totalCents: SUBTOTAL + TIP,
  customer: null,
};

export const LONG_INVOICE_CUFE = "0123456789abcdef".repeat(6);
export const LONG_INVOICE_VERIFY_URL =
  "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=" +
  LONG_INVOICE_CUFE;
