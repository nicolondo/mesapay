import { describe, expect, it } from "vitest";
import {
  backToOrigin,
  breadcrumbs,
  drillToRange,
  hasItemFilter,
  methodsForFilter,
  normalizeRange,
  parsePeriodToken,
  parseSalesFilters,
  periodToken,
  REPORTING_METHODS,
  resolveComparison,
  resolveRange,
  salesFiltersToSearchParams,
  salesHref,
  withDimension,
  withoutDimension,
  withPeriod,
} from "./filters";

const parse = (qs: string) => parseSalesFilters(new URLSearchParams(qs));

describe("filtros desde la URL", () => {
  it("sin parámetros: últimos 30 días contra el período anterior, granularidad automática", () => {
    const f = parse("");
    expect(f).toMatchObject({ period: "30d", compare: "anterior", granularity: "auto", dims: {}, dimOrder: [] });
    expect(resolveRange(f, "2026-10-31")).toEqual({ from: "2026-10-02", to: "2026-10-31" });
  });

  it("lee presets, rango, comparación, granularidad y dimensiones", () => {
    const f = parse("periodo=rango&desde=2026-10-01&hasta=2026-10-31&comparar=anio&agrupar=semana&mesero=u1&canal=llevar&pago=cash&dia=6&hora=20");
    expect(f.period).toBe("rango");
    expect(resolveRange(f, "2026-10-31")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveComparison(f, resolveRange(f, "2026-10-31"))).toEqual({ from: "2025-10-01", to: "2025-10-31" });
    expect(f.granularity).toBe("semana");
    expect(f.dims).toEqual({ mesero: "u1", canal: "llevar", pago: "cash", dia: 6, hora: 20 });
    expect(f.dimOrder).toEqual(["mesero", "canal", "pago", "dia", "hora"]);
  });

  it("también acepta el objeto de searchParams de Next (con arreglos)", () => {
    const f = parseSalesFilters({ periodo: "mes", producto: ["p1", "p2"], categoria: undefined });
    expect(f.period).toBe("mes");
    expect(f.dims).toEqual({ producto: "p1" });
  });

  it("descarta lo que no valida en vez de romper", () => {
    const f = parse("periodo=siempre&comparar=nunca&agrupar=minuto&canal=domicilio&pago=bitcoin&dia=8&hora=24&mesero=<script>&mesa=a%20b");
    expect(f).toMatchObject({ period: "30d", compare: "anterior", granularity: "auto", dims: {}, dimOrder: [] });
  });

  it("un rango inválido cae al período por defecto; uno al revés se ordena; uno enorme se acota", () => {
    expect(parse("desde=2026-02-30&hasta=2026-03-01").period).toBe("30d");
    expect(normalizeRange("2026-10-31", "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(normalizeRange("2020-01-01", "2026-10-31")).toEqual({ from: "2024-10-30", to: "2026-10-31" });
  });

  it("el efectivo histórico entra en el filtro de efectivo; demo_cash no es un filtro aparte", () => {
    expect(methodsForFilter("cash")).toEqual(["cash", "demo_cash"]);
    expect(methodsForFilter("kushki_card")).toEqual(["kushki_card"]);
    expect(REPORTING_METHODS).not.toContain("demo_cash");
    expect(parse("pago=demo_cash").dims.pago).toBeUndefined();
  });
});

describe("filtros hacia la URL", () => {
  it("omite los valores por defecto y conserva el orden de los filtros", () => {
    const f = withDimension(withDimension(parse(""), "categoria", "c1"), "mesero", "u1");
    expect(salesHref(f)).toBe("/operator/reports/ventas?categoria=c1&mesero=u1");
  });

  it("ida y vuelta sin perder nada", () => {
    const qs = "periodo=rango&desde=2026-10-14&hasta=2026-10-14&origen=30d&comparar=no&agrupar=hora&producto=p1&hora=21";
    const f = parse(qs);
    expect(salesFiltersToSearchParams(f).toString()).toBe(qs);
    expect(parse(salesFiltersToSearchParams(f).toString())).toEqual(f);
  });

  it("reemplazar un filtro lo manda al final de las migas; quitarlo lo saca", () => {
    let f = withDimension(withDimension(parse(""), "mesero", "u1"), "canal", "salon");
    f = withDimension(f, "mesero", "u2");
    expect(f.dimOrder).toEqual(["canal", "mesero"]);
    expect(withoutDimension(f, "canal")).toMatchObject({ dims: { mesero: "u2" }, dimOrder: ["mesero"] });
  });

  it("cambiar de período limpia el drill y la granularidad, pero deja las dimensiones", () => {
    const f = withPeriod(parse("periodo=rango&desde=2026-10-14&hasta=2026-10-14&origen=30d&agrupar=hora&mesero=u1"), "mes");
    expect(salesHref(f)).toBe("/operator/reports/ventas?periodo=mes&mesero=u1");
  });

  it("detecta los filtros por línea (producto o categoría)", () => {
    expect(hasItemFilter(parse("mesero=u1"))).toBe(false);
    expect(hasItemFilter(parse("categoria=c1"))).toBe(true);
  });
});

describe("drill-down y migas", () => {
  it("entrar a un día recuerda el período de origen y se puede volver", () => {
    const base = parse("periodo=mes&mesero=u1");
    const day = drillToRange(base, { from: "2026-10-14", to: "2026-10-14" });
    expect(salesHref(day)).toBe("/operator/reports/ventas?periodo=rango&desde=2026-10-14&hasta=2026-10-14&origen=mes&mesero=u1");
    expect(salesHref(backToOrigin(day)!)).toBe("/operator/reports/ventas?periodo=mes&mesero=u1");
  });

  it("un drill dentro de otro conserva el origen más alto", () => {
    const week = drillToRange(parse("periodo=90d"), { from: "2026-10-12", to: "2026-10-18" });
    const day = drillToRange(week, { from: "2026-10-14", to: "2026-10-14" });
    expect(day.origen).toBe("90d");
  });

  it("los tokens de período validan igual que la URL", () => {
    expect(periodToken({ period: "rango", desde: "2026-10-01", hasta: "2026-10-31" })).toBe("rango:2026-10-01:2026-10-31");
    expect(parsePeriodToken("rango:2026-10-01:2026-10-31")).toEqual({ period: "rango", desde: "2026-10-01", hasta: "2026-10-31" });
    expect(parsePeriodToken("rango:2026-10-01:mañana")).toBeNull();
    expect(parse("periodo=rango&desde=2026-10-14&hasta=2026-10-14&origen=javascript:alert(1)").origen).toBeNull();
  });

  it("migas: raíz › origen › período › cada filtro en orden; la última es la actual", () => {
    const f = withDimension(
      withDimension(drillToRange(parse("periodo=mes"), { from: "2026-10-14", to: "2026-10-14" }), "categoria", "c1"),
      "producto",
      "p1",
    );
    const crumbs = breadcrumbs(f);
    expect(crumbs.map((c) => c.kind)).toEqual(["root", "period", "period", "categoria", "producto"]);
    expect(crumbs.map((c) => c.href)).toEqual([
      "/operator/reports/ventas",
      "/operator/reports/ventas?periodo=mes",
      "/operator/reports/ventas?periodo=rango&desde=2026-10-14&hasta=2026-10-14&origen=mes",
      "/operator/reports/ventas?periodo=rango&desde=2026-10-14&hasta=2026-10-14&origen=mes&categoria=c1",
      "/operator/reports/ventas?periodo=rango&desde=2026-10-14&hasta=2026-10-14&origen=mes&categoria=c1&producto=p1",
    ]);
    expect(crumbs.filter((c) => c.current)).toHaveLength(1);
    expect(crumbs.at(-1)?.current).toBe(true);
  });
});
