import { describe, expect, it, vi } from "vitest";

// `requestTercero` resuelve el municipio con `@/lib/dian/emit`, que importa
// el cliente Prisma en el tope. Todo lo de acá es puro; se stubea para que
// el import no abra conexión.
vi.mock("@/lib/db", () => ({ db: {} }));

import { buildFormatoXml } from "./download";
import {
  aggregate1001,
  aggregate1005,
  aggregate1006,
  aggregate1007,
  aggregate1008,
  aggregate1009,
  aggregate1011,
  aggregate2276,
  billingCustomerTercero,
  buildExogenaReport,
  requestTercero,
  resolveTerceroDoc,
  supplierTercero,
  type ExogenaInputs,
  type Tercero,
} from "./sources";

const acme = { id: "s1", name: "ACME S.A.S.", taxId: "900.123.456-8", address: "Cra 1 # 2-3" };
const ana = { id: "s2", name: "Ana María Pérez Gómez", taxId: "1020304050", address: null };
const sinNit = { id: "s3", name: "Tienda de la esquina", taxId: null, address: null };
const conLetras = { id: "s4", name: "Proveedor raro", taxId: "ABC123", address: null };

const cliente: Tercero = {
  key: "cli:NIT:800111222", name: "Cliente Corp", docType: "NIT", docNumber: "800111222", dvGiven: null,
  kind: "juridica", dir: "Calle 9", dpto: "11", mun: "001", pais: "169", href: "/operator/facturas",
};

const empty: ExogenaInputs = {
  purchases: [], expenses: [], sales: [], receivables: [], payables: [], filings: [], payroll: [], shareholders: [], holdings: [],
};

describe("supplierTercero — el taxId libre del proveedor", () => {
  it("9 dígitos que empiezan por 8/9 ⇒ NIT jurídica; el '-DV' se separa y se valida", () => {
    const t = supplierTercero(acme);
    expect(t).toMatchObject({ docType: "NIT", docNumber: "900.123.456", dvGiven: "8", kind: "juridica", dir: "Cra 1 # 2-3" });
    expect(resolveTerceroDoc(t)).toEqual({ doc: { tdoc: "31", nid: "900123456", dv: "8" }, issue: null, warning: null });
  });

  it("una cédula ⇒ CC natural, sin DV", () => {
    const t = supplierTercero(ana);
    expect(t).toMatchObject({ docType: "CC", kind: "natural" });
    expect(resolveTerceroDoc(t).doc).toEqual({ tdoc: "13", nid: "1020304050", dv: "" });
  });

  it("DV escrito distinto del calculado ⇒ warning invalid_dv, pero el XML lleva el DV correcto", () => {
    const t = supplierTercero({ ...acme, taxId: "900123456-9" });
    const r = resolveTerceroDoc(t);
    expect(r.warning).toBe("invalid_dv");
    expect(r.doc?.dv).toBe("8");
  });

  it("sin documento ⇒ missing_doc; con letras ⇒ doc_not_numeric", () => {
    expect(resolveTerceroDoc(supplierTercero(sinNit)).issue).toBe("missing_doc");
    expect(resolveTerceroDoc(supplierTercero(conLetras)).issue).toBe("doc_not_numeric");
  });

  it("cliente sin tipo de documento ⇒ missing_doc_type", () => {
    expect(resolveTerceroDoc({ ...cliente, docType: null }).issue).toBe("missing_doc_type");
  });
});

