import { describe, expect, it } from "vitest";
import {
  fmtCOP,
  fmtCOPauto,
  fmtCOPlong,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  groupThousands,
  numberFormatter,
} from "./format";

// Quita espacios (Intl mete espacios duros entre «$» y la cifra en es/pt).
const flat = (s: string) => s.replace(/\s/g, "");

describe("convención de números: miles «,» y decimales «.» en todos los idiomas", () => {
  it.each(["es", "en", "pt"] as const)("formatNumber en %s", (locale) => {
    expect(formatNumber(15000.25, { locale })).toBe("15,000.25");
    expect(formatNumber(-15000.25, { locale })).toBe("-15,000.25");
    expect(formatNumber(1234567, { locale })).toBe("1,234,567");
    expect(formatNumber(0, { locale })).toBe("0");
    expect(formatNumber(0.5, { locale })).toBe("0.5");
    expect(formatNumber(999, { locale })).toBe("999");
    expect(formatNumber(1234, { locale })).toBe("1,234");
  });

  it("respeta la precisión pedida", () => {
    expect(formatNumber(2.5, { minimumFractionDigits: 2 })).toBe("2.50");
    expect(formatNumber(2.345678, { maximumFractionDigits: 3 })).toBe("2.346");
  });

  it.each(["es", "en", "pt"] as const)("formatMoney COP en %s", (locale) => {
    expect(flat(formatMoney(123456700, { currency: "COP", locale }))).toBe("$1,234,567");
    expect(flat(formatMoney(123456, { currency: "COP", locale, fractionDigits: 2 }))).toBe("$1,234.56");
    expect(flat(formatMoney(-123456, { currency: "COP", locale, fractionDigits: 2 }))).toBe("-$1,234.56");
    expect(flat(formatMoney(0, { currency: "COP", locale }))).toBe("$0");
    expect(flat(formatMoney(0, { currency: "COP", locale, fractionDigits: 2 }))).toBe("$0.00");
  });

  it("otras monedas mantienen su símbolo y sus decimales", () => {
    expect(flat(formatMoney(123456, { currency: "USD", locale: "en" }))).toBe("$1,234.56");
    expect(flat(formatMoney(123456, { currency: "BRL", locale: "pt" }))).toBe("R$1,234.56");
    expect(flat(formatMoney(123456, { currency: "MXN", locale: "es" }))).toBe("$1,234.56");
  });

  it("COP redondea a pesos salvo que se pida otra precisión", () => {
    expect(flat(formatMoney(123456, { currency: "COP", locale: "es" }))).toBe("$1,235");
    expect(flat(formatMoney(1, { currency: "COP", locale: "en", fractionDigits: 2 }))).toBe("$0.01");
  });

  it("«auto» muestra centavos solo si el valor los tiene", () => {
    expect(flat(formatMoney(123400, { currency: "COP", locale: "es", fractionDigits: "auto" }))).toBe("$1,234");
    expect(flat(formatMoney(123456, { currency: "COP", locale: "es", fractionDigits: "auto" }))).toBe("$1,234.56");
    expect(flat(formatMoney(-50, { currency: "COP", locale: "es", fractionDigits: "auto" }))).toBe("-$0.50");
    expect(flat(formatMoney(123400, { currency: "USD", locale: "en", fractionDigits: "auto" }))).toBe("$1,234.00");
  });

  it("fmtCOPauto: centavos solo si los hay", () => {
    expect(fmtCOPauto(123400)).toBe("$1,234");
    expect(fmtCOPauto(123456)).toBe("$1,234.56");
    expect(fmtCOPauto(5)).toBe("$0.05");
    expect(fmtCOPauto(-123456)).toBe("$-1,234.56");
  });

  it("fmtCOP / fmtCOPlong / groupThousands", () => {
    expect(fmtCOP(123456700)).toBe("$1,234,567");
    expect(fmtCOP(0)).toBe("$0");
    expect(fmtCOP(-250000)).toBe("$-2,500");
    expect(fmtCOPlong(2500000)).toBe("$25,000 COP");
    expect(groupThousands("1234567")).toBe("1,234,567");
    expect(groupThousands("")).toBe("");
    expect(groupThousands("000123")).toBe("123");
  });

  it("porcentajes y notación compacta", () => {
    expect(formatPercent(0.125, { locale: "es" })).toBe("12.5%");
    expect(formatPercent(0.125, { locale: "pt" })).toBe("12.5%");
    expect(numberFormatter("es", { notation: "compact", maximumFractionDigits: 1 }).format(12500)).not.toContain(",5");
    expect(numberFormatter("es-CO", { maximumFractionDigits: 2 }).format(1234.5)).toBe("1,234.5");
  });

  it("las fechas NO cambian: siguen con el idioma", () => {
    const d = new Date("2026-03-05T15:00:00Z");
    const opts = { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC", dateStyle: undefined, timeStyle: undefined } as const;
    expect(formatDate(d, { ...opts, locale: "es" })).toBe("05/03/2026");
    expect(formatDate(d, { ...opts, locale: "en" })).toBe("03/05/2026");
  });
});
