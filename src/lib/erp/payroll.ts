// Liquidación mensual de nómina — LÓGICA PURA, portada de zenith-erp
// (packages/domain/src/payroll.ts) y adaptada a MESAPAY:
//  - Montos en CENTAVOS en el borde (convención MESAPAY); internamente se
//    liquida a peso entero (la nómina COP no maneja centavos).
//  - Los RECARGOS festivo/dominical del mes (módulo Horarios) entran como
//    devengado salarial: son salario, así que amplían la base de deducciones,
//    aportes y prestaciones.
//  - Parametrizada por payrollParams del comercio: si cambia la ley, el dueño
//    ajusta valores/porcentajes en la UI y la fórmula sigue igual.
//
// El mapeo y los porcentajes los debe validar el contador del comercio.

export type PayrollKind =
  | "devengado"
  | "deduccion"
  | "aporte_empleador"
  | "provision";

export type PayrollConcept = {
  conceptKey: string;
  conceptLabel: string;
  kind: PayrollKind;
  amountCents: number;
};

export type PayrollLiquidation = {
  items: PayrollConcept[];
  totalDevengadoCents: number;
  totalDeduccionesCents: number;
  netoCents: number;
  /** Aportes patronales + provisiones (costo del empleador además del devengado). */
  totalEmpleadorCents: number;
};

/** Parámetros de nómina: { key: number } en unidades humanas (pesos / %). */
export type PayrollParams = Record<string, number>;

/** Catálogo default Colombia 2026 (fuente: zenith nomina_co_2026). */
export const PAYROLL_PARAMS_CO_2026: Array<{
  key: string;
  label: string;
  value: number;
  kind: "valor" | "porcentaje";
}> = [
  { key: "smmlv", label: "Salario mínimo (SMMLV)", value: 1750905, kind: "valor" },
  { key: "aux_transporte", label: "Auxilio de transporte", value: 249095, kind: "valor" },
  { key: "aux_transporte_tope_smmlv", label: "Tope del auxilio (en SMMLV)", value: 2, kind: "valor" },
  { key: "salud_empleado", label: "Salud empleado", value: 4, kind: "porcentaje" },
  { key: "pension_empleado", label: "Pensión empleado", value: 4, kind: "porcentaje" },
  { key: "salud_empleador", label: "Salud empleador", value: 8.5, kind: "porcentaje" },
  { key: "pension_empleador", label: "Pensión empleador", value: 12, kind: "porcentaje" },
  { key: "arl", label: "ARL", value: 0.522, kind: "porcentaje" },
  { key: "caja_compensacion", label: "Caja de compensación", value: 4, kind: "porcentaje" },
  { key: "icbf", label: "ICBF", value: 3, kind: "porcentaje" },
  { key: "sena", label: "SENA", value: 2, kind: "porcentaje" },
  { key: "cesantias", label: "Cesantías (provisión)", value: 8.33, kind: "porcentaje" },
  { key: "intereses_cesantias", label: "Intereses de cesantías (mensual)", value: 1, kind: "porcentaje" },
  { key: "prima", label: "Prima (provisión)", value: 8.33, kind: "porcentaje" },
  { key: "vacaciones", label: "Vacaciones (provisión)", value: 4.17, kind: "porcentaje" },
];

/** Defaults como objeto params. México aún sin localización → objeto vacío
 *  (la liquidación queda en salario + recargos, sin conceptos legales). */
export function defaultPayrollParams(country: string | null): PayrollParams {
  if (country === "MX") return {};
  return Object.fromEntries(PAYROLL_PARAMS_CO_2026.map((p) => [p.key, p.value]));
}

/**
 * Parámetro TOLERANTE: si falta o no es número válido se trata como 0 — el
 * concepto simplemente no se aplica (borrar un parámetro nunca rompe la
 * liquidación). Salvaguarda deliberada heredada de zenith.
 */
function opt(params: PayrollParams, key: string): number {
  const v = params[key];
  if (v === undefined || v === null || Number.isNaN(v)) return 0;
  return v;
}

/** Redondeo a peso entero (COP no maneja centavos en nómina). */
const peso = Math.round;

function totalize(rawItems: PayrollConcept[]): PayrollLiquidation {
  // Conceptos en cero se omiten (parámetro eliminado ⇒ no aparece como $0).
  const items = rawItems.filter((i) => i.amountCents !== 0);
  const sum = (kind: PayrollKind) =>
    items.filter((i) => i.kind === kind).reduce((s, i) => s + i.amountCents, 0);
  const totalDevengadoCents = sum("devengado");
  const totalDeduccionesCents = sum("deduccion");
  return {
    items,
    totalDevengadoCents,
    totalDeduccionesCents,
    netoCents: totalDevengadoCents - totalDeduccionesCents,
    totalEmpleadorCents: sum("aporte_empleador") + sum("provision"),
  };
}