describe("1001 — pagos por tercero y concepto", () => {
  it("compras: pago = neto, IVA en ided/inded, retenciones en retp/reta; concepto 5016; gastos por categoría", () => {
    const rows = aggregate1001({
      purchases: [
        { supplier: acme, netCents: 1_000_000, ivaCents: 190_000, indedCents: 40_000, retefuenteCents: 25_000, reteIvaCents: 0 },
        { supplier: acme, netCents: 500_000, ivaCents: 95_000, indedCents: 0, retefuenteCents: 0, reteIvaCents: 14_250 },
      ],
      expenses: [
        { supplier: acme, category: "Arriendo", amountCents: 3_000_000 },
        { supplier: ana, category: "Honorarios contador", amountCents: 800_000 },
      ],
    });
    expect(rows.map((r) => [r.tercero.name, r.concept, r.pagoCents, r.idedCents, r.indedCents, r.retpCents, r.retaCents])).toEqual([
      ["ACME S.A.S.", "5005", 3_000_000, 0, 0, 0, 0],
      ["ACME S.A.S.", "5016", 1_500_000, 245_000, 40_000, 25_000, 14_250],
      ["Ana María Pérez Gómez", "5002", 800_000, 0, 0, 0, 0],
    ]);
  });

  it("1005: sólo el IVA descontable, por proveedor", () => {
    const rows = aggregate1005([
      { supplier: acme, netCents: 1, ivaCents: 190_000, indedCents: 40_000, retefuenteCents: 0, reteIvaCents: 0 },
      { supplier: ana, netCents: 1, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vimpCents: 150_000, ivadeCents: 0 });
  });
});

describe("requestTercero / billingCustomerTercero — adquiriente sin dirección", () => {
  // Lo que guarda la solicitud de factura desde que no pide dirección,
  // ciudad ni departamento.
  const anaSinDireccion = {
    customerName: "Ana María Pérez Gómez",
    docType: "CC",
    docNumber: "1.020.304.050",
    address: null,
    city: null,
    department: null,
  };
  const acmeSinDireccion = {
    id: "bc1",
    customerName: "ACME S.A.S.",
    docType: "NIT",
    docNumber: "900123456",
    verificationDigit: "8",
    address: null,
    municipalityCode: null,
    country: "CO",
  };

  it("solicitud sin dirección: como un proveedor sin datos fiscales (dir vacía, dpto/mun 0, país Colombia)", () => {
    expect(requestTercero(anaSinDireccion)).toEqual({
      key: "cli:CC:1020304050",
      name: "Ana María Pérez Gómez",
      docType: "CC",
      docNumber: "1.020.304.050",
      dvGiven: null,
      kind: "natural",
      dir: "",
      dpto: "0",
      mun: "0",
      pais: "169",
      href: "/operator/facturas",
    });
    // Campos ausentes del todo (no sólo null) y cadenas vacías: lo mismo.
    const sinCampos = { customerName: "Ana María Pérez Gómez", docType: "CC", docNumber: "1.020.304.050" };
    expect(requestTercero(sinCampos)).toMatchObject({ dir: "", dpto: "0", mun: "0", pais: "169" });
    expect(requestTercero({ ...anaSinDireccion, address: "  ", city: "", department: "" })).toMatchObject({ dir: "", dpto: "0", mun: "0" });
  });

  it("solicitud vieja con dirección: sigue resolviendo el municipio DANE del texto libre", () => {
    expect(
      requestTercero({ ...anaSinDireccion, address: " Calle 1 # 2-3 ", city: "Envigado", department: "Antioquia" }),
    ).toMatchObject({ dir: "Calle 1 # 2-3", dpto: "05", mun: "266", pais: "169" });
  });

  it("cliente de facturación sin dirección ni municipio: dir vacía, dpto/mun 0, país de `country`", () => {
    expect(billingCustomerTercero(acmeSinDireccion)).toEqual({
      key: "bc:bc1",
      name: "ACME S.A.S.",
      docType: "NIT",
      docNumber: "900123456",
      dvGiven: "8",
      kind: "juridica",
      dir: "",
      dpto: "0",
      mun: "0",
      pais: "169",
      href: "/operator/clientes",
    });
    expect(billingCustomerTercero({ ...acmeSinDireccion, address: "Cra 1 # 2-3", municipalityCode: "05001" })).toMatchObject({ dir: "Cra 1 # 2-3", dpto: "05", mun: "001" });
    expect(billingCustomerTercero({ ...acmeSinDireccion, country: "US" })).toMatchObject({ pais: "0" });
  });

  it("1007 / 1006 / 1008: el nominativo sin dirección sale con los valores por defecto, sin incidencias", () => {
    const uvt = 1000;
    const report = buildExogenaReport({
      ...empty,
      sales: [{ customer: requestTercero(anaSinDireccion), baseCents: 100_000, ivaCents: 19_000, incCents: 0 }],
      receivables: [{ customer: billingCustomerTercero(acmeSinDireccion), saldoCents: 5_000_000 }],
    });
    expect(report.issues).toEqual([]);

    const r1007 = buildFormatoXml(report, "1007", 2025, uvt, { fecEnvio: "x" });
    if (!r1007.ok) throw new Error(r1007.error);
    expect(r1007.xml).toContain(
      '<ingresos cpt="4001" tdoc="13" nid="1020304050" apl1="Gómez" apl2="Pérez" nom1="Ana" nom2="María" raz="" pais="169" ibru="1000" dred="0"/>',
    );

    const r1006 = buildFormatoXml(report, "1006", 2025, uvt, { fecEnvio: "x" });
    if (!r1006.ok) throw new Error(r1006.error);
    expect(r1006.xml).toContain(
      '<impoventas tdoc="13" nid="1020304050" dv="" apl1="Gómez" apl2="Pérez" nom1="Ana" nom2="María" raz="" imp="190" iva="0" icon="0"/>',
    );

    // El 1008 es el único de estos que imprime la ubicación: dir vacía,
    // dpto/mun "0" y país 169, igual que un proveedor sin datos.
    const r1008 = buildFormatoXml(report, "1008", 2025, uvt, { fecEnvio: "x" });
    if (!r1008.ok) throw new Error(r1008.error);
    const saldo = (r1008.xml.match(/<saldoscc\b[^>]*>/g) ?? []).find((x) => x.includes('nid="900123456"'));
    expect(saldo).toContain('raz="ACME S.A.S." dir="" dpto="0" mun="0" pais="169"');
  });
});

describe("1006 / 1007 — ventas", () => {
  const sales = [
    { customer: null, baseCents: 100_000, ivaCents: 19_000, incCents: 0 },
    { customer: null, baseCents: 50_000, ivaCents: 0, incCents: 4_000 },
    { customer: cliente, baseCents: 200_000, ivaCents: 38_000, incCents: 0 },
    { customer: null, baseCents: 0, ivaCents: 0, incCents: 0 },
  ];

  it("1006: las ventas sin solicitud se agregan en consumidor final (222222222222 / 43)", () => {
    const rows = aggregate1006(sales);
    expect(rows.map((r) => [r.tercero.key, r.ivaCents, r.incCents])).toEqual([
      ["cli:NIT:800111222", 38_000, 0],
      ["cf", 19_000, 4_000],
    ]);
    expect(rows[1]!.tercero.docNumber).toBe("222222222222");
  });

  it("1007: ingreso base (sin impuesto) por adquiriente, concepto 4001", () => {
    const rows = aggregate1007(sales);
    expect(rows.map((r) => [r.tercero.key, r.concept, r.ibruCents])).toEqual([
      ["cli:NIT:800111222", "4001", 200_000],
      ["cf", "4001", 150_000],
    ]);
  });
});

describe("1008 / 1009 — saldos al 31/12", () => {
  it("1009: saldo = total bruto − abonos hasta el corte; el pagado no sale", () => {
    const rows = aggregate1009([
      { supplier: acme, totalCents: 1_190_000, paidCents: 190_000 },
      { supplier: acme, totalCents: 500_000, paidCents: 500_000 },
      { supplier: ana, totalCents: 300_000, paidCents: 100_000 },
    ]);
    expect(rows.map((r) => [r.tercero.name, r.saldoCents])).toEqual([
      ["ACME S.A.S.", 1_000_000],
      ["Ana María Pérez Gómez", 200_000],
    ]);
  });

  it("1008: agrega por cliente", () => {
    const rows = aggregate1008([
      { customer: cliente, saldoCents: 10_000 },
      { customer: cliente, saldoCents: 5_000 },
      { customer: { ...cliente, key: "bc:2", name: "Otro" }, saldoCents: 0 },
    ]);
    expect(rows).toEqual([{ tercero: cliente, saldoCents: 15_000 }]);
  });
});

describe("1011 — declaraciones del año", () => {
  it("agrupa por formulario; sólo ICA tiene concepto 1011, los demás quedan sin concepto", () => {
    const rows = aggregate1011([
      { form: "iva", declaredCents: 100 },
      { form: "iva", declaredCents: 200 },
      { form: "ica", declaredCents: 50 },
    ]);
    expect(rows).toEqual([
      { form: "ica", concept: "8214", valueCents: 50, count: 1 },
      { form: "iva", concept: null, valueCents: 300, count: 2 },
    ]);
  });
});

describe("2276 — rentas de trabajo por empleado", () => {
  it("salario, otros devengados, salud/pensión del empleado; ignora aportes del empleador y provisiones", () => {
    const item = (employeeId: string, conceptKey: string, kind: string, amountCents: number) => ({
      employeeId, employeeName: employeeId === "e1" ? "Luis" : "Marta", conceptKey, kind, amountCents,
    });
    const rows = aggregate2276([
      item("e1", "salario", "devengado", 1_400_000),
      item("e1", "recargos", "devengado", 100_000),
      item("e1", "aux_transporte", "devengado", 160_000),
      item("e1", "salud_empleado", "deduccion", 56_000),
      item("e1", "pension_empleado", "deduccion", 56_000),
      item("e1", "salud_empleador", "aporte_empleador", 119_000),
      item("e1", "cesantias", "provision", 116_000),
      item("e2", "salario", "devengado", 1_400_000),
      item("e2", "salud_empleado", "deduccion", 56_000),
    ]);
    expect(rows).toEqual([
      { employeeId: "e1", name: "Luis", salarioCents: 1_400_000, otrosCents: 260_000, saludCents: 56_000, pensionCents: 56_000, retefuenteCents: 0 },
      { employeeId: "e2", name: "Marta", salarioCents: 1_400_000, otrosCents: 0, saludCents: 56_000, pensionCents: 0, retefuenteCents: 0 },
    ]);
  });
});

describe("buildExogenaReport — incidencias", () => {
  it("terceros sin documento o no numérico bloquean; DV inválido avisa; consumidor final no genera incidencia", () => {
    const { issues, totals } = buildExogenaReport({
      ...empty,
      purchases: [
        { supplier: sinNit, netCents: 10_000, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
        { supplier: conLetras, netCents: 20_000, ivaCents: 3_800, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
        { supplier: { ...acme, taxId: "900123456-9" }, netCents: 30_000, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
      ],
      sales: [{ customer: null, baseCents: 1_000, ivaCents: 190, incCents: 0 }],
      filings: [{ form: "iva", declaredCents: 5 }],
      payroll: [{ employeeId: "e1", employeeName: "Luis", conceptKey: "salario", kind: "devengado", amountCents: 100 }],
    });
    // Las filas del formato van por monto desc, y las incidencias siguen ese orden.
    expect(issues.map((i) => [i.format, i.code, i.name, i.blocking])).toEqual([
      ["1001", "invalid_dv", "ACME S.A.S.", false],
      ["1001", "doc_not_numeric", "Proveedor raro", true],
      ["1001", "missing_doc", "Tienda de la esquina", true],
      ["1005", "doc_not_numeric", "Proveedor raro", true],
      ["1011", "missing_concept", "iva", false],
      ["2276", "employee_missing_doc", "Luis", false],
    ]);
    expect(issues[2]).toMatchObject({ amountCents: 10_000, href: "/operator/settings/proveedores" });
    expect(totals["1001"]).toBe(60_000);
    expect(totals["1006"]).toBe(190);
  });
});

describe("buildFormatoXml — reglas del archivo", () => {
  const uvt = 1000; // 3 UVT = $3.000 (300.000 centavos); 12 UVT = $12.000

  it("1001: cuantías menores por concepto (pagos del tercero < 3 UVT), salvo los sujetos a retención", () => {
    const report = buildExogenaReport({
      ...empty,
      purchases: [
        // ACME: 1.000.000 c = $10.000 ≥ 3 UVT → registro propio.
        { supplier: acme, netCents: 1_000_000, ivaCents: 190_000, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
        // Ana: $1.000 < 3 UVT y sin retención → cuantías menores.
        { supplier: ana, netCents: 100_000, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
        // Pequeño con retención → se reporta igual.
        { supplier: { id: "s5", name: "Pedro Pablo Paz", taxId: "80111222", address: null }, netCents: 50_000, ivaCents: 0, indedCents: 0, retefuenteCents: 1_000, reteIvaCents: 0 },
      ],
      expenses: [{ supplier: ana, category: "Arriendo", amountCents: 100_000 }],
    });
    const r = buildFormatoXml(report, "1001", 2025, uvt, { fecEnvio: "2026-01-01T00:00:00" });
    if (!r.ok) throw new Error(r.error);
    const pagos = r.xml.match(/<pagos\b[^>]*>/g) ?? [];
    // ACME + Pedro + dos cuantías menores (5016 y 5005): Ana suma $2.000 < $3.000.
    expect(pagos).toHaveLength(4);
    expect(pagos.find((p) => p.includes('nid="900123456"'))).toContain('pago="10000" pnded="0" ided="1900"');
    expect(pagos.find((p) => p.includes('nid="80111222"'))).toContain('retp="10"');
    const menores = pagos.filter((p) => p.includes('nid="222222222"'));
    expect(menores).toHaveLength(2);
    expect(menores.every((p) => p.includes('tdoc="43"') && p.includes('raz="CUANTÍAS MENORES"'))).toBe(true);
    expect(r.xml).not.toContain('nid="1020304050"');
    expect(r.filename).toBe("Dmuisca_010100111202600000001.xml");
    expect(r.xml).toContain("<ValorTotal>12500</ValorTotal>");
    expect(r.xml).toContain("<CantReg>4</CantReg>");
  });

  it("1008/1009: saldos < 12 UVT agregados en un registro NIT 222222222 tipo 43", () => {
    const report = buildExogenaReport({
      ...empty,
      payables: [
        { supplier: acme, totalCents: 5_000_000, paidCents: 0 }, // $50.000 ≥ 12 UVT
        { supplier: ana, totalCents: 500_000, paidCents: 0 }, // $5.000 < 12 UVT
      ],
    });
    const r = buildFormatoXml(report, "1009", 2025, uvt, { fecEnvio: "x" });
    if (!r.ok) throw new Error(r.error);
    const regs = r.xml.match(/<saldoscp\b[^>]*>/g) ?? [];
    expect(regs).toHaveLength(2);
    expect(regs[0]).toContain('cpt="2201" tdoc="31" nid="900123456" dv="8"');
    expect(regs[0]).toContain('raz="ACME S.A.S."');
    expect(regs[1]).toContain('tdoc="43" nid="222222222" dv="" apl1="" apl2="" nom1="" nom2="" raz="CUANTÍAS MENORES"');
    expect(regs[1]).toContain('sal="5000"');
  });

  it("1006: consumidor final agregado con 222222222222/43; persona natural con apl/nom; DV sólo para NIT", () => {
    const report = buildExogenaReport({
      ...empty,
      sales: [
        { customer: null, baseCents: 1, ivaCents: 190_000, incCents: 0 },
        { customer: { ...cliente, key: "c2", name: "Ana María Pérez Gómez", docType: "CC", docNumber: "1.020.304.050", kind: "natural" }, baseCents: 1, ivaCents: 0, incCents: 8_000 },
        { customer: cliente, baseCents: 1, ivaCents: 38_000, incCents: 0 },
      ],
    });
    const r = buildFormatoXml(report, "1006", 2025, uvt, { fecEnvio: "x" });
    if (!r.ok) throw new Error(r.error);
    const regs = r.xml.match(/<impoventas\b[^>]*>/g) ?? [];
    expect(regs).toHaveLength(3);
    expect(regs.find((x) => x.includes('nid="222222222222"'))).toContain('tdoc="43" nid="222222222222" dv="" apl1="" apl2="" nom1="" nom2="" raz="CONSUMIDOR FINAL" imp="1900" iva="0" icon="0"');
    expect(regs.find((x) => x.includes('nid="1020304050"'))).toContain('tdoc="13" nid="1020304050" dv="" apl1="Gómez" apl2="Pérez" nom1="Ana" nom2="María" raz=""');
    expect(regs.find((x) => x.includes('nid="800111222"'))).toContain('tdoc="31" nid="800111222" dv="7"');
  });

  it("con incidencias bloqueantes no hay archivo; el 2276 no tiene XML", () => {
    const report = buildExogenaReport({
      ...empty,
      purchases: [{ supplier: sinNit, netCents: 1, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 }],
    });
    expect(buildFormatoXml(report, "1001", 2025, uvt)).toEqual({ ok: false, error: "issues_pending" });
    // La incidencia es del 1001: el 1005 (sin filas) sí se arma, vacío.
    const r1005 = buildFormatoXml(report, "1005", 2025, uvt);
    expect(r1005.ok && r1005.records).toBe(0);
    expect(buildFormatoXml(report, "2276", 2025, uvt)).toEqual({ ok: false, error: "no_xml" });
  });

  it("1010 y 1012 desde la captura manual (porcentaje × 10^5, DV para NIT)", () => {
    const report = buildExogenaReport({
      ...empty,
      shareholders: [{ id: "a", name: "Juan Ruiz", docType: "CC", docNumber: "79000111", dv: null, sharePctBps: 5_000, nominalCents: 50_000_000_00, premiumCents: 0 }],
      holdings: [{ id: "b", concept: "1110", entityName: "Bancolombia S.A.", entityDocType: "NIT", entityDocNumber: "890903938", valueCents: 12_345_678_00 }],
    });
    const s = buildFormatoXml(report, "1010", 2025, uvt, { fecEnvio: "x" });
    if (!s.ok) throw new Error(s.error);
    expect(s.xml).toContain('<socios tdoc="13" nid="79000111" dv="" apl1="Ruiz" apl2="" nom1="Juan" nom2="" raz="" dir="" dpto="0" mun="0" pais="169" valnom="50000000" valprm="0" por="5000000" dec="5"/>');
    const h = buildFormatoXml(report, "1012", 2025, uvt, { fecEnvio: "x" });
    if (!h.ok) throw new Error(h.error);
    expect(h.xml).toContain('<dectri cpt="1110" tdoc="31" nid="890903938" dv="8" apl1="" apl2="" nom1="" nom2="" raz="Bancolombia S.A." pais="169" val="12345678"/>');
  });
});
