// Etiquetas del efectivo en los tres idiomas. El detalle del pedido decía
// "Efectivo (demo)" para cobros reales porque la clave era la de
// `demo_cash`; ahora cash y demo_cash comparten una clave "Efectivo" en
// cada pantalla (pagos, pedidos, reportes, turnos, contabilidad,
// terminal, pantalla de listo y tirilla/correo) y sólo la tarjeta demo
// conserva el "(demo)".
import { describe, expect, it, vi } from "vitest";
import es from "../../../messages/es.json";
import en from "../../../messages/en.json";
import pt from "../../../messages/pt.json";
import { PAYMENT_METHOD_LABEL } from "@/lib/shiftReport";

vi.mock("@/lib/db", () => ({ db: {} }));

type Catalog = Record<string, Record<string, unknown>>;
const CATALOGS: [string, Catalog, string][] = [
  ["es", es as Catalog, "Efectivo"],
  ["en", en as Catalog, "Cash"],
  ["pt", pt as Catalog, "Dinheiro"],
];

// [namespace, clave] que usan los mapas de etiquetas para cash/demo_cash.
const CASH_LABEL_KEYS: [string, string][] = [
  ["opPayments", "mCash"],
  ["opOrders", "mCash"],
  ["opReports", "methodCash"],
  ["opShifts", "methodCash"],
  ["opErp", "mCash"],
  ["opTerminal", "methodCash"],
  ["done", "methodCash"],
  ["emailInvoice", "methodCash"],
];

function allStrings(o: unknown, out: string[] = []): string[] {
  if (typeof o === "string") out.push(o);
  else if (o && typeof o === "object") for (const v of Object.values(o)) allStrings(v, out);
  return out;
}

describe("etiquetas del efectivo", () => {
  for (const [locale, catalog, cash] of CATALOGS) {
    it(`${locale}: cada pantalla rotula el efectivo como «${cash}», sin «(demo)»`, () => {
      for (const [ns, key] of CASH_LABEL_KEYS) {
        expect(catalog[ns]?.[key], `${ns}.${key}`).toBe(cash);
      }
      expect(allStrings(catalog).filter((v) => v.startsWith(`${cash} (demo)`))).toEqual([]);
    });

    it(`${locale}: ya no quedan las claves viejas de efectivo demo y la tarjeta demo sigue marcada`, () => {
      for (const ns of ["opPayments", "opOrders", "opErp"]) {
        expect(catalog[ns]).not.toHaveProperty("mDemoCash");
        expect(String(catalog[ns].mDemoCard)).toMatch(/\(demo\)/);
      }
      for (const ns of ["opReports", "opShifts"]) {
        expect(catalog[ns]).not.toHaveProperty("methodDemoCash");
        expect(String(catalog[ns].methodDemoCard)).toMatch(/\(demo\)/);
      }
    });
  }

  it("el Z-report (respaldo sin catálogo) rotula cash y demo_cash igual", () => {
    expect(PAYMENT_METHOD_LABEL.cash).toBe("Efectivo");
    expect(PAYMENT_METHOD_LABEL.demo_cash).toBe(PAYMENT_METHOD_LABEL.cash);
  });
});