/**
 * Colombia (mensual):
 * - Devengados: salario + recargos + auxilio de transporte si el salario
 *   básico ≤ tope×SMMLV (el tope se compara contra el salario, no recargos).
 * - Deducciones y aportes del empleador: base = salario + recargos (los
 *   recargos son salario; el auxilio NO cotiza).
 * - Provisiones: cesantías/prima sobre salario + recargos + auxilio (el
 *   auxilio SÍ es base de prestaciones); vacaciones sobre salario + recargos;
 *   intereses de cesantías = intereses_cesantias% de la provisión del mes.
 */
export function liquidateEmployeeCO(
  salaryCents: number,
  recargosCents: number,
  params: PayrollParams,
): PayrollLiquidation {
  // Trabajamos en pesos enteros y volvemos a centavos al final.
  const salary = peso(salaryCents / 100);
  const recargos = peso(recargosCents / 100);
  const smmlv = opt(params, "smmlv");
  const auxTope = opt(params, "aux_transporte_tope_smmlv") * smmlv;
  const aux = smmlv > 0 && salary <= auxTope ? peso(opt(params, "aux_transporte")) : 0;
  const baseCotizacion = salary + recargos; // deducciones + aportes
  const basePrestaciones = salary + recargos + aux; // cesantías/prima
  const pct = (base: number, key: string) => peso((base * opt(params, key)) / 100);
  const C = (p: number) => p * 100; // pesos → centavos

  const items: PayrollConcept[] = [
    { conceptKey: "salario", conceptLabel: "Salario", kind: "devengado", amountCents: C(salary) },
  ];
  if (recargos > 0) {
    items.push({
      conceptKey: "recargos",
      conceptLabel: "Recargos festivos y dominicales",
      kind: "devengado",
      amountCents: C(recargos),
    });
  }
  if (aux > 0) {
    items.push({
      conceptKey: "aux_transporte",
      conceptLabel: "Auxilio de transporte",
      kind: "devengado",
      amountCents: C(aux),
    });
  }

  items.push(
    { conceptKey: "salud_empleado", conceptLabel: "Salud empleado", kind: "deduccion", amountCents: C(pct(baseCotizacion, "salud_empleado")) },
    { conceptKey: "pension_empleado", conceptLabel: "Pensión empleado", kind: "deduccion", amountCents: C(pct(baseCotizacion, "pension_empleado")) },
    { conceptKey: "salud_empleador", conceptLabel: "Salud empleador", kind: "aporte_empleador", amountCents: C(pct(baseCotizacion, "salud_empleador")) },
    { conceptKey: "pension_empleador", conceptLabel: "Pensión empleador", kind: "aporte_empleador", amountCents: C(pct(baseCotizacion, "pension_empleador")) },
    { conceptKey: "arl", conceptLabel: "ARL", kind: "aporte_empleador", amountCents: C(pct(baseCotizacion, "arl")) },
    { conceptKey: "caja_compensacion", conceptLabel: "Caja de compensación", kind: "aporte_empleador", amountCents: C(pct(baseCotizacion, "caja_compensacion")) },
    { conceptKey: "icbf", conceptLabel: "ICBF", kind: "aporte_empleador", amountCents: C(pct(baseCotizacion, "icbf")) },
    { conceptKey: "sena", conceptLabel: "SENA", kind: "aporte_empleador", amountCents: C(pct(baseCotizacion, "sena")) },
  );

  const cesantias = pct(basePrestaciones, "cesantias");
  items.push(
    { conceptKey: "cesantias", conceptLabel: "Provisión cesantías", kind: "provision", amountCents: C(cesantias) },
    {
      conceptKey: "intereses_cesantias",
      conceptLabel: "Provisión intereses de cesantías",
      kind: "provision",
      amountCents: C(peso((cesantias * opt(params, "intereses_cesantias")) / 100)),
    },
    { conceptKey: "prima", conceptLabel: "Provisión prima", kind: "provision", amountCents: C(pct(basePrestaciones, "prima")) },
    { conceptKey: "vacaciones", conceptLabel: "Provisión vacaciones", kind: "provision", amountCents: C(pct(baseCotizacion, "vacaciones")) },
  );

  return totalize(items);
}
